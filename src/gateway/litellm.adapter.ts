import { Injectable, Logger } from "@nestjs/common";
import { GatewayAdapter, GatewayReadiness, IssuedKey, SpendRecord } from "./gateway-adapter";
import { safeFetch } from "../security/ssrf";
import { GatewayKeyLimits } from "./key-policy";

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

// Talks to the embedded LiteLLM proxy's admin API. The device token IS a LiteLLM virtual key scoped
// to a model; the real provider key stays inside LiteLLM. We never store the raw key — revocation is
// keyed off the alias we set (= the device id).
@Injectable()
export class LiteLLMAdapter implements GatewayAdapter {
  private readonly log = new Logger(LiteLLMAdapter.name);
  private readonly base = (process.env.LITELLM_URL || "http://localhost:4000").replace(/\/$/, "");
  private readonly masterKey = process.env.LITELLM_MASTER_KEY || "";

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
      // shape varies across LiteLLM versions; tolerate + fall back to zero. The authoritative usage
      // join (spend tables in the shared Postgres) lands once LiteLLM runs against our PG.
      const j = await this.call("/key/info", { key_aliases: keyIds });
      const rows = Array.isArray((j as { keys?: unknown }).keys) ? ((j as { keys: Record<string, unknown>[] }).keys) : [];
      return rows.map((r) => ({ keyId: String(r.key_alias ?? ""), spend: Number(r.spend ?? 0) }));
    } catch (e) {
      this.log.warn(`spend lookup failed: ${(e as Error).message}`);
      return keyIds.map((keyId) => ({ keyId, spend: 0 }));
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
        return {
          ok: await liteLLMKeyManagementReady((path) => this.get(path)),
        };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { ok: false };
    }
  }
}
