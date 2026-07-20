import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedManagedModels,
  defaultManagedModel,
  resolveEnrollmentModel,
} from "../src/providers/model-policy";

test("formal enrollment resolves an empty legacy/model input to a scoped DeepSeek alias", () => {
  const env = { GATEWAY_ADAPTER: "litellm" } as NodeJS.ProcessEnv;
  assert.deepEqual(allowedManagedModels(env), ["deepseek-chat", "deepseek-pro"]);
  assert.equal(defaultManagedModel(env), "deepseek-chat");
  assert.equal(resolveEnrollmentModel("", env), "deepseek-chat");
});

test("formal enrollment rejects models outside the server allow-list", () => {
  const env = {
    GATEWAY_ADAPTER: "litellm",
    HARA_ALLOWED_MODELS: "deepseek-chat,deepseek-pro",
  } as NodeJS.ProcessEnv;
  assert.throws(() => resolveEnrollmentModel("unmanaged-model", env), /not allowed/);
});

test("mock/dev enrollment keeps arbitrary model fixtures backward-compatible", () => {
  assert.equal(
    resolveEnrollmentModel("glm-5", { GATEWAY_ADAPTER: "mock" } as NodeJS.ProcessEnv),
    "glm-5",
  );
});
