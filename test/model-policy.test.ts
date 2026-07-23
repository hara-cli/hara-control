import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedManagedModels,
  canonicalManagedModelId,
  defaultManagedModel,
  managedModelOptions,
  managedModelThinkingEfforts,
  resolveEnrollmentModel,
} from "../src/providers/model-policy";

test("formal enrollment defaults to canonical DeepSeek V4 models with discoverable capabilities", () => {
  const env = { GATEWAY_ADAPTER: "litellm" } as NodeJS.ProcessEnv;
  assert.deepEqual(allowedManagedModels(env), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(defaultManagedModel(env), "deepseek-v4-flash");
  assert.equal(resolveEnrollmentModel("", env), "deepseek-v4-flash");
  assert.deepEqual(managedModelThinkingEfforts("deepseek-v4-flash"), ["off", "high", "max"]);
  assert.deepEqual(managedModelThinkingEfforts("deepseek-pro"), ["off", "high", "max"]);
  assert.deepEqual(managedModelOptions(env), [
    {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      family: "deepseek-v4",
      tier: "flash",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      thinkingEfforts: ["off", "high", "max"],
      isDefault: true,
    },
    {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      family: "deepseek-v4",
      tier: "pro",
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      thinkingEfforts: ["off", "high", "max"],
      isDefault: false,
    },
  ]);
});

test("legacy Hara aliases canonicalize before a new key is issued", () => {
  const env = {
    GATEWAY_ADAPTER: "litellm",
    HARA_ALLOWED_MODELS: "deepseek-chat,deepseek-pro",
    HARA_DEFAULT_MODEL: "deepseek-chat",
  } as NodeJS.ProcessEnv;
  assert.equal(canonicalManagedModelId("deepseek-chat"), "deepseek-v4-flash");
  assert.equal(canonicalManagedModelId("deepseek-pro"), "deepseek-v4-pro");
  assert.equal(canonicalManagedModelId("deepseek-reasoner"), "deepseek-reasoner");
  assert.deepEqual(allowedManagedModels(env), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(defaultManagedModel(env), "deepseek-v4-flash");
  assert.equal(resolveEnrollmentModel("deepseek-pro", env), "deepseek-v4-pro");
  assert.throws(() => resolveEnrollmentModel("deepseek-reasoner", env), /not allowed/);
});

test("formal enrollment rejects models outside the server allow-list", () => {
  const env = {
    GATEWAY_ADAPTER: "litellm",
    HARA_ALLOWED_MODELS: "deepseek-v4-flash,deepseek-v4-pro",
  } as NodeJS.ProcessEnv;
  assert.throws(() => resolveEnrollmentModel("unmanaged-model", env), /not allowed/);
});

test("mock/dev enrollment keeps arbitrary model fixtures backward-compatible", () => {
  assert.equal(
    resolveEnrollmentModel("glm-5", { GATEWAY_ADAPTER: "mock" } as NodeJS.ProcessEnv),
    "glm-5",
  );
  assert.deepEqual(managedModelThinkingEfforts("glm-5"), []);
});
