import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
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
  managedModelThinkingEfforts,
  resolveEnrollmentModel,
} from "../providers/model-policy";
import { Prisma } from "@prisma/client";
import {
  gatewayLimits,
  parseStoredAccessKeyPolicy,
} from "../gateway/key-policy";

@Injectable()
export class EnrollService {
  private readonly log = new Logger(EnrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
    private readonly entitlement: EntitlementService,
  ) {}

  /** Exchange a one-time code for a scoped device token (a gateway virtual key). */
  async enroll(code: string, device: DeviceInfoDto, now = new Date()) {
    const ec = await this.prisma.enrollCode.findUnique({ where: { code } });
    if (!ec || ec.usedAt || ec.expiresAt.getTime() < now.getTime()) {
      throw new UnauthorizedException("bad or expired code");
    }
    await this.entitlement.seatCheck(ec.orgId); // licensed seat cap
    const resolvedModel = resolveEnrollmentModel(ec.model);
    const accessPolicy = parseStoredAccessKeyPolicy(
      {
        tokenTtlMinutes: ec.tokenTtlMinutes,
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
      const requestedExpiry = deviceTokenExpiry(now, process.env, accessPolicy.tokenTtlMinutes);
      issued = await this.gateway.issueKey({
        model: resolvedModel,
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

      return {
        device_token: issued.key,
        device_id: dev.id,
        model: resolvedModel,
        available_models: [resolvedModel],
        thinking_efforts: managedModelThinkingEfforts(resolvedModel),
        base_url: ec.baseUrl ?? undefined,
        expires_at: issued.expiresAt.toISOString(),
        access_policy: accessPolicy,
      };
    } catch (error) {
      // External key issue + local writes cannot be one database transaction. Compensate every
      // completed boundary so an uncertain failure neither strands an alias nor consumes a code.
      if (issued) {
        try {
          await this.gateway.revokeKey(issued.keyId);
        } catch (cleanupError) {
          this.log.error(
            `failed to compensate gateway key for device ${dev?.id ?? "uncreated"}: ${(cleanupError as Error).message}`,
          );
        }
      }
      if (dev) {
        try {
          await this.prisma.device.delete({ where: { id: dev.id } });
        } catch (cleanupError) {
          this.log.error(
            `failed to remove incomplete device ${dev.id}: ${(cleanupError as Error).message}`,
          );
        }
      }
      try {
        // Compare against our exact claim timestamp so cleanup cannot release a later claim.
        await this.prisma.enrollCode.updateMany({
          where: { id: ec.id, usedAt: now },
          data: { usedAt: null },
        });
      } catch (cleanupError) {
        this.log.error(
          `failed to restore enrollment code state for device ${dev?.id ?? "uncreated"}: ${(cleanupError as Error).message}`,
        );
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
    await this.prisma.device.update({
      where: { id: dt!.deviceId },
      data: {
        lastSeenAt: now,
        ...(body.hara_version ? { haraVersion: body.hara_version } : {}),
        ...(body.os ? { os: body.os } : {}),
      },
    });
  }
}
