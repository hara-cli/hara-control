#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const PROBE_LIMITS = {
  budgetLimits: [
    { budget_duration: "5h", max_budget: 0.11 },
    { budget_duration: "7d", max_budget: 0.22 },
    { budget_duration: "30d", max_budget: 0.33 },
  ],
  rpmLimit: 17,
  tpmLimit: 17_000,
};

export function responseConfirmsProbePolicy(response) {
  if (!response || typeof response !== "object") return false;
  if (Number(response.rpm_limit) !== PROBE_LIMITS.rpmLimit) return false;
  if (Number(response.tpm_limit) !== PROBE_LIMITS.tpmLimit) return false;
  if (!Array.isArray(response.budget_limits)) return false;

  const actual = response.budget_limits.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const duration = typeof entry.budget_duration === "string" ? entry.budget_duration : "";
    const budget = Number(entry.max_budget);
    return Number.isFinite(budget) ? `${duration}:${budget}` : null;
  }).filter(Boolean).sort();
  const expected = PROBE_LIMITS.budgetLimits
    .map((entry) => `${entry.budget_duration}:${entry.max_budget}`)
    .sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function localLiteLLMUrl(env = process.env) {
  const url = new URL(env.LITELLM_URL || "http://127.0.0.1:4000");
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error("policy probe refuses to send the LiteLLM master credential to a non-local host");
  }
  return url.href.replace(/\/$/, "");
}

async function post(base, path, body, masterKey) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${masterKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`LiteLLM ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function probeLiteLLMKeyPolicy(env = process.env) {
  const base = localLiteLLMUrl(env);
  const masterKey = env.LITELLM_MASTER_KEY || "";
  if (masterKey.length < 24) throw new Error("LITELLM_MASTER_KEY is missing or invalid");

  const alias = `hara-policy-probe-${Date.now()}-${randomBytes(6).toString("hex")}`;
  let issueError;
  try {
    const response = await post(base, "/key/generate", {
      models: ["deepseek-v4-flash"],
      key_alias: alias,
      duration: "15m",
      metadata: { purpose: "hara-control-policy-probe" },
      budget_limits: PROBE_LIMITS.budgetLimits,
      rpm_limit: PROBE_LIMITS.rpmLimit,
      tpm_limit: PROBE_LIMITS.tpmLimit,
    }, masterKey);
    if (!responseConfirmsProbePolicy(response)) {
      throw new Error("LiteLLM did not confirm every requested budget/rate limit");
    }
  } catch (error) {
    issueError = error;
  }

  let cleanupError;
  try {
    await post(base, "/key/delete", { key_aliases: [alias] }, masterKey);
  } catch (error) {
    cleanupError = error;
  }

  if (cleanupError) {
    throw new Error(`temporary policy probe cleanup failed: ${cleanupError.message}`);
  }
  if (issueError) throw issueError;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  probeLiteLLMKeyPolicy()
    .then(() => console.log("LiteLLM key-policy probe passed; temporary key deleted"))
    .catch((error) => {
      console.error(`LiteLLM key-policy probe failed: ${error.message}`);
      process.exitCode = 1;
    });
}
