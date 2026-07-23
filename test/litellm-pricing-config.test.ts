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

test("canonical DeepSeek V4 ids pin the per-token prices used by USD budget accounting", () => {
  const flash = modelBlock("deepseek-v4-flash");
  assert.equal(price(flash, "input_cost_per_token") * 1_000_000, 0.14);
  assert.equal(price(flash, "output_cost_per_token") * 1_000_000, 0.28);
  assert.equal(price(flash, "cache_read_input_token_cost") * 1_000_000, 0.0028);

  const pro = modelBlock("deepseek-v4-pro");
  assert.equal(price(pro, "input_cost_per_token") * 1_000_000, 0.435);
  assert.equal(price(pro, "output_cost_per_token") * 1_000_000, 0.87);
  assert.equal(price(pro, "cache_read_input_token_cost") * 1_000_000, 0.003625);
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
