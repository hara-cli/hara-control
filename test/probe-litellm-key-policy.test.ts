import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROBE_LIMITS,
  responseConfirmsProbePolicy,
} from "../scripts/probe-litellm-key-policy.mjs";

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
