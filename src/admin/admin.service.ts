import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { OrgUnitType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OrgTreeService } from "../org/org-tree.service";
import { GATEWAY_ADAPTER, GatewayAdapter } from "../gateway/gateway-adapter";
import { randomId } from "../common/crypto";
import { resolveEnrollmentModel } from "../providers/model-policy";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orgTree: OrgTreeService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
  ) {}

  /**
   * Create an org unit. Backward-compatible: with no `type`/`parentId` it makes a standalone COMPANY
   * root (the original `createOrg(name)` behaviour). Pass `type` + `parentId` to nest a child unit
   * (e.g. a DEPARTMENT under a COMPANY). Nesting is advisory — we validate the parent EXISTS but don't
   * hard-enforce the type ordering, keeping the model flexible to extend to a group later.
   */
  async createOrg(name: string, type: OrgUnitType = OrgUnitType.COMPANY, parentId?: string) {
    if (parentId) {
      const parent = await this.prisma.organization.findUnique({ where: { id: parentId } });
      if (!parent) throw new BadRequestException(`parent org "${parentId}" not found`);
    }
    const org = await this.prisma.organization.create({ data: { name, type, parentId: parentId ?? null } });
    // Audit under the unit's OWN id so a per-org chain exists from creation; record where it sits.
    await this.audit.log(org.id, "org.create", "admin", "", { name, type, parentId: parentId ?? null });
    return org;
  }

  /** The ancestor chain (leaf-first: [self … root]) — for an admin "where does this unit sit" view. */
  orgAncestors(orgId: string) {
    return this.orgTree.ancestors(orgId);
  }

  /** All unit ids in the subtree (incl. self) — e.g. "this company + all its departments". */
  orgSubtree(orgId: string) {
    return this.orgTree.descendants(orgId);
  }

  async createEnrollCode(orgId: string, model = "", baseUrl?: string, ttlMinutes = 60, personId?: string, now = new Date()) {
    let resolvedModel: string;
    try {
      resolvedModel = resolveEnrollmentModel(model);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const ec = await this.prisma.enrollCode.create({
      data: {
        orgId,
        code: randomId("hara-", 9),
        model: resolvedModel,
        baseUrl: baseUrl ?? null,
        personId: personId ?? null,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
      },
    });
    await this.audit.log(orgId, "enroll_code.create", "admin", "", {
      model: resolvedModel,
      ttlMinutes,
      personId,
    });
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

  /** Tamper-evidence check: recompute the org's audit hash chain and report the first break (if any). */
  verifyAudit(orgId: string) {
    return this.audit.verify(orgId);
  }
}
