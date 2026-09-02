import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AdminService } from "../src/admin/admin.service";

function serviceWithSpend(spend: number | null) {
  const token = {
    gatewayKeyId: "device-alias-1",
    revokedAt: null,
    expiresAt: new Date("2026-07-23T00:00:00Z"),
    model: "deepseek-chat",
    budgetLimits: [],
    rpmLimit: null,
    tpmLimit: null,
  };
  const prisma = {
    device: {
      findMany: async () => [{
        id: "device-1",
        name: "probe",
        os: "darwin",
        haraVersion: "0.1.10",
        lastSeenAt: new Date("2026-07-22T00:00:00Z"),
        tokens: [token],
      }],
    },
  };
  const gateway = {
    listSpend: async () => [{ keyId: token.gatewayKeyId, spend }],
  };
  return new AdminService(prisma as never, {} as never, {} as never, gateway as never);
}

test("fleet distinguishes an authoritative zero from unavailable spend", async () => {
  const now = new Date("2026-07-22T00:01:00Z");
  const zero = (await serviceWithSpend(0).fleet("org-1", now))[0];
  assert.equal(zero.spend, 0);
  assert.equal(zero.spend_available, true);

  const unavailable = (await serviceWithSpend(null).fleet("org-1", now))[0];
  assert.equal(unavailable.spend, null);
  assert.equal(unavailable.spend_available, false);
});

test("console translations render unavailable spend instead of a false $0.00", () => {
  const app = readFileSync(resolve("public/console/app.js"), "utf8");
  assert.match(app, /spend_available === true/);
  assert.match(app, /fleet\.spend\.unavailable/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = readFileSync(resolve(`public/console/i18n/${locale}.js`), "utf8");
    assert.match(messages, /"fleet\.spend\.unavailable"/);
  }
});

test("fleet preserves revoked key records and their lifetime spend without reactivating them", async () => {
  const revokedAt = new Date("2026-09-02T00:00:00Z");
  const prisma = {
    device: {
      findMany: async () => [{
        id: "device-1",
        name: "old-device",
        os: "darwin",
        haraVersion: "0.163.0",
        lastSeenAt: new Date("2026-09-01T00:00:00Z"),
        tokens: [{
          gatewayKeyId: "revoked-alias",
          revokedAt,
          expiresAt: null,
          createdAt: new Date("2026-08-01T00:00:00Z"),
          model: "deepseek-v4-flash",
          reasoningEffort: "high",
          budgetLimits: [{ window: "month", maxUsd: 100 }],
          rpmLimit: null,
          tpmLimit: null,
        }],
      }],
    },
  };
  const gateway = {
    listSpend: async (keyIds: string[]) => {
      assert.deepEqual(keyIds, ["revoked-alias"]);
      return [{ keyId: "revoked-alias", spend: 2.5 }];
    },
  };
  const service = new AdminService(prisma as never, {} as never, {} as never, gateway as never);
  const row = (await service.fleet("org-1", new Date("2026-09-02T12:00:00Z")))[0];
  assert.equal(row.token_active, false);
  assert.equal(row.model, "deepseek-v4-flash");
  assert.equal(row.spend, 2.5);
  assert.equal(row.spend_available, true);
  assert.equal(row.keys[0].status, "revoked");
  assert.equal(row.keys[0].revoked_at, revokedAt);
  assert.equal(row.keys[0].spend, 2.5);
});

test("console exposes translated revoked key history instead of hiding deleted gateway rows", () => {
  const app = readFileSync(resolve("public/console/app.js"), "utf8");
  assert.match(app, /renderFleetKeys/);
  assert.match(app, /fleet\.key\.status\.\$\{status/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = readFileSync(resolve(`public/console/i18n/${locale}.js`), "utf8");
    assert.match(messages, /"fleet\.col\.keys"/);
    assert.match(messages, /"fleet\.key\.revoked_at"/);
  }
});
