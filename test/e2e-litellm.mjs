// Phase-1.5 live e2e: the FULL data + control plane loop with the real LiteLLMAdapter
// (GATEWAY_ADAPTER=litellm), no mock gateway. Proves:
//   enroll -> control plane mints a REAL, lifetime/budget/rate-limited LiteLLM virtual key
//   that key actually works against the gateway -> proxied to the (mock) upstream
//   revoke at the control plane -> the key dies at the gateway (chat now 401)
// No real provider key needed (mock upstream). Run via scripts/e2e-litellm.sh.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CTRL = process.env.HARA_CONTROL_URL || "http://localhost:4100";
const LITELLM = process.env.LITELLM_URL || "http://localhost:4000";
const ADMIN = process.env.HARA_CONTROL_ADMIN_KEY || "admin-dev-e2e";
const LITELLM_MASTER = process.env.LITELLM_MASTER_KEY || "sk-hara-master-e2e";
const MANAGED_MODELS = ["glm-mock", "glm-mock-pro"];

const adminReq = (p, b, m = "POST") =>
  fetch(`${CTRL}${p}`, { method: m, headers: { "content-type": "application/json", "x-admin-key": ADMIN }, body: b ? JSON.stringify(b) : undefined });
const chat = (key, model = MANAGED_MODELS[0]) =>
  fetch(`${LITELLM}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
const ok = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };
const POLICY = {
  tokenTtlMinutes: 24 * 60,
  budgetLimits: [
    { window: "5h", maxUsd: 2 },
    { window: "week", maxUsd: 20 },
    { window: "month", maxUsd: 60 },
  ],
  rpmLimit: 300,
  tpmLimit: 500_000,
};

export const EXPECTED_BUDGETS = [
  { window: "5h", maxUsd: 2, budgetDuration: "5h" },
  { window: "week", maxUsd: 20, budgetDuration: "7d" },
  { window: "month", maxUsd: 60, budgetDuration: "30d" },
];

export const budgetsMatch = (limits) => {
  if (!Array.isArray(limits) || limits.length !== EXPECTED_BUDGETS.length) return false;
  const canonical = (entries) => entries.map((entry) => ({
    window: entry?.window,
    maxUsd: Number(entry?.maxUsd),
    budgetDuration: entry?.budgetDuration,
  })).sort((a, b) => String(a.window).localeCompare(String(b.window)));
  return JSON.stringify(canonical(limits)) === JSON.stringify(canonical(EXPECTED_BUDGETS));
};

export const policyMatches = (policy) =>
  policy?.tokenTtlMinutes === POLICY.tokenTtlMinutes &&
  policy?.rpmLimit === POLICY.rpmLimit &&
  policy?.tpmLimit === POLICY.tpmLimit &&
  budgetsMatch(policy?.budgetLimits);

export async function run() {
  let r = await adminReq("/admin/orgs", { name: "litellm-e2e" });
  ok(r.ok, `create org -> ${r.status}`);
  const org = await r.json();

  r = await adminReq("/admin/enroll-codes", {
    orgId: org.id,
    model: "glm-mock",
    ...POLICY,
  });
  ok(r.ok, `enroll-code -> ${r.status}`);
  const issuedCode = await r.json();
  const { code } = issuedCode;
  ok(policyMatches(issuedCode.accessPolicy), "enrollment code preserved the requested access policy");

  r = await fetch(`${CTRL}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, device: { name: "mac", os: "darwin", hara_version: "0.68.0" } }) });
  ok(r.ok, `enroll -> ${r.status}`);
  const enr = await r.json();
  ok(
    typeof enr.device_token === "string" && enr.device_token.startsWith("sk-"),
    "enroll minted a real LiteLLM key",
  );
  ok(policyMatches(enr.access_policy), "enroll returned the enforced access policy");
  ok(
    JSON.stringify(enr.available_models) === JSON.stringify(MANAGED_MODELS),
    "one enrolled key exposes the complete managed-model catalog",
  );
  const expiresInMs = Date.parse(enr.expires_at) - Date.now();
  ok(expiresInMs > 23 * 60 * 60_000 && expiresInMs <= 24 * 60 * 60_000, "device key uses the one-day lifetime");
  console.log("  · enrolled a one-day key with 5h/7d/30d budgets and RPM/TPM limits");

  r = await adminReq(`/admin/fleet?orgId=${encodeURIComponent(org.id)}`, undefined, "GET");
  ok(r.ok, `fleet -> ${r.status}`);
  const fleet = await r.json();
  const row = fleet.find((candidate) => candidate.device_id === enr.device_id);
  ok(row?.token_active === true, "fleet shows the limited token as active");
  ok(row?.rpm_limit === POLICY.rpmLimit && row?.tpm_limit === POLICY.tpmLimit, "fleet exposes RPM/TPM limits");
  ok(budgetsMatch(row?.budget_limits), "fleet exposes the same rolling budget policy");

  // The same minted key works through both authorized routes.
  for (const model of MANAGED_MODELS) {
    r = await chat(enr.device_token, model);
    ok(r.ok, `chat with minted key on ${model} -> ${r.status}`);
    const content = (await r.json())?.choices?.[0]?.message?.content || "";
    ok(/mock upstream/i.test(content), `gateway proxied ${model} to upstream (got: ${JSON.stringify(content)})`);
  }
  console.log("  · the same device key works on both managed models");

  // Reproduce a pre-0.1.15 single-model key, then prove heartbeat expands it in place. The client keeps
  // exactly the same raw token throughout; Control looks up only LiteLLM's private one-way identifier.
  r = await fetch(`${LITELLM}/key/update`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LITELLM_MASTER}`,
    },
    body: JSON.stringify({ key: enr.device_token, models: [MANAGED_MODELS[0]] }),
  });
  ok(r.ok, `shrink test key to legacy scope -> ${r.status}`);
  r = await chat(enr.device_token, MANAGED_MODELS[1]);
  ok(!r.ok, `legacy-scoped key rejects the second model before heartbeat (got ${r.status})`);

  r = await fetch(`${CTRL}/v1/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${enr.device_token}`,
    },
    body: JSON.stringify({
      device_id: enr.device_id,
      name: "mac",
      os: "darwin",
      hara_version: "0.134.2",
    }),
  });
  ok(r.ok, `heartbeat reconciles legacy key -> ${r.status}`);
  const heartbeat = await r.json();
  ok(
    JSON.stringify(heartbeat.available_models) === JSON.stringify(MANAGED_MODELS),
    "heartbeat returns the restored two-model catalog",
  );
  r = await chat(enr.device_token, MANAGED_MODELS[1]);
  ok(r.ok, `same token reaches the second model after heartbeat -> ${r.status}`);
  console.log("  · legacy single-model scope expanded in place; raw device key stayed unchanged");

  // Positive synthetic pricing on glm-mock proves budget accounting changes after a real request.
  let spendRow;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    r = await adminReq(`/admin/fleet?orgId=${encodeURIComponent(org.id)}`, undefined, "GET");
    ok(r.ok, `fleet spend refresh -> ${r.status}`);
    const refreshed = await r.json();
    spendRow = refreshed.find((candidate) => candidate.device_id === enr.device_id);
    if (spendRow?.spend_available === true && Number(spendRow.spend) > 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  ok(spendRow?.spend_available === true && Number(spendRow.spend) > 0, "priced chat records positive USD spend");
  console.log("  · positive priced spend recorded");

  // revoke at the control plane -> propagates to the gateway
  r = await adminReq(`/admin/devices/${enr.device_id}/revoke`, {});
  ok(r.ok, `revoke -> ${r.status}`);
  ok((await r.json()).revoked === 1, "revoked 1 token");

  r = await chat(enr.device_token);
  ok(r.status === 401, `revoked key rejected by gateway -> 401 (got ${r.status})`);
  console.log(`  · post-revoke chat correctly rejected (${r.status})`);

  console.log("PHASE-1.5 E2E PASS: limited enroll -> LiteLLM confirms policy -> chat works -> revoke kills the key");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((error) => {
    console.error(`PHASE-1.5 E2E FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
