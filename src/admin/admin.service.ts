import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { GATEWAY_ADAPTER, GatewayAdapter } from "../gateway/gateway-adapter";
import { randomId } from "../common/crypto";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
  ) {}

  createOrg(name: string) {
    return this.prisma.organization.create({ data: { name } });
  }

  async createEnrollCode(orgId: string, model = "", baseUrl?: string, ttlMinutes = 60, now = new Date()) {
    const ec = await this.prisma.enrollCode.create({
      data: { orgId, code: randomId("hara-", 9), model, baseUrl: baseUrl ?? null, expiresAt: new Date(now.getTime() + ttlMinutes * 60_000) },
    });
    await this.audit.log(orgId, "enroll_code.create", "admin", "", { model, ttlMinutes });
    return { code: ec.code, expiresAt: ec.expiresAt };
  }

  /** Read-only fleet view: who's online, version, token status, spend (joined from the gateway). */
  async fleet(orgId: string, now = new Date()) {
    const devices = await this.prisma.device.findMany({
      where: { orgId },
      include: { tokens: true },
      orderBy: { lastSeenAt: "desc" },
    });
    const activeKeyIds = devices.flatMap((d) => d.tokens.filter((t) => !t.revokedAt).map((t) => t.gatewayKeyId));
    const spend = new Map((await this.gateway.listSpend(activeKeyIds)).map((s) => [s.keyId, s.spend]));

    return devices.map((d) => {
      const active = d.tokens.find((t) => !t.revokedAt);
      return {
        device_id: d.id,
        name: d.name,
        os: d.os,
        hara_version: d.haraVersion,
        last_seen_at: d.lastSeenAt,
        online: now.getTime() - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
        token_active: Boolean(active),
        model: active?.model ?? "",
        spend: active ? spend.get(active.gatewayKeyId) ?? 0 : 0,
      };
    });
  }

  /** Revoke every live token for a device — at the gateway and in our registry. */
  async revokeDevice(deviceId: string, now = new Date()) {
    const tokens = await this.prisma.deviceToken.findMany({ where: { deviceId, revokedAt: null } });
    for (const t of tokens) {
      await this.gateway.revokeKey(t.gatewayKeyId).catch(() => undefined);
      await this.prisma.deviceToken.update({ where: { id: t.id }, data: { revokedAt: now } });
    }
    const dev = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (dev) await this.audit.log(dev.orgId, "revoke", "admin", deviceId, { tokens: tokens.length });
    return { revoked: tokens.length };
  }
}
