import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AdminRole, OrgUnitType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OrgTreeService } from "../org/org-tree.service";
import { GATEWAY_ADAPTER, GatewayAdapter } from "../gateway/gateway-adapter";
import { randomId } from "../common/crypto";
import {
  enrollmentManagedModels,
  managedModelsForRecordedToken,
  resolveEnrollmentModel,
  resolveEnrollmentReasoningEffort,
} from "../providers/model-policy";
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

  listOrgs(orgId: string | null, global = false) {
    if (!global && !orgId) throw new ForbiddenException("organization access denied");
    return this.prisma.organization.findMany({
      where: global ? undefined : { id: orgId! },
      select: { id: true, name: true, type: true, parentId: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });
  }

  private isGlobalOperator(actor: AuthedUser): boolean {
    return actor.viaSharedKey === true || actor.role === AdminRole.SUPERADMIN;
  }

  /** Tenant admins may operate on their assigned company and units below it, never on another tree. */
  private async assertOrgTreeAccess(actor: AuthedUser, targetOrgId: string): Promise<void> {
    if (this.isGlobalOperator(actor)) return;
    if (!actor.orgId) throw new ForbiddenException("organization access denied");
    const ancestors = await this.orgTree.ancestors(targetOrgId);
    if (!ancestors.some((org) => org.id === actor.orgId)) {
      throw new ForbiddenException("organization access denied");
    }
  }

  /**
   * Create an org unit. Backward-compatible: with no `type`/`parentId` it makes a standalone COMPANY
   * root (the original `createOrg(name)` behaviour). Pass `type` + `parentId` to nest a child unit
   * (e.g. a DEPARTMENT under a COMPANY). Nesting is advisory — we validate the parent EXISTS but don't
   * hard-enforce the type ordering, keeping the model flexible to extend to a group later.
   */
  async createOrg(
    name: string,
    actor: AuthedUser,
    type: OrgUnitType = OrgUnitType.COMPANY,
    parentId?: string,
  ) {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80 || /[\u0000-\u001f\u007f]/.test(normalizedName)) {
      throw new BadRequestException("organization name must be 1-80 printable characters");
    }
    if (!parentId && !this.isGlobalOperator(actor)) {
      throw new ForbiddenException("creating a root company requires SUPERADMIN");
    }
    if (parentId) await this.assertOrgTreeAccess(actor, parentId);
    return this.audit.transact(
      "org.create",
      actor.viaSharedKey ? "shared-key" : "admin",
      actor.id,
      async (tx) => {
        if (parentId) {
          const parent = await tx.organization.findUnique({ where: { id: parentId } });
          if (!parent) throw new BadRequestException(`parent org "${parentId}" not found`);
        }
        const org = await tx.organization.create({ data: { name: normalizedName, type, parentId: parentId ?? null } });
        // Audit under the unit's OWN id so a per-org chain exists from creation; record where it sits.
        return {
          result: org,
          orgId: org.id,
          payload: { name: normalizedName, type, parentId: parentId ?? null },
        };
      },
    );
  }

  /** The ancestor chain (leaf-first: [self … root]) — for an admin "where does this unit sit" view. */
  async orgAncestors(orgId: string, actor: AuthedUser) {
    await this.assertOrgTreeAccess(actor, orgId);
    return this.orgTree.ancestors(orgId);
  }

  /** All unit ids in the subtree (incl. self) — e.g. "this company + all its departments". */
  async orgSubtree(orgId: string, actor: AuthedUser) {
    await this.assertOrgTreeAccess(actor, orgId);
    return this.orgTree.descendants(orgId);
  }

  async createEnrollCode(
    orgId: string,
    model: string,
    baseUrl: string | undefined,
    ttlMinutes: number,
    personId: string,
    actor: AuthedUser,
    options: AccessKeyPolicyInput & { reasoningEffort?: string } = {},
    now = new Date(),
  ) {
    if (!actor?.id) throw new BadRequestException("authenticated audit actor is required");
    let resolvedModel: string;
    let reasoningEffort: string;
    let accessPolicy: StoredAccessKeyPolicy;
    try {
      resolvedModel = resolveEnrollmentModel(model);
      reasoningEffort = resolveEnrollmentReasoningEffort(options.reasoningEffort, resolvedModel);
      accessPolicy = normalizeAccessKeyPolicy(options, deviceTokenTtlMinutes());
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const models = enrollmentManagedModels(resolvedModel);
    return this.audit.transact(
      "enroll_code.create",
      actor.viaSharedKey ? "shared-key" : "admin",
      actor.id,
      async (tx) => {
        if (!personId) throw new BadRequestException("personId is required for company key accountability");
        const person = await tx.person.findUnique({
          where: { id: personId },
          select: { orgId: true },
        });
        if (!person) throw new BadRequestException("person not found");
        if (person.orgId !== orgId) {
          throw new BadRequestException("enrollment person must belong to the same organization");
        }
        const ec = await tx.enrollCode.create({
          data: {
            orgId,
            code: randomId("hara-", 9),
            model: resolvedModel,
            reasoningEffort,
            baseUrl: baseUrl ?? null,
            personId,
            expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
            tokenTtlMinutes: accessPolicy.tokenTtlMinutes,
            tokenNeverExpires: accessPolicy.tokenNeverExpires,
            budgetLimits: accessPolicy.budgetLimits as unknown as Prisma.InputJsonValue,
            rpmLimit: accessPolicy.rpmLimit,
            tpmLimit: accessPolicy.tpmLimit,
          },
        });
        return {
          result: {
            code: ec.code,
            model: resolvedModel,
            reasoningEffort,
            models,
            expiresAt: ec.expiresAt,
            accessPolicy,
          },
          orgId,
          payload: { model: resolvedModel, reasoningEffort, models, ttlMinutes, personId, accessPolicy },
        };
      },
    );
  }

  /** Read-only fleet view: who's online, version, token status, spend (joined from the gateway). */
  async fleet(orgId: string, now = new Date()) {
    const devices = await this.prisma.device.findMany({
      where: { orgId },
      include: {
        person: { select: { id: true, name: true, email: true } },
        tokens: { orderBy: { createdAt: "desc" } },
      },
      orderBy: { lastSeenAt: "desc" },
    });
    const tokenIsActive = (token: (typeof devices)[number]["tokens"][number]) =>
      !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > now.getTime());
    const keyIds = devices.flatMap((d) => d.tokens.map((t) => t.gatewayKeyId));
    const spend = new Map((await this.gateway.listSpend(keyIds)).map((s) => [s.keyId, s.spend]));

    return devices.map((d) => {
      const active = d.tokens.find(tokenIsActive);
      const current = active ?? d.tokens[0];
      const availableModels = active ? managedModelsForRecordedToken(active.model) : [];
      const keySpend = d.tokens.map((token) => spend.get(token.gatewayKeyId) ?? null);
      const spendAvailable = keySpend.length > 0 && keySpend.every((value) => value != null);
      return {
        device_id: d.id,
        name: d.name,
        person_id: d.person?.id ?? null,
        person_name: d.person?.name || d.person?.email || null,
        person_email: d.person?.email ?? null,
        os: d.os,
        hara_version: d.haraVersion,
        last_seen_at: d.lastSeenAt,
        online: now.getTime() - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
        token_active: Boolean(active),
        model: current?.model ?? "",
        model_policy_status: active ? (availableModels.length ? "active" : "retired") : "historical",
        reasoning_effort: current?.reasoningEffort || null,
        available_models: availableModels,
        // Device-level spend is the sum of every historical key, including revoked keys. A missing
        // ledger value makes the aggregate unavailable rather than silently understating it.
        spend: spendAvailable ? keySpend.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
        spend_available: spendAvailable,
        expires_at: current?.expiresAt ?? null,
        budget_limits: current?.budgetLimits ?? [],
        rpm_limit: current?.rpmLimit ?? null,
        tpm_limit: current?.tpmLimit ?? null,
        keys: d.tokens.map((token) => ({
          key_id: token.gatewayKeyId,
          model: token.model,
          reasoning_effort: token.reasoningEffort || null,
          status: token.revokedAt
            ? "revoked"
            : token.expiresAt && token.expiresAt.getTime() <= now.getTime()
              ? "expired"
              : "active",
          created_at: token.createdAt,
          expires_at: token.expiresAt,
          revoked_at: token.revokedAt,
          spend: spend.get(token.gatewayKeyId) ?? null,
          spend_available: spend.get(token.gatewayKeyId) != null,
          budget_limits: token.budgetLimits,
          rpm_limit: token.rpmLimit,
          tpm_limit: token.tpmLimit,
        })),
      };
    });
  }

  /** Bind one legacy unassigned device to an accountable person exactly once. Existing bindings are
   * immutable: correcting a wrong identity requires revoking and issuing a new person-bound key. */
  async bindDevicePerson(deviceId: string, personId: string, actor: AuthedUser) {
    const [device, person] = await Promise.all([
      this.prisma.device.findUnique({
        where: { id: deviceId },
        select: { id: true, orgId: true, personId: true, enrollCodeId: true },
      }),
      this.prisma.person.findUnique({
        where: { id: personId },
        select: { id: true, orgId: true, name: true, email: true },
      }),
    ]);
    if (!device) throw new NotFoundException("device not found");
    assertAdminOrgAccess(actor, device.orgId);
    if (!person) throw new NotFoundException("person not found");
    if (person.orgId !== device.orgId) throw new BadRequestException("person and device must belong to the same organization");
    if (device.personId && device.personId !== personId) {
      throw new BadRequestException("device identity is already bound; revoke and re-enroll to change people");
    }
    if (device.personId === personId) return { deviceId, person };

    return this.audit.transact(
      "device.person.bind",
      actor.viaSharedKey ? "shared-key" : "admin",
      actor.id,
      async (tx) => {
        const updated = await tx.device.updateMany({
          where: { id: deviceId, orgId: device.orgId, personId: null },
          data: { personId },
        });
        if (updated.count !== 1) throw new BadRequestException("device identity was bound concurrently; refresh and retry");
        if (device.enrollCodeId) {
          await tx.enrollCode.updateMany({
            where: { id: device.enrollCodeId, orgId: device.orgId, personId: null },
            data: { personId },
          });
        }
        return {
          result: { deviceId, person },
          orgId: device.orgId,
          payload: { deviceId, personId },
        };
      },
    );
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
        const model = entry.model || meta.model || "";
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
        availableModels: managedModelsForRecordedToken(token.model),
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
  async revokeDevice(deviceId: string, user: AuthedUser, now = new Date()) {
    const dev = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!dev) return { revoked: 0 };
    assertAdminOrgAccess(user, dev.orgId);
    const tokens = await this.prisma.deviceToken.findMany({ where: { deviceId, revokedAt: null } });
    // Remote revocation is the security boundary. Never claim or persist local success while any gateway
    // key may still consume quota. A partial remote failure leaves local rows active and the request failed,
    // making the operation safely retryable instead of producing a false-green fleet view.
    for (const t of tokens) {
      await this.gateway.revokeKey(t.gatewayKeyId);
    }
    return this.audit.transact(
      "device.revoke",
      user.viaSharedKey ? "shared-key" : "admin",
      user.id,
      async (tx) => {
        const revoked = tokens.length
          ? await tx.deviceToken.updateMany({
              where: { id: { in: tokens.map((token) => token.id) }, deviceId, revokedAt: null },
              data: { revokedAt: now },
            })
          : { count: 0 };
        return {
          result: { revoked: revoked.count },
          orgId: dev.orgId,
          payload: { deviceId, tokens: revoked.count },
        };
      },
    );
  }

  /** Tamper-evidence check: recompute the org's audit hash chain and report the first break (if any). */
  verifyAudit(orgId: string) {
    return this.audit.verify(orgId);
  }
}
