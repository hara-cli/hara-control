import { test } from "node:test";
import assert from "node:assert/strict";
import { liteLLMKeyDuration } from "../src/gateway/litellm.adapter";

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
