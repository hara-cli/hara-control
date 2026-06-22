// Phase-1.5 live e2e: the FULL data + control plane loop with the real LiteLLMAdapter
// (GATEWAY_ADAPTER=litellm), no mock gateway. Proves:
//   enroll -> control plane mints a REAL LiteLLM virtual key (the device token)
//   that key actually works against the gateway -> proxied to the (mock) upstream
//   revoke at the control plane -> the key dies at the gateway (chat now 401)
// No real provider key needed (mock upstream). Run via scripts/e2e-litellm.sh.
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

(async () => {
  let r = await adminReq("/admin/orgs", { name: "litellm-e2e" });
  ok(r.ok, `create org -> ${r.status}`);
  const org = await r.json();

  r = await adminReq("/admin/enroll-codes", { orgId: org.id, model: "glm-mock" });
  ok(r.ok, `enroll-code -> ${r.status}`);
  const { code } = await r.json();

  r = await fetch(`${CTRL}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, device: { name: "mac", os: "darwin", hara_version: "0.68.0" } }) });
  ok(r.ok, `enroll -> ${r.status}`);
  const enr = await r.json();
  ok(typeof enr.device_token === "string" && enr.device_token.startsWith("sk-"), `enroll minted a real LiteLLM key (got ${String(enr.device_token).slice(0, 10)}…)`);
  console.log(`  · enrolled, device token = ${enr.device_token.slice(0, 12)}…`);

  // the minted key works against the gateway -> mock upstream
  r = await chat(enr.device_token);
  ok(r.ok, `chat with minted key -> ${r.status}`);
  const content = (await r.json())?.choices?.[0]?.message?.content || "";
  ok(/mock upstream/i.test(content), `gateway proxied to upstream (got: ${JSON.stringify(content)})`);
  console.log(`  · chat ok, upstream said: ${JSON.stringify(content)}`);

  // revoke at the control plane -> propagates to the gateway
  r = await adminReq(`/admin/devices/${enr.device_id}/revoke`, {});
  ok(r.ok, `revoke -> ${r.status}`);
  ok((await r.json()).revoked === 1, "revoked 1 token");

  r = await chat(enr.device_token);
  ok(r.status === 401, `revoked key rejected by gateway -> 401 (got ${r.status})`);
  console.log(`  · post-revoke chat correctly rejected (${r.status})`);

  console.log("PHASE-1.5 E2E PASS: enroll mints a real LiteLLM key -> chat proxies to upstream -> revoke kills it at the gateway");
  process.exit(0);
})().catch((e) => { console.error(`PHASE-1.5 E2E FAIL: ${e.message}`); process.exit(1); });
