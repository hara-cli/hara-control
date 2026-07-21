import { test } from "node:test";
import assert from "node:assert/strict";
import {
  liteLLMKeyDuration,
  liteLLMKeyManagementReady,
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
