import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gatewayLimits,
  normalizeAccessKeyPolicy,
  parseStoredAccessKeyPolicy,
} from "../src/gateway/key-policy";

test("access-key policy normalizes the three independent rolling budget windows", () => {
  const policy = normalizeAccessKeyPolicy(
    {
      tokenTtlMinutes: 43_200,
      budgetLimits: [
        { window: "month", maxUsd: 120 },
        { window: "5h", maxUsd: 3.5 },
        { window: "week", maxUsd: 35 },
      ],
      rpmLimit: 80,
      tpmLimit: 250_000,
    },
    10_080,
  );

  assert.deepEqual(gatewayLimits(policy), {
    budgetLimits: [
      { budgetDuration: "30d", maxBudgetUsd: 120 },
      { budgetDuration: "5h", maxBudgetUsd: 3.5 },
      { budgetDuration: "7d", maxBudgetUsd: 35 },
    ],
    rpmLimit: 80,
    tpmLimit: 250_000,
  });
});

test("access-key policy rejects duplicate, invalid, or unsafe limits", () => {
  assert.throws(
    () => normalizeAccessKeyPolicy({ budgetLimits: [{ window: "5h", maxUsd: 1 }, { window: "5h", maxUsd: 2 }] }, 10_080),
    /duplicate/,
  );
  assert.throws(() => normalizeAccessKeyPolicy({ tokenTtlMinutes: 1 }, 10_080), /tokenTtlMinutes/);
  assert.throws(() => normalizeAccessKeyPolicy({ rpmLimit: 1.5 }, 10_080), /rpmLimit/);
  assert.throws(() => normalizeAccessKeyPolicy({ budgetLimits: [{ window: "week", maxUsd: 0 }] }, 10_080), /maxUsd/);
});

test("stored access-key policy ignores untrusted duration text and recomputes the canonical window", () => {
  const policy = parseStoredAccessKeyPolicy(
    {
      tokenTtlMinutes: 1_440,
      budgetLimits: [{ window: "week", maxUsd: 12, budgetDuration: "999y" }],
      rpmLimit: null,
      tpmLimit: null,
    },
    10_080,
  );
  assert.equal(policy.budgetLimits[0].budgetDuration, "7d");
});
