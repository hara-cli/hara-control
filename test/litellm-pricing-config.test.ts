import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = readFileSync(resolve("litellm/config.yaml"), "utf8");

function modelBlock(model: string): string {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = config.match(new RegExp(`\\n  - model_name: ${escaped}\\n([\\s\\S]*?)(?=\\n  - model_name:|\\nlitellm_settings:)`));
  assert.ok(match, `missing LiteLLM model ${model}`);
  return match[1];
}

function price(block: string, field: string): number {
  const match = block.match(new RegExp(`^\\s+${field}:\\s+([0-9.]+)\\s*$`, "m"));
  assert.ok(match, `missing ${field}`);
  return Number(match[1]);
}

function pricePerMillion(block: string, field: string): number {
  return Number((price(block, field) * 1_000_000).toFixed(6));
}

test("canonical DeepSeek V4 ids pin the per-token prices used by USD budget accounting", () => {
  const flash = modelBlock("deepseek-v4-flash");
  assert.equal(pricePerMillion(flash, "input_cost_per_token"), 0.44);
  assert.equal(pricePerMillion(flash, "output_cost_per_token"), 1.32);
  assert.equal(pricePerMillion(flash, "cache_read_input_token_cost"), 0.014);

  const pro = modelBlock("deepseek-v4-pro");
  assert.equal(pricePerMillion(pro, "input_cost_per_token"), 1.32);
  assert.equal(pricePerMillion(pro, "output_cost_per_token"), 3.96);
  assert.equal(pricePerMillion(pro, "cache_read_input_token_cost"), 0.044);

  const vision = modelBlock("deepseek-v4-flash-vision-exp");
  assert.equal(pricePerMillion(vision, "input_cost_per_token"), 0.44);
  assert.equal(pricePerMillion(vision, "output_cost_per_token"), 1.32);
  assert.equal(pricePerMillion(vision, "cache_read_input_token_cost"), 0.014);
});

test("legacy Hara aliases remain priced compatibility routes for already-issued keys", () => {
  for (const alias of ["deepseek-chat", "deepseek-pro"]) {
    const block = modelBlock(alias);
    assert.ok(price(block, "input_cost_per_token") > 0);
    assert.ok(price(block, "output_cost_per_token") > 0);
  }
});

test("the mock model has synthetic positive pricing so the live E2E exercises spend accounting", () => {
  const mock = modelBlock("glm-mock");
  assert.ok(price(mock, "input_cost_per_token") > 0);
  assert.ok(price(mock, "output_cost_per_token") > 0);
});

test("every managed DeepSeek route uses the native adapter and transparently relays thinking controls", () => {
  for (const model of [
    "glm-mock",
    "glm-mock-pro",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
    "deepseek-chat",
    "deepseek-pro",
  ]) {
    const block = modelBlock(model);
    assert.match(block, /^\s+model:\s+deepseek\//m, `${model} must use LiteLLM's DeepSeek adapter`);
    assert.match(
      block,
      /^\s+allowed_openai_params:\s*\[thinking, reasoning_effort\]\s*$/m,
      `${model} must preserve native DeepSeek thinking controls`,
    );
  }
});

test("the visual route documents the deployment patch that preserves image blocks", () => {
  const vision = modelBlock("deepseek-v4-flash-vision-exp");
  assert.match(vision, /byte-checked/);
  assert.match(vision, /retains image_url blocks/);
});
