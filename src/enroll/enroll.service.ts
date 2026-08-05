import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { GATEWAY_ADAPTER, GatewayAdapter, IssuedKey } from "../gateway/gateway-adapter";
import { EntitlementService } from "../license/license.service";
import { sha256 } from "../common/crypto";
import {
  assertTokenUsable,
  deviceTokenExpiry,
  deviceTokenTtlMinutes,
} from "../security/token-discipline";
import { DeviceInfoDto } from "../protocol/dto";
import {
  enrollmentManagedModels,
  managedKeyAuthorizationModels,
  managedModelsThinkingEfforts,
  resolveEnrollmentModel,
} from "../providers/model-policy";
import { Prisma } from "@prisma/client";
import {
  gatewayLimits,
  parseStoredAccessKeyPolicy,
} from "../gateway/key-policy";
import { DeskProvisioner } from "./desk-provisioner";

@Injectable()
export class EnrollService {
  private readonly log = new Logger(EnrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
    private readonly entitlement: EntitlementService,
    @Optional() private readonly deskProvisioner?: DeskProvisioner,
  ) {}

  /** Exchange a one-time code for a scoped device token (a gateway virtual key). */
  async enroll(code: string, device: DeviceInfoDto, now = new Date()) {
    const ec = await this.prisma.enrollCode.findUnique({ where: { code } });
    if (!ec || ec.usedAt || ec.expiresAt.getTime() < now.getTime()) {
      throw new UnauthorizedException("bad or expired code");
    }
    await this.entitlement.seatCheck(ec.orgId); // licensed seat cap
    const resolvedModel = resolveEnrollmentModel(ec.model);
    const availableModels = enrollmentManagedModels(resolvedModel);
    const accessPolicy = parseStoredAccessKeyPolicy(
      {
        tokenTtlMinutes: ec.tokenTtlMinutes,
        tokenNeverExpires: ec.tokenNeverExpires,
        budgetLimits: ec.budgetLimits,
        rpmLimit: ec.rpmLimit,
        tpmLimit: ec.tpmLimit,
      },
      deviceTokenTtlMinutes(),
    );

    // Claim the one-time code atomically before crossing the gateway boundary. A read followed by a
    // plain update allows two concurrent enroll requests to both issue valid device keys.
    const claim = await this.prisma.enrollCode.updateMany({
      where: {
        id: ec.id,
        usedAt: null,
        expiresAt: { gte: now },
      },
      data: { usedAt: now },
    });
    if (claim.count !== 1) {
      throw new UnauthorizedException("bad or expired code");
    }

    let dev: { id: string } | null = null;
    let issued: IssuedKey | null = null;
    let enrollmentAuditRecorded = false;
    try {
      dev = await this.prisma.device.create({
        data: {
          orgId: ec.orgId,
          name: device.name,
          os: device.os,
          haraVersion: device.hara_version,
          enrollCodeId: ec.id,
          personId: ec.personId ?? null, // per-person enroll: inherit this person's digital employees
        },
      });
      const requestedExpiry = accessPolicy.tokenNeverExpires
        ? null
        : deviceTokenExpiry(now, process.env, accessPolicy.tokenTtlMinutes ?? undefined);
      issued = await this.gateway.issueKey({
        model: resolvedModel,
        models: availableModels,
        alias: dev.id,
        expiresAt: requestedExpiry,
        metadata: { orgId: ec.orgId },
        limits: gatewayLimits(accessPolicy),
      });
      await this.prisma.deviceToken.create({
        // Use the gateway's authoritative expiry so control-plane and model data-plane access stop
        // at the same instant. The adapter rejects a missing or unexpectedly late expiry.
        data: {
          deviceId: dev.id,
          tokenHash: sha256(issued.key),
          gatewayKeyId: issued.keyId,
          model: resolvedModel,
          expiresAt: issued.expiresAt,
          budgetLimits: accessPolicy.budgetLimits as unknown as Prisma.InputJsonValue,
          rpmLimit: accessPolicy.rpmLimit,
          tpmLimit: accessPolicy.tpmLimit,
        },
      });
      await this.audit.log(ec.orgId, "enroll", "device", dev.id, {
        name: device.name,
        os: device.os,
        accessPolicy,
      });
      enrollmentAuditRecorded = true;
      // Desk is an optional organization service, but when configured it is part of this same
      // enrollment boundary. Control holds the shared Desk enrollment secret and returns only the
      // newly minted, separately scoped device bearer to the CLI.
      const person = ec.personId
        ? await this.prisma.person.findUnique({
            where: { id: ec.personId },
            select: { email: true },
          })
        : null;
      const desk = await this.deskProvisioner?.provision({
        orgId: ec.orgId,
        owner: person?.email || device.name,
        deviceName: device.name,
      });

      return {
        device_token: issued.key,
        device_id: dev.id,
        model: resolvedModel,
        available_models: availableModels,
        thinking_efforts: managedModelsThinkingEfforts(availableModels),
        base_url: ec.baseUrl ?? undefined,
        expires_at: issued.expiresAt?.toISOString() ?? null,
        access_policy: accessPolicy,
        ...(desk ? { desk } : {}),
      };
    } catch (error) {
      // External key issue + local writes cannot be one database transaction. Compensate every
      // completed boundary so an uncertain failure neither strands an alias nor consumes a code.
      let gatewayRevoked = !issued;
      let deviceRemoved = !dev;
      let codeRestored = false;
      if (issued) {
        try {
          await this.gateway.revokeKey(issued.keyId);
          gatewayRevoked = true;
        } catch (cleanupError) {
          this.log.error(
            `failed to compensate gateway key for device ${dev?.id ?? "uncreated"}: ${(cleanupError as Error).message}`,
          );
        }
      }
      if (dev) {
        try {
          await this.prisma.device.delete({ where: { id: dev.id } });
          deviceRemoved = true;
        } catch (cleanupError) {
          this.log.error(
            `failed to remove incomplete device ${dev.id}: ${(cleanupError as Error).message}`,
          );
        }
      }
      try {
        // Compare against our exact claim timestamp so cleanup cannot release a later claim.
        const restored = await this.prisma.enrollCode.updateMany({
          where: { id: ec.id, usedAt: now },
          data: { usedAt: null },
        });
        codeRestored = restored.count === 1;
      } catch (cleanupError) {
        this.log.error(
          `failed to restore enrollment code state for device ${dev?.id ?? "uncreated"}: ${(cleanupError as Error).message}`,
        );
      }
      if (enrollmentAuditRecorded) {
        try {
          // The original append-only event must remain, so record the rollback explicitly. Keep
          // this payload status-only: the originating error can contain an upstream secret.
          await this.audit.log(
            ec.orgId,
            "enroll.rollback",
            "system",
            dev?.id ?? "",
            { gatewayRevoked, deviceRemoved, codeRestored },
          );
        } catch (cleanupError) {
          this.log.error(
            `failed to audit enrollment rollback for device ${dev?.id ?? "uncreated"}: ${(cleanupError as Error).message}`,
          );
        }
      }
      throw error;
    }
  }

  /** Keep a device shown as online + record its current version. Validates the bearer device token. */
  async heartbeat(bearer: string | undefined, body: { hara_version?: string; os?: string }, now = new Date()) {
    if (!bearer) throw new UnauthorizedException("missing token");
    const dt = await this.prisma.deviceToken.findUnique({ where: { tokenHash: sha256(bearer) } });
    // central token discipline: revocation + short-TTL expiry + spend-cap hook (see token-discipline.ts)
    await assertTokenUsable(dt, { now });
    const resolvedModel = resolveEnrollmentModel(dt!.model);
    const availableModels = enrollmentManagedModels(resolvedModel);
    await this.gateway.syncKeyModels(
      dt!.gatewayKeyId,
      managedKeyAuthorizationModels(dt!.model, availableModels),
    );
    await this.prisma.device.update({
      where: { id: dt!.deviceId },
      data: {
        lastSeenAt: now,
        ...(body.hara_version ? { haraVersion: body.hara_version } : {}),
        ...(body.os ? { os: body.os } : {}),
      },
    });
    return {
      model: resolvedModel,
      available_models: availableModels,
      thinking_efforts: managedModelsThinkingEfforts(availableModels),
      expires_at: dt!.expiresAt?.toISOString(),
    };
  }
}
