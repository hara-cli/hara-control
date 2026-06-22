// Phase-1 live end-to-end: drives the running control plane (on :4100, against real Postgres)
// through org -> enroll-code -> enroll -> heartbeat -> fleet -> revoke, plus the auth guards.
// Run via scripts/e2e.sh (which brings up Postgres + the server first). Exit 0 = pass.
const BASE = process.env.HARA_CONTROL_URL || "http://localhost:4100";
const ADMIN = process.env.HARA_CONTROL_ADMIN_KEY || "admin-dev-e2e";

const adminReq = (path, body, method = "POST") =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-admin-key": ADMIN },
    body: body ? JSON.stringify(body) : undefined,
  });
const deviceReq = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const ok = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };

(async () => {
  let r = await adminReq("/admin/orgs", { name: "acme" });
  ok(r.ok, `create org -> ${r.status}`);
  const org = await r.json();
  ok(org.id, "org has id");

  r = await adminReq("/admin/enroll-codes", { orgId: org.id, model: "glm-5" });
  ok(r.ok, `create enroll-code -> ${r.status}`);
  const { code } = await r.json();
  ok(code, "got enroll code");

  r = await deviceReq("/v1/enroll", { code, device: { name: "mac", os: "darwin", hara_version: "0.68.0" } });
  ok(r.ok, `enroll -> ${r.status}`);
  const enr = await r.json();
  ok(enr.device_token && enr.device_id, "enroll returned device_token + device_id");
  ok(enr.model === "glm-5", `enroll model = glm-5 (got ${enr.model})`);

  r = await deviceReq("/v1/enroll", { code, device: { name: "x", os: "", hara_version: "" } });
  ok(r.status === 401, `reused code rejected -> 401 (got ${r.status})`);

  r = await deviceReq("/v1/heartbeat", { device_id: enr.device_id, hara_version: "0.68.0", os: "darwin" }, enr.device_token);
  ok(r.status === 204, `heartbeat -> 204 (got ${r.status})`);

  r = await adminReq(`/admin/fleet?orgId=${org.id}`, null, "GET");
  ok(r.ok, `fleet -> ${r.status}`);
  const fleet = await r.json();
  ok(fleet.length === 1, `fleet has 1 device (got ${fleet.length})`);
  ok(fleet[0].online, "device shows online");
  ok(fleet[0].token_active, "device token active");

  r = await adminReq(`/admin/devices/${enr.device_id}/revoke`, {});
  ok(r.ok, `revoke -> ${r.status}`);
  ok((await r.json()).revoked === 1, "revoked 1 token");

  r = await deviceReq("/v1/heartbeat", { device_id: enr.device_id }, enr.device_token);
  ok(r.status === 401, `heartbeat after revoke -> 401 (got ${r.status})`);

  r = await fetch(`${BASE}/admin/fleet?orgId=${org.id}`); // no admin key
  ok(r.status === 401, `admin guard blocks missing key -> 401 (got ${r.status})`);

  console.log("PHASE-1 E2E PASS: org -> code -> enroll -> heartbeat -> fleet -> revoke + auth guards");
  process.exit(0);
})().catch((e) => { console.error(`PHASE-1 E2E FAIL: ${e.message}`); process.exit(1); });
