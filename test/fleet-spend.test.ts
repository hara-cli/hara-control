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
