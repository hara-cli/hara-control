import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROBE_LIMITS,
  responseConfirmsProbePolicy,
} from "../scripts/probe-litellm-key-policy.mjs";
import { budgetsMatch, EXPECTED_BUDGETS } from "./e2e-litellm.mjs";

test("production policy probe requires all three budget windows and both rate limits", () => {
  assert.equal(responseConfirmsProbePolicy({
    rpm_limit: PROBE_LIMITS.rpmLimit,
    tpm_limit: PROBE_LIMITS.tpmLimit,
    budget_limits: [...PROBE_LIMITS.budgetLimits].reverse(),
  }), true);

  assert.equal(responseConfirmsProbePolicy({
    rpm_limit: PROBE_LIMITS.rpmLimit,
    tpm_limit: PROBE_LIMITS.tpmLimit,
    budget_limits: PROBE_LIMITS.budgetLimits.slice(0, 2),
  }), false);
  assert.equal(responseConfirmsProbePolicy({
    rpm_limit: PROBE_LIMITS.rpmLimit + 1,
    tpm_limit: PROBE_LIMITS.tpmLimit,
    budget_limits: PROBE_LIMITS.budgetLimits,
  }), false);
});

test("LiteLLM E2E compares JSONB budget policy semantically instead of by object key order", () => {
  const reorderedKeys = [...EXPECTED_BUDGETS].reverse().map((entry) => ({
    budgetDuration: entry.budgetDuration,
    maxUsd: entry.maxUsd,
    window: entry.window,
  }));
  assert.equal(budgetsMatch(reorderedKeys), true);
  assert.equal(budgetsMatch(reorderedKeys.slice(0, 2)), false);
  assert.equal(
    budgetsMatch(reorderedKeys.map((entry, index) => index === 0 ? { ...entry, maxUsd: entry.maxUsd + 1 } : entry)),
    false,
  );
});
