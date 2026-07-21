import { test } from "node:test";
import assert from "node:assert/strict";
import {
  liteLLMKeyDuration,
  liteLLMKeyIssuePayload,
  liteLLMKeyManagementReady,
  liteLLMResponseConfirmsLimits,
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
