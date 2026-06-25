// Device-token discipline unit tests — pure, offline.  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTokenUsable,
  deviceTokenExpiry,
  deviceTokenTtlMinutes,
  deviceSpendCapUsd,
  DEFAULT_DEVICE_TOKEN_TTL_MINUTES,
} from "../src/security/token-discipline";

test("deviceTokenTtlMinutes: default + env override", () => {
  assert.equal(deviceTokenTtlMinutes({} as NodeJS.ProcessEnv), DEFAULT_DEVICE_TOKEN_TTL_MINUTES);
  assert.equal(deviceTokenTtlMinutes({ HARA_DEVICE_TOKEN_TTL_MINUTES: "30" } as NodeJS.ProcessEnv), 30);
  assert.equal(deviceTokenTtlMinutes({ HARA_DEVICE_TOKEN_TTL_MINUTES: "-5" } as NodeJS.ProcessEnv), DEFAULT_DEVICE_TOKEN_TTL_MINUTES, "invalid falls back");
});

test("deviceTokenExpiry: now + ttl", () => {
  const now = new Date("2026-06-25T00:00:00Z");
  const exp = deviceTokenExpiry(now, { HARA_DEVICE_TOKEN_TTL_MINUTES: "60" } as NodeJS.ProcessEnv);
  assert.equal(exp.getTime() - now.getTime(), 60 * 60_000);
});

test("assertTokenUsable: null / revoked rejected", async () => {
  await assert.rejects(() => assertTokenUsable(null), /revoked or unknown/);
  await assert.rejects(() => assertTokenUsable({ revokedAt: new Date() }), /revoked or unknown/);
});

test("assertTokenUsable: expired rejected, future ok, no-expiry (legacy) ok", async () => {
  const now = new Date("2026-06-25T00:00:00Z");
  await assert.rejects(() => assertTokenUsable({ expiresAt: new Date("2026-06-24T23:59:59Z") }, { now }), /expired/);
  await assert.doesNotReject(() => assertTokenUsable({ expiresAt: new Date("2026-06-25T01:00:00Z") }, { now }));
  await assert.doesNotReject(() => assertTokenUsable({ expiresAt: null }, { now }), "legacy token without expiry still works");
});

test("deviceSpendCapUsd: 0 = uncapped by default", () => {
  assert.equal(deviceSpendCapUsd({} as NodeJS.ProcessEnv), 0);
  assert.equal(deviceSpendCapUsd({ HARA_DEVICE_SPEND_CAP_USD: "25" } as NodeJS.ProcessEnv), 25);
});

test("assertTokenUsable: spend cap only enforced with BOTH cap value + checker", async () => {
  const tok = { expiresAt: null };
  // cap set but no checker → hook inert
  await assert.doesNotReject(() =>
    assertTokenUsable(tok, { env: { HARA_DEVICE_SPEND_CAP_USD: "10" } as NodeJS.ProcessEnv }),
  );
  // cap + checker over the cap → rejected
  await assert.rejects(
    () => assertTokenUsable(tok, { env: { HARA_DEVICE_SPEND_CAP_USD: "10" } as NodeJS.ProcessEnv, spendChecker: () => 11 }),
    /spend cap reached/,
  );
  // cap + checker under the cap → ok
  await assert.doesNotReject(() =>
    assertTokenUsable(tok, { env: { HARA_DEVICE_SPEND_CAP_USD: "10" } as NodeJS.ProcessEnv, spendChecker: () => 3 }),
  );
});
