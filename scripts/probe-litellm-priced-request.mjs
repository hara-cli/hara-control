#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import prismaPackage from "@prisma/client";

const { PrismaClient } = prismaPackage;

export const PRICED_PROBE_MODELS = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
]);

export const PRICED_PROBE_POLICY = {
  budgetLimits: [
    { budget_duration: "5h", max_budget: 0.01 },
    { budget_duration: "7d", max_budget: 0.02 },
    { budget_duration: "30d", max_budget: 0.03 },
  ],
  rpmLimit: 10,
  tpmLimit: 10_000,
};

export function positiveSpendRecorded(row) {
  return Boolean(
    row
    && Number(row.verificationSpend) > 0
    && Number(row.logSpend) > 0
    && Number(row.logCount) > 0
    && Number(row.totalTokens) > 0
  );
}

export function responseConfirmsPricedProbePolicy(response) {
  if (!response || typeof response !== "object") return false;
  if (Number(response.rpm_limit) !== PRICED_PROBE_POLICY.rpmLimit) return false;
  if (Number(response.tpm_limit) !== PRICED_PROBE_POLICY.tpmLimit) return false;
  if (!Array.isArray(response.budget_limits)) return false;
  const actual = response.budget_limits.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const duration = typeof entry.budget_duration === "string" ? entry.budget_duration : "";
    const budget = Number(entry.max_budget);
    return Number.isFinite(budget) ? `${duration}:${budget}` : null;
  }).filter(Boolean).sort();
  const expected = PRICED_PROBE_POLICY.budgetLimits
    .map((entry) => `${entry.budget_duration}:${entry.max_budget}`)
    .sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function localLiteLLMUrl(env = process.env) {
  const url = new URL(env.LITELLM_URL || "http://127.0.0.1:4000");
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error("priced-request probe refuses to send credentials to a non-local LiteLLM host");
  }
  return url.href.replace(/\/$/, "");
}

export function pricedProbeModel(env = process.env) {
  const model = env.HARA_PRICED_PROBE_MODEL || PRICED_PROBE_MODELS[0];
  if (!PRICED_PROBE_MODELS.includes(model)) {
    throw new Error(`HARA_PRICED_PROBE_MODEL must be one of ${PRICED_PROBE_MODELS.join(", ")}`);
  }
  return model;
}

async function jsonPost(fetchImpl, base, path, body, bearer) {
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`LiteLLM ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function readSpend(prisma, alias) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT v."spend" AS "verificationSpend",
            COUNT(l."request_id")::int AS "logCount",
            COALESCE(SUM(l."spend"), 0)::double precision AS "logSpend",
            COALESCE(SUM(l."total_tokens"), 0)::double precision AS "totalTokens"
       FROM "litellm"."LiteLLM_VerificationToken" v
       LEFT JOIN "litellm"."LiteLLM_SpendLogs" l ON l."api_key" = v."token"
      WHERE v."key_alias" = $1
      GROUP BY v."spend"`,
    alias,
  );
  return rows[0] ?? null;
}

/** Makes one deliberately tiny real request. This is a deployment gate, not a monitoring loop: it
 * proves a successful request creates positive USD spend, then deletes the temporary virtual key. */
export async function probeLiteLLMPricedRequest(env = process.env, dependencies = {}) {
  const base = localLiteLLMUrl(env);
  const model = pricedProbeModel(env);
  const masterKey = env.LITELLM_MASTER_KEY || "";
  if (masterKey.length < 24) throw new Error("LITELLM_MASTER_KEY is missing or invalid");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for the spend assertion");

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const prisma = dependencies.prisma ?? new PrismaClient();
  const ownsPrisma = !dependencies.prisma;
  const alias = `hara-priced-probe-${model.slice("deepseek-v4-".length)}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  let primaryError;
  let safeResult;

  try {
    const issued = await jsonPost(fetchImpl, base, "/key/generate", {
      models: [model],
      key_alias: alias,
      duration: "15m",
      metadata: { purpose: "hara-control-priced-request-probe", model },
      budget_limits: PRICED_PROBE_POLICY.budgetLimits,
      rpm_limit: PRICED_PROBE_POLICY.rpmLimit,
      tpm_limit: PRICED_PROBE_POLICY.tpmLimit,
    }, masterKey);
    if (!responseConfirmsPricedProbePolicy(issued)) {
      throw new Error("LiteLLM did not confirm every temporary budget/rate limit");
    }
    const virtualKey = typeof issued.key === "string" ? issued.key : "";
    if (!virtualKey) throw new Error("LiteLLM key generation returned no temporary key");

    const completion = await fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${virtualKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply OK" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    await completion.arrayBuffer();
    issued.key = "";
    if (!completion.ok) throw new Error(`LiteLLM paid completion returned HTTP ${completion.status}`);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const row = await readSpend(prisma, alias);
      if (positiveSpendRecorded(row)) {
        safeResult = {
          model,
          logCount: Number(row.logCount),
          totalTokens: Number(row.totalTokens),
          spendPositive: true,
        };
        break;
      }
      await sleep(1_000);
    }
    if (!safeResult) {
      throw new Error("successful completion did not record positive LiteLLM USD spend within 30 seconds");
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await jsonPost(fetchImpl, base, "/key/delete", { key_aliases: [alias] }, masterKey);
  } catch (error) {
    cleanupError = error;
  }
  if (ownsPrisma) {
    try {
      await prisma.$disconnect();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (cleanupError) throw new Error(`temporary priced-request cleanup failed: ${cleanupError.message}`);
  if (primaryError) throw primaryError;
  return safeResult;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  probeLiteLLMPricedRequest()
    .then((result) => {
      console.log(`LiteLLM priced-request probe passed for ${result.model} (${result.totalTokens} tokens); temporary key deleted`);
    })
    .catch((error) => {
      console.error(`LiteLLM priced-request probe failed: ${error.message}`);
      process.exitCode = 1;
    });
}
