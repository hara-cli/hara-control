import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { GATEWAY_ADAPTER, GatewayAdapter } from "../gateway/gateway-adapter";
import { EntitlementService } from "../license/license.service";
import { sha256 } from "../common/crypto";
import { DeviceInfoDto } from "../protocol/dto";

@Injectable()
export class EnrollService {
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

    const dev = await this.prisma.device.create({
      data: {
        orgId: ec.orgId,
        name: device.name,
        os: device.os,
        haraVersion: device.hara_version,
        enrollCodeId: ec.id,
        personId: ec.personId ?? null, // per-person enroll: inherit this person's digital employees
      },
    });
    const issued = await this.gateway.issueKey({ model: ec.model, alias: dev.id, metadata: { orgId: ec.orgId } });
    await this.prisma.deviceToken.create({
      data: { deviceId: dev.id, tokenHash: sha256(issued.key), gatewayKeyId: issued.keyId, model: ec.model },
    });
    await this.prisma.enrollCode.update({ where: { id: ec.id }, data: { usedAt: now } });
    await this.audit.log(ec.orgId, "enroll", "device", dev.id, { name: device.name, os: device.os });

    return { device_token: issued.key, device_id: dev.id, model: ec.model, base_url: ec.baseUrl ?? undefined };
  }

  /** Keep a device shown as online + record its current version. Validates the bearer device token. */
  async heartbeat(bearer: string | undefined, body: { hara_version?: string; os?: string }, now = new Date()) {
    if (!bearer) throw new UnauthorizedException("missing token");
    const dt = await this.prisma.deviceToken.findUnique({ where: { tokenHash: sha256(bearer) } });
    if (!dt || dt.revokedAt) throw new UnauthorizedException("revoked or unknown token");
    await this.prisma.device.update({
      where: { id: dt.deviceId },
      data: {
        lastSeenAt: now,
        ...(body.hara_version ? { haraVersion: body.hara_version } : {}),
        ...(body.os ? { os: body.os } : {}),
      },
    });
  }
}
