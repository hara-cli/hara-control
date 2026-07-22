import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { OrgUnitType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OrgTreeService } from "../org/org-tree.service";
import { GATEWAY_ADAPTER, GatewayAdapter } from "../gateway/gateway-adapter";
import { randomId } from "../common/crypto";
import { resolveEnrollmentModel } from "../providers/model-policy";
import { deviceTokenTtlMinutes } from "../security/token-discipline";
import {
  ACCESS_BUDGET_WINDOWS,
  AccessBudgetWindow,
  AccessKeyPolicyInput,
  normalizeAccessKeyPolicy,
  StoredAccessKeyPolicy,
} from "../gateway/key-policy";
import { parseUsageRange, usageWindow } from "../gateway/usage";
import { assertAdminOrgAccess, AuthedUser } from "../common/admin-auth.guard";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orgTree: OrgTreeService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
  ) {}

  listOrgs(orgId?: string | null) {
    return this.prisma.organization.findMany({
      where: orgId ? { id: orgId } : undefined,
      select: { id: true, name: true, type: true, parentId: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });
  }

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

  async createEnrollCode(
    orgId: string,
    model = "",
    baseUrl?: string,
    ttlMinutes = 60,
    personId?: string,
    keyPolicy: AccessKeyPolicyInput = {},
    now = new Date(),
  ) {
    let resolvedModel: string;
    let accessPolicy: StoredAccessKeyPolicy;
    try {
      resolvedModel = resolveEnrollmentModel(model);
      accessPolicy = normalizeAccessKeyPolicy(keyPolicy, deviceTokenTtlMinutes());
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
        tokenTtlMinutes: accessPolicy.tokenTtlMinutes,
        budgetLimits: accessPolicy.budgetLimits as unknown as Prisma.InputJsonValue,
        rpmLimit: accessPolicy.rpmLimit,
        tpmLimit: accessPolicy.tpmLimit,
      },
    });
    await this.audit.log(orgId, "enroll_code.create", "admin", "", {
      model: resolvedModel,
      ttlMinutes,
      personId,
      accessPolicy,
    });
    return { code: ec.code, expiresAt: ec.expiresAt, accessPolicy };
  }

  /** Read-only fleet view: who's online, version, token status, spend (joined from the gateway). */
  async fleet(orgId: string, now = new Date()) {
    const devices = await this.prisma.device.findMany({
      where: { orgId },
      include: { tokens: true },
      orderBy: { lastSeenAt: "desc" },
    });
    const tokenIsActive = (token: (typeof devices)[number]["tokens"][number]) =>
      !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > now.getTime());
    const activeKeyIds = devices.flatMap((d) => d.tokens.filter(tokenIsActive).map((t) => t.gatewayKeyId));
    const spend = new Map((await this.gateway.listSpend(activeKeyIds)).map((s) => [s.keyId, s.spend]));

    return devices.map((d) => {
      const active = d.tokens.find(tokenIsActive);
      return {
        device_id: d.id,
        name: d.name,
        os: d.os,
        hara_version: d.haraVersion,
        last_seen_at: d.lastSeenAt,
        online: now.getTime() - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
        token_active: Boolean(active),
        model: active?.model ?? "",
        spend: active ? (spend.get(active.gatewayKeyId) ?? null) : null,
        spend_available: active ? spend.get(active.gatewayKeyId) != null : false,
        expires_at: active?.expiresAt ?? null,
        budget_limits: active?.budgetLimits ?? [],
        rpm_limit: active?.rpmLimit ?? null,
        tpm_limit: active?.tpmLimit ?? null,
      };
    });
  }

  async usage(orgId: string, requestedRange?: string, now = new Date()) {
    if (!orgId) throw new BadRequestException("orgId is required");
    let range;
    try {
      range = parseUsageRange(requestedRange);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const window = usageWindow(range, now);
    const devices = await this.prisma.device.findMany({
      where: { orgId },
      include: {
        person: { select: { name: true, email: true } },
        tokens: {
          select: {
            gatewayKeyId: true,
            model: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            budgetLimits: true,
            rpmLimit: true,
            tpmLimit: true,
          },
        },
      },
      orderBy: { lastSeenAt: "desc" },
    });
    const keyMeta = new Map<string, {
      deviceId: string;
      deviceName: string;
      principal: string;
      model: string;
    }>();
    for (const device of devices) {
      const principal = device.person?.name || device.person?.email || device.name;
      for (const token of device.tokens) {
        keyMeta.set(token.gatewayKeyId, {
          deviceId: device.id,
          deviceName: device.name,
          principal,
          model: token.model,
        });
      }
    }
    const gatewayUsage = await this.gateway.usage([...keyMeta.keys()], range, now);
    const series = Array.from({ length: window.bucketCount }, (_, index) => ({
      at: new Date(window.from.getTime() + index * window.bucketMs),
      spend: 0,
      totalTokens: 0,
      requests: 0,
    }));
    const breakdown = new Map<string, {
      deviceId: string;
      deviceName: string;
      principal: string;
      model: string;
      spend: number;
      totalTokens: number;
      requests: number;
      lastRequestAt: Date;
    }>();
    let totalSpend = 0;
    let totalTokens = 0;
    let requests = 0;
    let latestRequestAt: Date | null = null;
    if (gatewayUsage.available) {
      for (const entry of gatewayUsage.buckets) {
        const meta = keyMeta.get(entry.keyId);
        if (!meta) continue;
        const bucketIndex = Math.round((entry.bucketAt.getTime() - window.from.getTime()) / window.bucketMs);
        if (bucketIndex >= 0 && bucketIndex < series.length) {
          series[bucketIndex].spend += entry.spend;
          series[bucketIndex].totalTokens += entry.totalTokens;
          series[bucketIndex].requests += entry.requests;
        }
        totalSpend += entry.spend;
        totalTokens += entry.totalTokens;
        requests += entry.requests;
        if (!latestRequestAt || entry.lastRequestAt > latestRequestAt) latestRequestAt = entry.lastRequestAt;
        const model = meta.model || entry.model || "";
        const breakdownKey = `${meta.deviceId}\u0000${model}`;
        const existing = breakdown.get(breakdownKey) ?? {
          ...meta,
          model,
          spend: 0,
          totalTokens: 0,
          requests: 0,
          lastRequestAt: entry.lastRequestAt,
        };
        existing.spend += entry.spend;
        existing.totalTokens += entry.totalTokens;
        existing.requests += entry.requests;
        if (entry.lastRequestAt > existing.lastRequestAt) existing.lastRequestAt = entry.lastRequestAt;
        breakdown.set(breakdownKey, existing);
      }
    }

    const rolling = new Map(gatewayUsage.rolling.map((entry) => [entry.keyId, entry]));
    const rollingField: Record<AccessBudgetWindow, "spend5h" | "spend7d" | "spend30d"> = {
      "5h": "spend5h",
      week: "spend7d",
      month: "spend30d",
    };
    const quotas = devices.flatMap((device) => device.tokens.flatMap((token) => {
      const active = !token.revokedAt && (!token.expiresAt || token.expiresAt > now);
      if (!active) return [];
      const rawLimits = Array.isArray(token.budgetLimits) ? token.budgetLimits : [];
      const limits = rawLimits.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        const budgetWindow = row.window as AccessBudgetWindow;
        const maxUsd = Number(row.maxUsd);
        if (!ACCESS_BUDGET_WINDOWS.includes(budgetWindow) || !Number.isFinite(maxUsd) || maxUsd <= 0) return [];
        const usage = rolling.get(token.gatewayKeyId);
        const usedUsd = gatewayUsage.available ? (usage?.[rollingField[budgetWindow]] ?? 0) : null;
        return [{
          window: budgetWindow,
          maxUsd,
          usedUsd,
          remainingUsd: usedUsd == null ? null : Math.max(0, maxUsd - usedUsd),
          percent: usedUsd == null ? null : (usedUsd / maxUsd) * 100,
        }];
      });
      if (!limits.length && token.rpmLimit == null && token.tpmLimit == null) return [];
      return [{
        deviceId: device.id,
        deviceName: device.name,
        principal: device.person?.name || device.person?.email || device.name,
        model: token.model,
        expiresAt: token.expiresAt,
        rpmLimit: token.rpmLimit,
        tpmLimit: token.tpmLimit,
        limits,
      }];
    }));

    return {
      orgId,
      range,
      from: window.from,
      to: window.to,
      available: gatewayUsage.available,
      totals: gatewayUsage.available
        ? { spend: totalSpend, totalTokens, requests, latestRequestAt }
        : { spend: null, totalTokens: null, requests: null, latestRequestAt: null },
      series: gatewayUsage.available ? series : [],
      breakdown: gatewayUsage.available
        ? [...breakdown.values()].sort((a, b) => b.spend - a.spend || b.totalTokens - a.totalTokens)
        : [],
      quotas,
    };
  }

  /** Revoke every live token for a device — at the gateway and in our registry. */
  async revokeDevice(deviceId: string, user?: AuthedUser, now = new Date()) {
    const dev = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!dev) return { revoked: 0 };
    if (user) assertAdminOrgAccess(user, dev.orgId);
    const tokens = await this.prisma.deviceToken.findMany({ where: { deviceId, revokedAt: null } });
    for (const t of tokens) {
      await this.gateway.revokeKey(t.gatewayKeyId).catch(() => undefined);
      await this.prisma.deviceToken.update({ where: { id: t.id }, data: { revokedAt: now } });
    }
    await this.audit.log(dev.orgId, "revoke", "admin", deviceId, { tokens: tokens.length });
    return { revoked: tokens.length };
  }

  /** Tamper-evidence check: recompute the org's audit hash chain and report the first break (if any). */
  verifyAudit(orgId: string) {
    return this.audit.verify(orgId);
  }
}
