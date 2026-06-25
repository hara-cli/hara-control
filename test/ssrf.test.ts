// SSRF guard unit tests — pure, offline (no network needed for the IP/allow-list checks).  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertUrlAllowed,
  isPrivateIPv4,
  isPrivateIPv6,
  isAlwaysBlockedIP,
  loadSsrfPolicy,
  SsrfBlockedError,
} from "../src/security/ssrf";

test("isPrivateIPv4: classifies RFC1918 / loopback / link-local / CGNAT", () => {
  for (const ip of ["10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateIPv4(ip), true, `${ip} should be private`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "151.101.1.1"]) {
    assert.equal(isPrivateIPv4(ip), false, `${ip} should be public`);
  }
});

test("isAlwaysBlockedIP: metadata + link-local always blocked; loopback is NOT always-blocked (localhost-friendly default)", () => {
  assert.equal(isAlwaysBlockedIP("169.254.169.254"), true, "cloud metadata endpoint");
  assert.equal(isAlwaysBlockedIP("fe80::1"), true, "ipv6 link-local");
  assert.equal(isAlwaysBlockedIP("0.0.0.0"), true, "unspecified");
  assert.equal(isAlwaysBlockedIP("::ffff:169.254.169.254"), true, "ipv4-mapped metadata");
  // loopback is "private" (blockable on opt-in / via allow-list), not always-blocked, so the normal
  // single-box LiteLLM-on-localhost deployment works by default
  assert.equal(isAlwaysBlockedIP("127.0.0.1"), false, "loopback not in always-blocked set");
  assert.equal(isAlwaysBlockedIP("::1"), false, "ipv6 loopback not in always-blocked set");
  assert.equal(isAlwaysBlockedIP("8.8.8.8"), false);
});

test("isPrivateIPv6: loopback / ULA / link-local / mapped", () => {
  assert.equal(isPrivateIPv6("::1"), true);
  assert.equal(isPrivateIPv6("fd00::1"), true);
  assert.equal(isPrivateIPv6("fe80::abcd"), true);
  assert.equal(isPrivateIPv6("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateIPv6("2606:4700:4700::1111"), false, "public dns");
});

test("assertUrlAllowed: blocks metadata IP literal regardless of allow-list", async () => {
  const policy = loadSsrfPolicy({ HARA_SSRF_ALLOW_HOSTS: "169.254.169.254" } as NodeJS.ProcessEnv);
  await assert.rejects(() => assertUrlAllowed("http://169.254.169.254/latest/meta-data/", policy), SsrfBlockedError);
});

test("assertUrlAllowed: rejects non-http(s) schemes", async () => {
  await assert.rejects(() => assertUrlAllowed("file:///etc/passwd"), SsrfBlockedError);
  await assert.rejects(() => assertUrlAllowed("gopher://x/"), SsrfBlockedError);
});

test("assertUrlAllowed: allow-list excludes off-list host", async () => {
  const policy = loadSsrfPolicy({ HARA_SSRF_ALLOW_HOSTS: "litellm.internal,gateway.local" } as NodeJS.ProcessEnv);
  await assert.rejects(() => assertUrlAllowed("https://evil.example.com/x", policy), /not on HARA_SSRF_ALLOW_HOSTS/);
});

test("assertUrlAllowed: loopback refused when blockPrivate on, permitted when explicitly allow-listed", async () => {
  // hardened policy: blockPrivate on → loopback refused
  const open = loadSsrfPolicy({ HARA_SSRF_BLOCK_PRIVATE: "1" } as NodeJS.ProcessEnv);
  await assert.rejects(() => assertUrlAllowed("http://127.0.0.1:4000/key/generate", open), SsrfBlockedError);
  // explicit allow-list permits loopback on purpose (the intentional localhost-LiteLLM case)
  const allowed = loadSsrfPolicy({ HARA_SSRF_ALLOW_HOSTS: "127.0.0.1" } as NodeJS.ProcessEnv);
  await assert.doesNotReject(() => assertUrlAllowed("http://127.0.0.1:4000/key/generate", allowed));
});

test("assertUrlAllowed: default deployment (localhost LiteLLM) works out of the box", async () => {
  const policy = loadSsrfPolicy({} as NodeJS.ProcessEnv); // nothing configured
  await assert.doesNotReject(() => assertUrlAllowed("http://127.0.0.1:4000/key/generate", policy), "localhost LiteLLM not broken by default");
});

test("assertUrlAllowed: default-open lets a public host through (no allow-list, no blockPrivate)", async () => {
  const policy = loadSsrfPolicy({} as NodeJS.ProcessEnv);
  // 8.8.8.8 is public and not always-blocked; should not throw on the IP checks
  await assert.doesNotReject(() => assertUrlAllowed("https://8.8.8.8/", policy));
});

test("assertUrlAllowed: metadata IP always refused even under default-open policy", async () => {
  const policy = loadSsrfPolicy({} as NodeJS.ProcessEnv);
  await assert.rejects(() => assertUrlAllowed("http://169.254.169.254/latest/meta-data/", policy), SsrfBlockedError);
});
