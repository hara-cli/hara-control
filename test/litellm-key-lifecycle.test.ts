import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LiteLLMAdapter,
  liteLLMKeyDuration,
  liteLLMKeyIssuePayload,
  liteLLMKeyManagementReady,
  liteLLMResponseConfirmsLimits,
  liteLLMSpendSchemaReady,
  normalizeLiteLLMSpendRows,
} from "../src/gateway/litellm.adapter";

test("liteLLMKeyDuration floors to seconds so the data-plane key does not outlive the requested boundary", () => {
  const now = new Date("2026-07-20T00:00:00.500Z");
  const expiresAt = new Date("2026-07-20T00:01:01.499Z");
  assert.equal(liteLLMKeyDuration(expiresAt, now), "60s");
});

test("liteLLMKeyDuration rejects invalid or elapsed boundaries", () => {
  const now = new Date("2026-07-20T00:00:00Z");
  assert.throws(() => liteLLMKeyDuration(now, now), /future/);
  assert.throws(() => liteLLMKeyDuration(new Date("invalid"), now), /future/);
});

test("LiteLLM readiness exercises the read-only key-management path and fails closed", async () => {
  const calls: string[] = [];
  assert.equal(
    await liteLLMKeyManagementReady(async (path) => {
      calls.push(path);
      return { keys: [] };
    }),
    true,
  );
  assert.deepEqual(calls, ["/key/list?page=1&size=1"]);
  assert.equal(
    await liteLLMKeyManagementReady(async () => {
      throw new Error("schema mismatch");
    }),
    false,
  );
});

test("LiteLLM spend schema readiness fails closed when the shared database path is unavailable", async () => {
  assert.equal(await liteLLMSpendSchemaReady(async () => []), true);
  assert.equal(
    await liteLLMSpendSchemaReady(async () => {
      throw new Error("missing shared schema");
    }),
    false,
  );
});

test("LiteLLM spend rows preserve real zero and mark missing or malformed aliases unavailable", () => {
  assert.deepEqual(
    normalizeLiteLLMSpendRows(
      ["device-1", "device-2", "device-3"],
      [
        { keyId: "device-1", spend: 0 },
        { keyId: "device-2", spend: "1.25" },
        { keyId: "device-3", spend: "not-a-number" },
      ],
    ),
    [
      { keyId: "device-1", spend: 0 },
      { keyId: "device-2", spend: 1.25 },
      { keyId: "device-3", spend: null },
    ],
  );
});

test("LiteLLM spend lookup parameterizes aliases and never converts a database failure to zero", async () => {
  let captured: { sql: string; values: unknown[] } | undefined;
  const adapter = new LiteLLMAdapter({
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      captured = query;
      return [{ keyId: "device-1", spend: 2.5 }];
    },
  } as never);
  assert.deepEqual(await adapter.listSpend(["device-1", "device-2"]), [
    { keyId: "device-1", spend: 2.5 },
    { keyId: "device-2", spend: null },
  ]);
  assert.ok(captured);
  assert.deepEqual(captured.values, ["device-1", "device-2"]);
  assert.doesNotMatch(captured.sql, /device-1|device-2/);

  const unavailable = new LiteLLMAdapter({
    $queryRaw: async () => {
      throw new Error("database unavailable");
    },
  } as never);
  (unavailable as any).log = { warn() {} };
  assert.deepEqual(await unavailable.listSpend(["device-1"]), [{ keyId: "device-1", spend: null }]);
});

test("LiteLLM key generation carries all budget windows and rate limits to the data plane", () => {
  const now = new Date("2026-07-22T00:00:00Z");
  const limits = {
    budgetLimits: [
      { budgetDuration: "5h" as const, maxBudgetUsd: 2 },
      { budgetDuration: "7d" as const, maxBudgetUsd: 20 },
      { budgetDuration: "30d" as const, maxBudgetUsd: 60 },
    ],
    rpmLimit: 30,
    tpmLimit: 120_000,
  };
  assert.deepEqual(
    liteLLMKeyIssuePayload(
      {
        model: "deepseek-chat",
        alias: "device-1",
        expiresAt: new Date("2026-07-29T00:00:00Z"),
        metadata: { orgId: "org-1" },
        limits,
      },
      now,
    ),
    {
      models: ["deepseek-chat"],
      key_alias: "device-1",
      duration: "604800s",
      metadata: { orgId: "org-1" },
      budget_limits: [
        { budget_duration: "5h", max_budget: 2 },
        { budget_duration: "7d", max_budget: 20 },
        { budget_duration: "30d", max_budget: 60 },
      ],
      rpm_limit: 30,
      tpm_limit: 120_000,
    },
  );
  assert.equal(
    liteLLMResponseConfirmsLimits(
      {
        rpm_limit: 30,
        tpm_limit: 120_000,
        budget_limits: [
          { budget_duration: "30d", max_budget: 60, reset_at: "ignored" },
          { budget_duration: "5h", max_budget: 2 },
          { budget_duration: "7d", max_budget: 20 },
        ],
      },
      limits,
    ),
    true,
  );
  assert.equal(
    liteLLMResponseConfirmsLimits(
      { rpm_limit: 30, tpm_limit: 120_000, budget_limits: [{ budget_duration: "5h", max_budget: 2 }] },
      limits,
    ),
    false,
    "missing windows fail closed",
  );
});
