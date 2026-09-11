import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
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
import { DeviceInfoDto, ProvisionDeskAgentDto } from "../protocol/dto";
import {
  enrollmentManagedModels,
  managedKeyAuthorizationModels,
  managedModelCapabilities,
  managedModelsThinkingEfforts,
  resolveEnrollmentModel,
} from "../providers/model-policy";
import { Prisma } from "@prisma/client";
import {
  gatewayLimits,
  parseStoredAccessKeyPolicy,
} from "../gateway/key-policy";
import {
  DeskProvisioner,
  DeskProvisioningFailure,
  type DeskProvisioningReceipt,
  type ProvisionedDeskBinding,
} from "./desk-provisioner";
import { TenantServiceBindingsService } from "../service-bindings/service-bindings.service";

@Injectable()
export class EnrollService {
  private readonly log = new Logger(EnrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
    private readonly entitlement: EntitlementService,
    @Optional() private readonly deskProvisioner?: DeskProvisioner,
    @Optional() private readonly serviceBindings?: TenantServiceBindingsService,
  ) {}

  /** Exchange a one-time code for a scoped device token (a gateway virtual key). */
  async enroll(code: string, device: DeviceInfoDto, now = new Date()) {
    const ec = await this.prisma.enrollCode.findUnique({ where: { code } });
    if (!ec || ec.usedAt || ec.expiresAt.getTime() < now.getTime()) {
      throw new UnauthorizedException("bad or expired code");
    }
    const [organization, enrollmentPerson] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: ec.orgId },
        select: { id: true, name: true },
      }),
      ec.personId
        ? this.prisma.person.findUnique({
            where: { id: ec.personId },
            select: { orgId: true, email: true },
          })
        : Promise.resolve(null),
    ]);
    // A valid enrollment code without an owning organization indicates damaged control-plane state.
    // Fail before claiming the one-time code so an operator can repair it without rotating the code.
    if (!organization) throw new UnauthorizedException("bad or expired code");
    if (!ec.personId || !enrollmentPerson || enrollmentPerson.orgId !== ec.orgId) {
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
    let deskReceipt: DeskProvisioningReceipt | undefined;
    let provisionedDesk: ProvisionedDeskBinding | undefined;
    let deskCleanupPrepared = false;
    const deskOwner = enrollmentPerson.email;
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
          reasoningEffort: ec.reasoningEffort,
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
      const serviceBindings = await this.serviceBindings?.activeForEnrollment(
        ec.orgId,
      ) ?? [];
      deskReceipt = await this.deskProvisioner?.provisionForEnrollment({
        orgId: ec.orgId,
        owner: deskOwner,
        deviceName: device.name,
        installationId: dev.id,
        platform: device.os || "unknown",
        version: device.hara_version || "unknown",
        clientKind: device.client_kind || "nanhara.hara-desktop",
      }, {
        controlReservation: { deviceId: dev.id, preparedAt: now },
        onPrepared: async () => {
          // The provisioner has already committed exact non-secret provenance under the same
          // advisory transaction lock used by Desk binding rotation/disable.
          deskCleanupPrepared = true;
        },
      });
      provisionedDesk = deskReceipt?.binding;
      if (provisionedDesk) {
        await this.prisma.device.update({
          where: { id: dev.id },
          data: {
            deskProvisionedAt: now,
            deskCleanupPendingAt: null,
            deskOwner,
            deskOrigin: provisionedDesk.url,
          },
        });
      }

      const result = {
        device_token: issued.key,
        device_id: dev.id,
        tenant_id: organization.id,
        tenant_name: organization.name
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80) || organization.id,
        model: resolvedModel,
        available_models: availableModels,
        model_capabilities: managedModelCapabilities(availableModels).map((capability) => ({
          model: capability.model,
          thinking_efforts: capability.thinkingEfforts,
        })),
        thinking_efforts: managedModelsThinkingEfforts(availableModels),
        default_reasoning_effort: ec.reasoningEffort || null,
        base_url: ec.baseUrl ?? undefined,
        expires_at: issued.expiresAt?.toISOString() ?? null,
        access_policy: accessPolicy,
        ...(serviceBindings.length > 0
          ? { service_bindings: serviceBindings }
          : {}),
        ...(provisionedDesk ? { desk: provisionedDesk } : {}),
      };
      // Local device, token and Desk provenance are now committed. The captured Control-only
      // enrollment credential is no longer needed and must not survive the request lifetime.
      deskReceipt?.release();
      deskReceipt = undefined;
      return result;
    } catch (error) {
      // External key issue + local writes cannot be one database transaction. Compensate every
      // completed boundary so an uncertain failure neither strands an alias nor consumes a code.
      let gatewayRevoked = !issued;
      let deskRevoked = !deskReceipt
        && (!(error instanceof DeskProvisioningFailure) || error.compensationConfirmed);
      let deviceRemoved = !dev;
      let codeRestored = false;
      let deskCleanupPending = deskCleanupPrepared && !deskRevoked;
      if (
        dev
        && error instanceof DeskProvisioningFailure
        && !error.compensationConfirmed
        && !deskCleanupPrepared
      ) {
        try {
          // The initial /register may have committed even though neither its response nor the
          // compensating revoke was observable. Persist the exact non-secret cleanup provenance
          // before returning failure. It blocks binding rotation and makes admin revocation safely
          // retry the original Desk; no Agent bearer or enrollment secret is stored here.
          await this.prisma.device.update({
            where: { id: dev.id },
            data: {
              deskProvisionedAt: null,
              deskCleanupPendingAt: now,
              deskOwner,
              deskOrigin: error.targetUrl,
            },
          });
          deskCleanupPending = true;
        } catch (cleanupError) {
          this.log.error(
            `failed to persist pending Desk cleanup for device ${dev.id}: ${(cleanupError as Error).message}`,
          );
        }
      }
      if (deskReceipt) {
        try {
          // The receipt freezes the exact Desk origin and Control-only credential used for the
          // registration request. Never re-resolve a mutable organization binding here.
          await deskReceipt.compensate();
          deskRevoked = true;
        } catch (cleanupError) {
          this.log.error(
            `failed to compensate Desk installation for device ${dev?.id ?? "uncreated"}: ${(cleanupError as Error).message}`,
          );
        }
      }
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
      if (dev && gatewayRevoked && deskRevoked) {
        try {
          await this.prisma.device.delete({ where: { id: dev.id } });
          deviceRemoved = true;
        } catch (cleanupError) {
          this.log.error(
            `failed to remove incomplete device ${dev.id}: ${(cleanupError as Error).message}`,
          );
        }
      }
      if (gatewayRevoked && deskRevoked && deviceRemoved) {
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
            { gatewayRevoked, deskRevoked, deskCleanupPending, deviceRemoved, codeRestored },
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

  /** Mint or rotate one separately scoped Desk Agent credential for an already enrolled device.
   * The device token proves User+Device membership; Control retains the organization enrollment
   * secret and Desk deterministically maps client+instance retries to the same Agent identity. */
  async provisionDeskAgent(
    bearer: string | undefined,
    input: ProvisionDeskAgentDto,
  ) {
    if (!bearer) throw new UnauthorizedException("missing token");
    const deviceToken = await this.prisma.deviceToken.findUnique({
      where: { tokenHash: sha256(bearer) },
      include: {
        device: {
          include: { person: { select: { email: true } } },
        },
      },
    });
    await assertTokenUsable(deviceToken);
    const device = deviceToken!.device;
    if (
      !device.deskProvisionedAt
      || !device.deskOwner
      || !device.deskOrigin
      || !this.deskProvisioner
    ) {
      throw new ServiceUnavailableException(
        "Hara Desk is not provisioned for this organization device",
      );
    }
    const instanceId = input.instance_id?.trim() || "default";
    if (
      instanceId !== instanceId.toLowerCase()
      || instanceId.length > 80
      || !/^[a-z0-9][a-z0-9._-]*$/.test(instanceId)
    ) {
      throw new BadRequestException(
        "Desk Agent instance must use 1-80 lowercase letters, numbers, dots, underscores, or dashes",
      );
    }
    const provisioned = await this.deskProvisioner.provision({
      orgId: device.orgId,
      owner: device.deskOwner,
      deviceName: device.name,
      installationId: device.id,
      platform: device.os || "unknown",
      version: device.haraVersion || "unknown",
      clientKind: input.client_kind,
      instanceId,
      agentName: input.name?.trim() || `${input.client_kind} · ${device.name}`,
      expectedUrl: device.deskOrigin,
    });
    if (!provisioned) {
      throw new ServiceUnavailableException(
        "Hara Desk provisioning is unavailable for this organization",
      );
    }
    // A remote registration can race administrator revocation. Re-check the exact local bearer and
    // installation after the network call so a late response is never presented as an active Agent
    // credential after its Control device has already been revoked or detached from this Desk.
    const currentDeviceToken = await this.prisma.deviceToken.findUnique({
      where: { tokenHash: sha256(bearer) },
      include: { device: true },
    });
    await assertTokenUsable(currentDeviceToken);
    const currentDevice = currentDeviceToken!.device;
    if (
      currentDevice.id !== device.id
      || !currentDevice.deskProvisionedAt
      || currentDevice.deskOwner !== device.deskOwner
      || currentDevice.deskOrigin !== device.deskOrigin
    ) {
      throw new ServiceUnavailableException(
        "Hara Desk installation changed while the Agent credential was being provisioned",
      );
    }
    return {
      desk: provisioned,
      client_kind: input.client_kind,
      instance_id: instanceId,
    };
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
      model_capabilities: managedModelCapabilities(availableModels).map((capability) => ({
        model: capability.model,
        thinking_efforts: capability.thinkingEfforts,
      })),
      thinking_efforts: managedModelsThinkingEfforts(availableModels),
      default_reasoning_effort: dt!.reasoningEffort || null,
      expires_at: dt!.expiresAt?.toISOString(),
    };
  }
}
