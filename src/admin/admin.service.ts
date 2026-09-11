import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
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
import { DeskProvisioner } from "../enroll/desk-provisioner";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orgTree: OrgTreeService,
    @Inject(GATEWAY_ADAPTER) private readonly gateway: GatewayAdapter,
    @Optional() private readonly deskProvisioner?: DeskProvisioner,
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
    const tokenIsActive = (device: (typeof devices)[number], token: (typeof devices)[number]["tokens"][number]) =>
      !device.revocationRequestedAt
      && !token.revokedAt
      && (!token.expiresAt || token.expiresAt.getTime() > now.getTime());
    const keyIds = devices.flatMap((d) => d.tokens.map((t) => t.gatewayKeyId));
    const spend = new Map((await this.gateway.listSpend(keyIds)).map((s) => [s.keyId, s.spend]));

    return devices.map((d) => {
      const active = d.tokens.find((token) => tokenIsActive(d, token));
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
        revocation_state: d.revocationCompletedAt
          ? "completed"
          : d.revocationRequestedAt
            ? "pending"
            : "active",
        revocation_requested_at: d.revocationRequestedAt,
        revocation_completed_at: d.revocationCompletedAt,
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
          status: d.revocationRequestedAt && !d.revocationCompletedAt
            ? "revocation_pending"
            : token.revokedAt
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
    const paygUsage = gatewayUsage.kind === "payg-ledger" ? gatewayUsage : undefined;
    const nativeUsage = gatewayUsage.kind === "provider-native" ? gatewayUsage : undefined;
    const spendAvailable = paygUsage?.available === true;
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
    if (spendAvailable) {
      for (const entry of paygUsage.buckets) {
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

    const rolling = new Map((paygUsage?.rolling ?? []).map((entry) => [entry.keyId, entry]));
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
        // A USD policy is comparable only with the PAYG ledger that reports USD.
        // Provider subscription meters remain native and must never be converted from response tokens.
        const usedUsd = spendAvailable ? (usage?.[rollingField[budgetWindow]] ?? 0) : null;
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
      /** Backward-compatible name: this describes the PAYG spend ledger, not every allowance source. */
      available: spendAvailable,
      accounting: gatewayUsage.kind === "payg-ledger"
        ? {
            authority: "gateway" as const,
            mode: "payg-ledger" as const,
            source: gatewayUsage.source,
            unit: gatewayUsage.currency,
            haraMayInferBillingFromTransportTokens: false as const,
          }
        : {
            authority: "provider" as const,
            mode: "provider-native" as const,
            source: gatewayUsage.provider,
            unit: "provider-defined" as const,
            authoritative: gatewayUsage.authoritative,
            fetchedAt: gatewayUsage.fetchedAt,
            validUntil: gatewayUsage.validUntil ?? null,
            haraMayInferBillingFromTransportTokens: false as const,
          },
      nativeAllowance: nativeUsage
        ? {
            available: nativeUsage.available,
            meters: nativeUsage.available
              ? nativeUsage.meters.flatMap((meter) => {
                  const meta = keyMeta.get(meter.keyId);
                  if (!meta) return [];
                  return [{
                    ...meta,
                    id: meter.id,
                    label: meter.label,
                    unit: meter.unit,
                    availability: meter.availability,
                    ...(meter.used !== undefined ? { used: meter.used } : {}),
                    ...(meter.remaining !== undefined ? { remaining: meter.remaining } : {}),
                    ...(meter.limit !== undefined ? { limit: meter.limit } : {}),
                    ...(meter.window !== undefined ? { window: meter.window } : {}),
                    ...(meter.resetAt !== undefined ? { resetAt: meter.resetAt } : {}),
                  }];
                })
              : [],
          }
        : null,
      totals: spendAvailable
        ? { spend: totalSpend, totalTokens, requests, latestRequestAt }
        : { spend: null, totalTokens: null, requests: null, latestRequestAt: null },
      series: spendAvailable ? series : [],
      breakdown: spendAvailable
        ? [...breakdown.values()].sort((a, b) => b.spend - a.spend || b.totalTokens - a.totalTokens)
        : [],
      quotas,
    };
  }

  /** Revoke every token for a device. Local access fails closed before any remote I/O; a remote
   * failure remains visibly pending and a retry idempotently finishes the same operation. */
  async revokeDevice(deviceId: string, user: AuthedUser, now = new Date()) {
    let dev = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { person: { select: { email: true } } },
    });
    if (!dev) return { revoked: 0 };
    assertAdminOrgAccess(user, dev.orgId);
    const actorType = user.viaSharedKey ? "shared-key" : "admin";

    if (!dev.revocationRequestedAt) {
      await this.audit.transact(
        "device.revocation_requested",
        actorType,
        user.id,
        async (tx) => {
          const claimed = await tx.device.updateMany({
            where: { id: deviceId, revocationRequestedAt: null },
            data: { revocationRequestedAt: now },
          });
          const local = await tx.deviceToken.updateMany({
            where: { deviceId, revokedAt: null },
            data: { revokedAt: now },
          });
          return {
            result: { claimed: claimed.count === 1, revoked: local.count },
            orgId: dev!.orgId,
            payload: { deviceId, claimed: claimed.count === 1, tokens: local.count },
          };
        },
      );
    }

    // Re-read after the serializable intent transaction. All subsequently authenticated Control
    // requests now observe revokedAt and fail, even if a remote gateway or Desk is unavailable.
    dev = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { person: { select: { email: true } } },
    });
    if (!dev) return { revoked: 0 };
    const tokens = await this.prisma.deviceToken.findMany({ where: { deviceId } });
    if (dev.revocationCompletedAt) {
      return { revoked: tokens.length, deskRevoked: false };
    }

    // Remote calls are intentionally idempotent. A partial failure leaves the durable pending state
    // in place, and retry revokes every known key again rather than guessing where the prior run stopped.
    for (const t of tokens) {
      await this.gateway.revokeKey(t.gatewayKeyId);
    }
    let deskRevoked = false;
    if (dev.deskProvisionedAt || dev.deskCleanupPendingAt) {
      if (!this.deskProvisioner || !dev.deskOwner || !dev.deskOrigin) {
        throw new Error("Hara Desk revocation is unavailable for this provisioned device");
      }
      await this.deskProvisioner.revokeInstallation({
        orgId: dev.orgId,
        owner: dev.deskOwner,
        installationId: dev.id,
        expectedUrl: dev.deskOrigin,
        // A failed initial registration may genuinely be absent remotely; only its explicit
        // pending-cleanup state is allowed to accept Desk's idempotent "missing" response.
        allowMissing: Boolean(dev.deskCleanupPendingAt && !dev.deskProvisionedAt),
      });
      deskRevoked = true;
    }
    return this.audit.transact(
      "device.revocation_completed",
      actorType,
      user.id,
      async (tx) => {
        const completedAt = dev.revocationRequestedAt && now < dev.revocationRequestedAt
          ? dev.revocationRequestedAt
          : now;
        await tx.device.update({
          where: { id: deviceId },
          data: {
            revocationCompletedAt: completedAt,
            ...(deskRevoked ? {
              deskProvisionedAt: null,
              deskCleanupPendingAt: null,
              deskOwner: null,
              deskOrigin: null,
            } : {}),
          },
        });
        return {
          result: { revoked: tokens.length, deskRevoked },
          orgId: dev.orgId,
          payload: { deviceId, tokens: tokens.length, deskRevoked },
        };
      },
    );
  }

  /** Tamper-evidence check: recompute the org's audit hash chain and report the first break (if any). */
  verifyAudit(orgId: string) {
    return this.audit.verify(orgId);
  }
}
