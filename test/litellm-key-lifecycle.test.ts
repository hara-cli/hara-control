import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LiteLLMAdapter,
  liteLLMKeyDuration,
  liteLLMKeyIssuePayload,
  liteLLMKeyManagementReady,
  liteLLMModelPricingReady,
  liteLLMModelsHavePositivePricing,
  liteLLMResponseConfirmsLimits,
  liteLLMSpendSchemaReady,
  normalizeLiteLLMSpendRows,
} from "../src/gateway/litellm.adapter";

const pricedModels = {
  data: [
    {
      model_name: "deepseek-v4-flash",
      model_info: { input_cost_per_token: 0.00000014, output_cost_per_token: 0.00000028 },
    },
    {
      model_name: "deepseek-v4-pro",
      model_info: { input_cost_per_token: 0.000000435, output_cost_per_token: 0.00000087 },
    },
  ],
};

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

test("LiteLLM model pricing requires every deployment behind every budgeted alias to be positive", async () => {
  assert.equal(
    liteLLMModelsHavePositivePricing(pricedModels, ["deepseek-v4-flash", "deepseek-v4-pro"]),
    true,
  );
  assert.equal(liteLLMModelsHavePositivePricing(pricedModels, ["missing-model"]), false);
  assert.equal(
    liteLLMModelsHavePositivePricing(
      {
        data: [
          ...(pricedModels.data as Array<Record<string, unknown>>),
          {
            model_name: "deepseek-v4-flash",
            model_info: { input_cost_per_token: 0, output_cost_per_token: 0.00000028 },
          },
        ],
      },
      ["deepseek-v4-flash"],
    ),
    false,
    "an unpriced duplicate must not create an unmetered routing path",
  );
  assert.equal(
    await liteLLMModelPricingReady(async (path) => {
      assert.equal(path, "/model/info");
      return pricedModels;
    }, ["deepseek-v4-flash"]),
    true,
  );
  assert.equal(
    await liteLLMModelPricingReady(async () => {
      throw new Error("model info unavailable");
    }, ["deepseek-v4-flash"]),
    false,
  );
});

test("LiteLLM refuses a budgeted key before generation when model pricing is unavailable", async () => {
  const adapter = new LiteLLMAdapter({} as never);
  const calls: string[] = [];
  (adapter as any).get = async (path: string) => {
    calls.push(path);
    return {
      data: [{ model_name: "deepseek-v4-flash", model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } }],
    };
  };
  (adapter as any).call = async (path: string) => {
    calls.push(path);
    throw new Error("key generation must not run");
  };

  await assert.rejects(
    adapter.issueKey({
      model: "deepseek-v4-flash",
      alias: "device-unpriced",
      expiresAt: new Date(Date.now() + 60_000),
      limits: {
        budgetLimits: [{ budgetDuration: "5h", maxBudgetUsd: 1 }],
        rpmLimit: null,
        tpmLimit: null,
      },
    }),
    /refusing to issue an unenforceable USD budget/,
  );
  assert.deepEqual(calls, ["/model/info"]);
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
        model: "deepseek-v4-flash",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        alias: "device-1",
        expiresAt: new Date("2026-07-29T00:00:00Z"),
        metadata: { orgId: "org-1" },
        limits,
      },
      now,
    ),
    {
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
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

test("LiteLLM expands an existing device alias in place without requiring the raw virtual key", async () => {
  const hashedToken = "a".repeat(64);
  let reads = 0;
  const adapter = new LiteLLMAdapter({
    $queryRaw: async () => {
      reads += 1;
      return [{
        token: hashedToken,
        models: reads === 1
          ? ["deepseek-v4-flash"]
          : ["deepseek-v4-flash", "deepseek-v4-pro"],
      }];
    },
  } as never);
  const calls: Array<{ path: string; body: unknown }> = [];
  (adapter as any).get = async () => pricedModels;
  (adapter as any).call = async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { models: ["deepseek-v4-flash", "deepseek-v4-pro"] };
  };

  assert.deepEqual(
    await adapter.syncKeyModels("device-1", ["deepseek-v4-flash", "deepseek-v4-pro"]),
    ["deepseek-v4-flash", "deepseek-v4-pro"],
  );
  assert.deepEqual(calls, [{
    path: "/key/update",
    body: {
      key: hashedToken,
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    },
  }]);
  assert.equal(reads, 2, "the authoritative LiteLLM row is verified after update");
});
