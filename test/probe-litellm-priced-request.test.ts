import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRICED_PROBE_POLICY,
  positiveSpendRecorded,
  probeLiteLLMPricedRequest,
  responseConfirmsPricedProbePolicy,
} from "../scripts/probe-litellm-priced-request.mjs";

test("priced-request probe requires both token activity and positive aggregate/log spend", () => {
  assert.equal(positiveSpendRecorded({ verificationSpend: 0.001, logSpend: 0.001, logCount: 1, totalTokens: 12 }), true);
  assert.equal(positiveSpendRecorded({ verificationSpend: 0, logSpend: 0.001, logCount: 1, totalTokens: 12 }), false);
  assert.equal(positiveSpendRecorded({ verificationSpend: 0.001, logSpend: 0, logCount: 1, totalTokens: 12 }), false);
  assert.equal(positiveSpendRecorded(null), false);
});

test("priced-request probe requires all rolling budgets and both rate limits", () => {
  assert.equal(responseConfirmsPricedProbePolicy({
    rpm_limit: PRICED_PROBE_POLICY.rpmLimit,
    tpm_limit: PRICED_PROBE_POLICY.tpmLimit,
    budget_limits: [...PRICED_PROBE_POLICY.budgetLimits].reverse(),
  }), true);
  assert.equal(responseConfirmsPricedProbePolicy({
    rpm_limit: PRICED_PROBE_POLICY.rpmLimit,
    tpm_limit: PRICED_PROBE_POLICY.tpmLimit,
    budget_limits: PRICED_PROBE_POLICY.budgetLimits.slice(1),
  }), false);
});

test("priced-request probe sends one temporary-key request, verifies spend, and deletes the alias", async () => {
  const paths: string[] = [];
  let queryAlias = "";
  const result = await probeLiteLLMPricedRequest(
    {
      LITELLM_URL: "http://127.0.0.1:4000",
      LITELLM_MASTER_KEY: "synthetic-master-key-for-test",
      DATABASE_URL: "postgresql://synthetic/test?schema=public",
    } as NodeJS.ProcessEnv,
    {
      fetchImpl: async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        paths.push(path);
        if (path === "/key/generate") return Response.json({
          key: "sk-synthetic-temporary",
          rpm_limit: PRICED_PROBE_POLICY.rpmLimit,
          tpm_limit: PRICED_PROBE_POLICY.tpmLimit,
          budget_limits: PRICED_PROBE_POLICY.budgetLimits,
        });
        if (path === "/v1/chat/completions") return Response.json({ choices: [] });
        if (path === "/key/delete") return Response.json({ deleted_keys: 1 });
        return new Response(null, { status: 404 });
      },
      prisma: {
        $queryRawUnsafe: async (_query: string, alias: string) => {
          queryAlias = alias;
          return [{ verificationSpend: 0.00001, logSpend: 0.00001, logCount: 1, totalTokens: 8 }];
        },
      },
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(paths, ["/key/generate", "/v1/chat/completions", "/key/delete"]);
  assert.match(queryAlias, /^hara-priced-probe-/);
  assert.deepEqual(result, { logCount: 1, totalTokens: 8, spendPositive: true });
});

test("priced-request probe refuses to send a master credential to a remote URL", async () => {
  await assert.rejects(
    probeLiteLLMPricedRequest({
      LITELLM_URL: "https://gateway.example.com",
      LITELLM_MASTER_KEY: "synthetic-master-key-for-test",
      DATABASE_URL: "postgresql://synthetic/test?schema=public",
    } as NodeJS.ProcessEnv),
    /non-local/,
  );
});
