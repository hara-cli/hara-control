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

const adminReq = (p, b, m = "POST") =>
  fetch(`${CTRL}${p}`, { method: m, headers: { "content-type": "application/json", "x-admin-key": ADMIN }, body: b ? JSON.stringify(b) : undefined });
const chat = (key) =>
  fetch(`${LITELLM}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "glm-mock", messages: [{ role: "user", content: "hi" }] }),
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

  // the minted key works against the gateway -> mock upstream
  r = await chat(enr.device_token);
  ok(r.ok, `chat with minted key -> ${r.status}`);
  const content = (await r.json())?.choices?.[0]?.message?.content || "";
  ok(/mock upstream/i.test(content), `gateway proxied to upstream (got: ${JSON.stringify(content)})`);
  console.log(`  · chat ok, upstream said: ${JSON.stringify(content)}`);

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
