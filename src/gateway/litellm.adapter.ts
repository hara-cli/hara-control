import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  GatewayAdapter,
  GatewayReadiness,
  GatewayRollingSpend,
  GatewayUsageBucket,
  GatewayUsageReport,
  IssuedKey,
  SpendRecord,
} from "./gateway-adapter";
import { safeFetch } from "../security/ssrf";
import { GatewayKeyLimits } from "./key-policy";
import { PrismaService } from "../prisma/prisma.service";
import { allowedManagedModels } from "../providers/model-policy";
import { UsageRange, usageWindow } from "./usage";

/** LiteLLM accepts compact durations such as `20m`, `30d`, and `600s`. Floor to a whole
 * second so the data-plane token can never outlive the control-plane request boundary. */
export function liteLLMKeyDuration(expiresAt: Date, now = new Date()): string {
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error("device-token expiry must be a future date");
  }
  return `${Math.max(1, Math.floor(remainingMs / 1_000))}s`;
}

export function liteLLMKeyIssuePayload(opts: {
  model: string;
  alias: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
  limits?: GatewayKeyLimits;
}, now = new Date()): Record<string, unknown> {
  const limits = opts.limits;
  return {
    models: opts.model ? [opts.model] : [],
    key_alias: opts.alias,
    duration: liteLLMKeyDuration(opts.expiresAt, now),
    metadata: opts.metadata ?? {},
    ...(limits?.budgetLimits.length
      ? {
          budget_limits: limits.budgetLimits.map((entry) => ({
            budget_duration: entry.budgetDuration,
            max_budget: entry.maxBudgetUsd,
          })),
        }
      : {}),
    ...(limits?.rpmLimit == null ? {} : { rpm_limit: limits.rpmLimit }),
    ...(limits?.tpmLimit == null ? {} : { tpm_limit: limits.tpmLimit }),
  };
}

export function liteLLMResponseConfirmsLimits(
  response: Record<string, unknown>,
  limits?: GatewayKeyLimits,
): boolean {
  if (!limits) return true;
  if (limits.rpmLimit != null && Number(response.rpm_limit) !== limits.rpmLimit) return false;
  if (limits.tpmLimit != null && Number(response.tpm_limit) !== limits.tpmLimit) return false;
  if (!limits.budgetLimits.length) return true;
  if (!Array.isArray(response.budget_limits) || response.budget_limits.length !== limits.budgetLimits.length) {
    return false;
  }
  const actual = response.budget_limits
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const budgetDuration = typeof row.budget_duration === "string" ? row.budget_duration : "";
      const maxBudgetUsd = Number(row.max_budget);
      return Number.isFinite(maxBudgetUsd) ? `${budgetDuration}:${maxBudgetUsd}` : null;
    })
    .filter((entry): entry is string => entry !== null)
    .sort();
  const expected = limits.budgetLimits
    .map((entry) => `${entry.budgetDuration}:${entry.maxBudgetUsd}`)
    .sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

export async function liteLLMKeyManagementReady(
  get: (path: string) => Promise<Record<string, unknown>>,
): Promise<boolean> {
  try {
    // `/key/list` asks LiteLLM's generated Prisma client to read the complete verification-token
    // model. That makes an additive-schema mismatch (for example a newly required column) fail
    // here before enrollment does, without creating a key or making a paid provider request.
    await get("/key/list?page=1&size=1");
    return true;
  } catch {
    return false;
  }
}

export function normalizeLiteLLMSpendRows(
  keyIds: string[],
  rows: Array<{ keyId: unknown; spend: unknown }>,
): SpendRecord[] {
  const byAlias = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.keyId !== "string") continue;
    const spend = Number(row.spend);
    if (Number.isFinite(spend)) byAlias.set(row.keyId, spend);
  }
  return keyIds.map((keyId) => ({ keyId, spend: byAlias.get(keyId) ?? null }));
}

export async function liteLLMSpendSchemaReady(query: () => Promise<unknown>): Promise<boolean> {
  try {
    await query();
    return true;
  } catch {
    return false;
  }
}

export function normalizeLiteLLMUsageRows(
  rows: Array<{
    keyId: unknown;
    bucketAt: unknown;
    model: unknown;
    spend: unknown;
    totalTokens: unknown;
    requests: unknown;
    lastRequestAt: unknown;
  }>,
): GatewayUsageBucket[] {
  return rows.flatMap((row) => {
    if (typeof row.keyId !== "string") return [];
    const bucketAt = row.bucketAt instanceof Date ? row.bucketAt : new Date(String(row.bucketAt));
    const lastRequestAt = row.lastRequestAt instanceof Date
      ? row.lastRequestAt
      : new Date(String(row.lastRequestAt));
    const spend = Number(row.spend);
    const totalTokens = Number(row.totalTokens);
    const requests = Number(row.requests);
    if (
      !Number.isFinite(bucketAt.getTime()) ||
      !Number.isFinite(lastRequestAt.getTime()) ||
      !Number.isFinite(spend) ||
      !Number.isFinite(totalTokens) ||
      !Number.isFinite(requests)
    ) return [];
    return [{
      keyId: row.keyId,
      bucketAt,
      model: typeof row.model === "string" ? row.model : "",
      spend,
      totalTokens,
      requests,
      lastRequestAt,
    }];
  });
}

export function normalizeLiteLLMRollingRows(
  rows: Array<{ keyId: unknown; spend5h: unknown; spend7d: unknown; spend30d: unknown }>,
): GatewayRollingSpend[] {
  return rows.flatMap((row) => {
    if (typeof row.keyId !== "string") return [];
    const spend5h = Number(row.spend5h);
    const spend7d = Number(row.spend7d);
    const spend30d = Number(row.spend30d);
    if (![spend5h, spend7d, spend30d].every(Number.isFinite)) return [];
    return [{ keyId: row.keyId, spend5h, spend7d, spend30d }];
  });
}

function isPositivePrice(value: unknown): boolean {
  const price = Number(value);
  return Number.isFinite(price) && price > 0;
}

/** A USD budget cannot be enforced if LiteLLM prices a configured model at zero. Require every
 * deployment behind each requested alias to have positive input and output prices; accepting one
 * priced duplicate beside an unpriced duplicate would still leave an unmetered routing path. */
export function liteLLMModelsHavePositivePricing(
  response: Record<string, unknown>,
  requiredModels: string[],
): boolean {
  if (!requiredModels.length || !Array.isArray(response.data)) return false;
  const rows: unknown[] = response.data;
  return [...new Set(requiredModels)].every((model) => {
    const deployments = rows.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      return (entry as Record<string, unknown>).model_name === model;
    });
    return deployments.length > 0 && deployments.every((entry) => {
      const modelInfo = (entry as Record<string, unknown>).model_info;
      if (!modelInfo || typeof modelInfo !== "object") return false;
      const pricing = modelInfo as Record<string, unknown>;
      return isPositivePrice(pricing.input_cost_per_token) && isPositivePrice(pricing.output_cost_per_token);
    });
  });
}

export async function liteLLMModelPricingReady(
  get: (path: string) => Promise<Record<string, unknown>>,
  requiredModels: string[],
): Promise<boolean> {
  try {
    return liteLLMModelsHavePositivePricing(await get("/model/info"), requiredModels);
  } catch {
    return false;
  }
}

// Talks to the embedded LiteLLM proxy's admin API. The device token IS a LiteLLM virtual key scoped
// to a model; the real provider key stays inside LiteLLM. We never store the raw key — revocation is
// keyed off the alias we set (= the device id).
@Injectable()
export class LiteLLMAdapter implements GatewayAdapter {
  private readonly log = new Logger(LiteLLMAdapter.name);
  private readonly base = (process.env.LITELLM_URL || "http://localhost:4000").replace(/\/$/, "");
  private readonly masterKey = process.env.LITELLM_MASTER_KEY || "";

  constructor(private readonly prisma: PrismaService) {}

  private async get(path: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await safeFetch(`${this.base}${path}`, {
        method: "GET",
        headers: this.masterKey ? { authorization: `Bearer ${this.masterKey}` } : {},
        signal: controller.signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`LiteLLM ${path} -> HTTP ${res.status}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(path: string, body: unknown): Promise<Record<string, unknown>> {
    // safeFetch enforces the SSRF allow-list + private-address guard on the configured upstream
    // (LITELLM_URL) and re-checks every redirect hop. See src/security/ssrf.ts.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await safeFetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.masterKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Do not reflect an admin endpoint's response body into application logs. A proxy or upstream
      // error can include credential-bearing request fragments.
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`LiteLLM ${path} -> HTTP ${res.status}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  async issueKey({
    model,
    alias,
    expiresAt,
    metadata,
    limits,
  }: {
    model: string;
    alias: string;
    expiresAt: Date;
    metadata?: Record<string, unknown>;
    limits?: GatewayKeyLimits;
  }): Promise<IssuedKey> {
    if (
      limits?.budgetLimits.length &&
      !(await liteLLMModelPricingReady((path) => this.get(path), [model]))
    ) {
      throw new Error("LiteLLM model pricing is unavailable; refusing to issue an unenforceable USD budget");
    }
    const startedAt = new Date();
    let j: Record<string, unknown>;
    try {
      j = await this.call(
        "/key/generate",
        liteLLMKeyIssuePayload({ model, alias, expiresAt, metadata, limits }, startedAt),
      );
    } catch (error) {
      // A request can cross the gateway boundary before a timeout/malformed response is observed.
      // The alias belongs to this new device, so a compensating delete is safe and prevents orphans.
      try {
        await this.revokeKey(alias);
      } catch (cleanupError) {
        this.log.error(`failed to clean up uncertain LiteLLM key issue for alias ${alias}: ${(cleanupError as Error).message}`);
      }
      throw error;
    }
    const key = typeof j.key === "string" ? j.key : "";
    const gatewayExpiry = new Date(typeof j.expires === "string" ? j.expires : "");
    const expiryIsValid =
      Number.isFinite(gatewayExpiry.getTime()) &&
      gatewayExpiry.getTime() > startedAt.getTime() &&
      gatewayExpiry.getTime() <= expiresAt.getTime() + 5_000;
    if (!key || !expiryIsValid || !liteLLMResponseConfirmsLimits(j, limits)) {
      // The key may already exist even if LiteLLM returned a malformed lifecycle response.
      // Revoke by our non-secret alias before failing closed.
      try {
        await this.revokeKey(alias);
      } catch (error) {
        this.log.error(`failed to clean up malformed LiteLLM key response for alias ${alias}: ${(error as Error).message}`);
      }
      throw new Error("LiteLLM returned an invalid or unenforced key-policy response");
    }
    return { key, keyId: alias, expiresAt: gatewayExpiry };
  }

  async revokeKey(keyId: string): Promise<void> {
    await this.call("/key/delete", { key_aliases: [keyId] });
  }

  async listSpend(keyIds: string[]): Promise<SpendRecord[]> {
    if (!keyIds.length) return [];
    try {
      // LiteLLM 1.92 exposes GET /key/info only by raw virtual key, which Hara deliberately never
      // stores. Production shares the same PostgreSQL database, so query the isolated LiteLLM schema
      // by our non-secret device alias instead. Prisma.sql keeps every alias parameterized.
      const rows = await this.prisma.$queryRaw<Array<{ keyId: unknown; spend: unknown }>>(
        Prisma.sql`
          SELECT "key_alias" AS "keyId", "spend"
            FROM "litellm"."LiteLLM_VerificationToken"
           WHERE "key_alias" IN (${Prisma.join(keyIds)})
        `,
      );
      return normalizeLiteLLMSpendRows(keyIds, rows);
    } catch {
      this.log.warn("LiteLLM spend lookup unavailable; fleet will expose null instead of a false zero");
      return keyIds.map((keyId) => ({ keyId, spend: null }));
    }
  }

  async usage(keyIds: string[], range: UsageRange, now = new Date()): Promise<GatewayUsageReport> {
    if (!keyIds.length) return { available: true, buckets: [], rolling: [] };
    const window = usageWindow(range, now);
    const bucketExpression = window.bucketUnit === "hour"
      ? Prisma.sql`date_trunc('hour', l."endTime")`
      : Prisma.sql`date_trunc('day', l."endTime")`;
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60_000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    try {
      const [bucketRows, rollingRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{
          keyId: unknown;
          bucketAt: unknown;
          model: unknown;
          spend: unknown;
          totalTokens: unknown;
          requests: unknown;
          lastRequestAt: unknown;
        }>>(
          Prisma.sql`
            SELECT v."key_alias" AS "keyId",
                   ${bucketExpression} AS "bucketAt",
                   COALESCE(NULLIF(l."model_group", ''), NULLIF(l."model", ''), '') AS "model",
                   COALESCE(SUM(l."spend"), 0)::double precision AS "spend",
                   COALESCE(SUM(l."total_tokens"), 0)::double precision AS "totalTokens",
                   COUNT(l."request_id")::int AS "requests",
                   MAX(l."endTime") AS "lastRequestAt"
              FROM "litellm"."LiteLLM_VerificationToken" v
              JOIN "litellm"."LiteLLM_SpendLogs" l ON l."api_key" = v."token"
             WHERE v."key_alias" IN (${Prisma.join(keyIds)})
               AND l."endTime" >= ${window.from}
               AND l."endTime" < ${window.to}
             GROUP BY 1, 2, 3
             ORDER BY 2 ASC
          `,
        ),
        this.prisma.$queryRaw<Array<{
          keyId: unknown;
          spend5h: unknown;
          spend7d: unknown;
          spend30d: unknown;
        }>>(
          Prisma.sql`
            SELECT v."key_alias" AS "keyId",
                   COALESCE(SUM(l."spend") FILTER (WHERE l."endTime" >= ${fiveHoursAgo}), 0)::double precision AS "spend5h",
                   COALESCE(SUM(l."spend") FILTER (WHERE l."endTime" >= ${sevenDaysAgo}), 0)::double precision AS "spend7d",
                   COALESCE(SUM(l."spend") FILTER (WHERE l."endTime" >= ${thirtyDaysAgo}), 0)::double precision AS "spend30d"
              FROM "litellm"."LiteLLM_VerificationToken" v
              LEFT JOIN "litellm"."LiteLLM_SpendLogs" l
                ON l."api_key" = v."token"
               AND l."endTime" >= ${thirtyDaysAgo}
               AND l."endTime" < ${window.to}
             WHERE v."key_alias" IN (${Prisma.join(keyIds)})
             GROUP BY v."key_alias"
          `,
        ),
      ]);
      return {
        available: true,
        buckets: normalizeLiteLLMUsageRows(bucketRows),
        rolling: normalizeLiteLLMRollingRows(rollingRows),
      };
    } catch {
      this.log.warn("LiteLLM usage ledger unavailable; admin usage will expose unavailable instead of fake zeroes");
      return { available: false, buckets: [], rolling: [] };
    }
  }

  async readiness(): Promise<GatewayReadiness> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await safeFetch(`${this.base}/health/liveliness`, {
          method: "GET",
          headers: this.masterKey ? { authorization: `Bearer ${this.masterKey}` } : {},
          signal: controller.signal,
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return { ok: false };
        }
        const [keyManagement, spendSchema, modelPricing] = await Promise.all([
          liteLLMKeyManagementReady((path) => this.get(path)),
          liteLLMSpendSchemaReady(() =>
            this.prisma.$queryRaw(
              Prisma.sql`
                SELECT v."key_alias", v."spend", l."request_id", l."spend", l."total_tokens",
                       l."endTime", l."model", l."model_group"
                  FROM "litellm"."LiteLLM_VerificationToken" v
                  LEFT JOIN "litellm"."LiteLLM_SpendLogs" l ON FALSE
                 WHERE FALSE
              `,
            ),
          ),
          liteLLMModelPricingReady((path) => this.get(path), allowedManagedModels()),
        ]);
        return { ok: keyManagement && spendSchema && modelPricing };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { ok: false };
    }
  }
}
