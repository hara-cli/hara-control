import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminService } from "../src/admin/admin.service";

test("admin usage aggregates time buckets, device/model breakdown, and rolling quota progress", async () => {
  const now = new Date("2026-07-23T12:30:00Z");
  const prisma = {
    device: {
      findMany: async () => [{
        id: "device-1",
        name: "Winter Mac",
        lastSeenAt: new Date("2026-07-23T12:20:00Z"),
        person: { name: "冬芹", email: "tester@example.test" },
        tokens: [{
          gatewayKeyId: "alias-1",
          model: "deepseek-chat",
          createdAt: new Date("2026-07-22T00:00:00Z"),
          expiresAt: new Date("2026-07-30T00:00:00Z"),
          revokedAt: null,
          budgetLimits: [
            { window: "5h", maxUsd: 1, budgetDuration: "5h" },
            { window: "week", maxUsd: 5, budgetDuration: "7d" },
            { window: "month", maxUsd: 15, budgetDuration: "30d" },
          ],
          rpmLimit: 30,
          tpmLimit: 200_000,
        }],
      }],
    },
  };
  const gateway = {
    usage: async () => ({
      available: true,
      buckets: [{
        keyId: "alias-1",
        bucketAt: new Date("2026-07-23T10:00:00Z"),
        model: "deepseek-v4-flash",
        spend: 0.25,
        totalTokens: 1200,
        requests: 3,
        lastRequestAt: new Date("2026-07-23T10:40:00Z"),
      }],
      rolling: [{ keyId: "alias-1", spend5h: 0.25, spend7d: 0.5, spend30d: 1.5 }],
    }),
  };
  const service = new AdminService(prisma as never, {} as never, {} as never, gateway as never);
  const report = await service.usage("org-1", "24h", now);

  assert.equal(report.available, true);
  assert.deepEqual(report.totals, {
    spend: 0.25,
    totalTokens: 1200,
    requests: 3,
    latestRequestAt: new Date("2026-07-23T10:40:00Z"),
  });
  assert.equal(report.series.length, 24);
  assert.deepEqual(report.series.find((row) => row.at.toISOString() === "2026-07-23T10:00:00.000Z"), {
    at: new Date("2026-07-23T10:00:00Z"),
    spend: 0.25,
    totalTokens: 1200,
    requests: 3,
  });
  assert.deepEqual(report.breakdown[0], {
    deviceId: "device-1",
    deviceName: "Winter Mac",
    principal: "冬芹",
    model: "deepseek-v4-flash",
    spend: 0.25,
    totalTokens: 1200,
    requests: 3,
    lastRequestAt: new Date("2026-07-23T10:40:00Z"),
  });
  assert.equal(report.quotas[0].limits[0].usedUsd, 0.25);
  assert.equal(report.quotas[0].limits[0].percent, 25);
  assert.equal(report.quotas[0].limits[2].remainingUsd, 13.5);
});

test("admin usage preserves unavailable ledger state while still returning configured limits", async () => {
  const prisma = {
    device: {
      findMany: async () => [{
        id: "device-1",
        name: "Mac",
        lastSeenAt: new Date(),
        person: null,
        tokens: [{
          gatewayKeyId: "alias-1",
          model: "deepseek-chat",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
          budgetLimits: [{ window: "5h", maxUsd: 1 }],
          rpmLimit: null,
          tpmLimit: null,
        }],
      }],
    },
  };
  const gateway = { usage: async () => ({ available: false, buckets: [], rolling: [] }) };
  const service = new AdminService(prisma as never, {} as never, {} as never, gateway as never);
  const report = await service.usage("org-1", "7d");
  assert.equal(report.available, false);
  assert.equal(report.totals.spend, null);
  assert.deepEqual(report.series, []);
  assert.equal(report.quotas[0].limits[0].usedUsd, null);
});

test("admin usage includes revoked keys in historical breakdown but not active quota runway", async () => {
  const now = new Date("2026-09-02T12:00:00Z");
  const prisma = {
    device: {
      findMany: async () => [{
        id: "device-old",
        name: "Former key",
        lastSeenAt: new Date("2026-09-01T12:00:00Z"),
        person: { name: "同事", email: "member@example.test" },
        tokens: [{
          gatewayKeyId: "revoked-alias",
          model: "deepseek-v4-flash",
          createdAt: new Date("2026-09-01T00:00:00Z"),
          expiresAt: null,
          revokedAt: new Date("2026-09-02T00:00:00Z"),
          budgetLimits: [{ window: "month", maxUsd: 100 }],
          rpmLimit: null,
          tpmLimit: null,
        }],
      }],
    },
  };
  const gateway = {
    usage: async (keyIds: string[]) => {
      assert.deepEqual(keyIds, ["revoked-alias"]);
      return {
        available: true,
        buckets: [{
          keyId: "revoked-alias",
          bucketAt: new Date("2026-09-02T10:00:00Z"),
          model: "deepseek-v4-flash",
          spend: 0.4,
          totalTokens: 900,
          requests: 2,
          lastRequestAt: new Date("2026-09-02T10:30:00Z"),
        }],
        rolling: [{ keyId: "revoked-alias", spend5h: 0.4, spend7d: 0.4, spend30d: 0.4 }],
      };
    },
  };
  const service = new AdminService(prisma as never, {} as never, {} as never, gateway as never);
  const report = await service.usage("org-1", "24h", now);
  assert.equal(report.totals.spend, 0.4);
  assert.equal(report.breakdown[0].deviceId, "device-old");
  assert.deepEqual(report.quotas, []);
});
