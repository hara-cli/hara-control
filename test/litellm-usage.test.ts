import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LiteLLMAdapter,
  normalizeLiteLLMRollingRows,
  normalizeLiteLLMUsageRows,
} from "../src/gateway/litellm.adapter";
import { parseUsageRange, usageWindow } from "../src/gateway/usage";

test("usage windows are UTC-aligned and contain the requested number of buckets", () => {
  const now = new Date("2026-07-23T12:34:56Z");
  const day = usageWindow(parseUsageRange("24h"), now);
  assert.equal(day.from.toISOString(), "2026-07-22T13:00:00.000Z");
  assert.equal(day.to.toISOString(), "2026-07-23T13:00:00.000Z");
  assert.equal(day.bucketCount, 24);
  assert.equal(day.bucketUnit, "hour");

  const month = usageWindow(parseUsageRange("30d"), now);
  assert.equal(month.from.toISOString(), "2026-06-24T00:00:00.000Z");
  assert.equal(month.to.toISOString(), "2026-07-24T00:00:00.000Z");
  assert.equal(month.bucketCount, 30);
  assert.throws(() => parseUsageRange("year"), /24h, 7d, 30d/);
});

test("LiteLLM usage normalization drops malformed ledger rows instead of inventing values", () => {
  assert.deepEqual(normalizeLiteLLMUsageRows([
    {
      keyId: "alias-1",
      bucketAt: new Date("2026-07-23T10:00:00Z"),
      model: "deepseek-chat",
      spend: "0.001",
      totalTokens: 42,
      requests: "2",
      lastRequestAt: new Date("2026-07-23T10:20:00Z"),
    },
    {
      keyId: "alias-bad",
      bucketAt: "invalid",
      model: "deepseek-chat",
      spend: 0,
      totalTokens: 0,
      requests: 0,
      lastRequestAt: "invalid",
    },
  ]), [{
    keyId: "alias-1",
    bucketAt: new Date("2026-07-23T10:00:00Z"),
    model: "deepseek-chat",
    spend: 0.001,
    totalTokens: 42,
    requests: 2,
    lastRequestAt: new Date("2026-07-23T10:20:00Z"),
  }]);
  assert.deepEqual(normalizeLiteLLMRollingRows([
    { keyId: "alias-1", spend5h: "0.1", spend7d: 0.2, spend30d: 0.3 },
    { keyId: null, spend5h: 0, spend7d: 0, spend30d: 0 },
  ]), [{ keyId: "alias-1", spend5h: 0.1, spend7d: 0.2, spend30d: 0.3 }]);
});

test("LiteLLM usage queries aliases parametrically and returns only safe aggregate fields", async () => {
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const adapter = new LiteLLMAdapter({
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      captured.push(query);
      if (query.sql.includes('AS "bucketAt"')) {
        return [{
          keyId: "alias-1",
          bucketAt: new Date("2026-07-23T10:00:00Z"),
          model: "deepseek-chat",
          spend: 0.001,
          totalTokens: 42,
          requests: 1,
          lastRequestAt: new Date("2026-07-23T10:01:00Z"),
        }];
      }
      return [{ keyId: "alias-1", spend5h: 0.001, spend7d: 0.001, spend30d: 0.001 }];
    },
  } as never);
  const result = await adapter.usage(["alias-1"], "24h", new Date("2026-07-23T12:00:00Z"));
  assert.equal(result.available, true);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.rolling[0].spend5h, 0.001);
  assert.equal(captured.length, 2);
  for (const query of captured) {
    assert.equal(query.values.includes("alias-1"), true);
    assert.doesNotMatch(query.sql, /alias-1/);
    assert.doesNotMatch(query.sql, /messages|response|requester_ip_address/);
    assert.equal(query.values.some((value) => value instanceof Date), false);
    assert.match(query.sql, /::timestamptz AT TIME ZONE 'UTC'/);
  }
  const boundaryValues = captured.flatMap((query) => query.values).filter((value) =>
    typeof value === "string" && value.endsWith("Z"));
  assert.ok(boundaryValues.includes("2026-07-23T07:00:00.000Z"), "5-hour UTC boundary must remain an instant");
  assert.ok(boundaryValues.includes("2026-07-23T13:00:00.000Z"), "range end must remain UTC");
});

test("LiteLLM usage marks the ledger unavailable instead of returning false zeroes", async () => {
  const adapter = new LiteLLMAdapter({
    $queryRaw: async () => {
      throw new Error("ledger unavailable");
    },
  } as never);
  (adapter as any).log = { warn() {} };
  assert.deepEqual(
    await adapter.usage(["alias-1"], "7d", new Date("2026-07-23T12:00:00Z")),
    { available: false, buckets: [], rolling: [] },
  );
});
