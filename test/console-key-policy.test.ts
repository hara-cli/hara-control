import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const root = join(import.meta.dirname, "..");

function dictionary(locale: "en" | "zh-CN" | "zh-TW"): Record<string, string> {
  const context: Record<string, unknown> = {};
  vm.runInNewContext(
    readFileSync(join(root, "public", "console", "i18n", `${locale}.js`), "utf8"),
    context,
    { filename: `${locale}.js` },
  );
  return (context.HARA_I18N as Record<string, Record<string, string>>)[locale];
}

test("console exposes the internal-key lifetime and all three enforced budget windows in every locale", () => {
  const required = [
    "enroll.policy.title",
    "enroll.policy.token_days",
    "enroll.policy.budgets",
    "enroll.policy.window.5h",
    "enroll.policy.window.week",
    "enroll.policy.window.month",
    "enroll.result.policy",
    "fleet.col.policy",
    "fleet.policy.rates",
    "fleet.policy.rates_unlimited",
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const entries = dictionary(locale);
    for (const key of required) assert.ok(entries[key], `${locale} is missing ${key}`);
  }

  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  for (const id of [
    "ec-token-days",
    "ec-budget-5h",
    "ec-budget-week",
    "ec-budget-month",
    "ec-rpm",
    "ec-tpm",
    "ec-policy-result",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "console element ids must remain unique");
});

test("console JavaScript parses and sends the enforced policy fields to the enroll endpoint", () => {
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");
  assert.doesNotThrow(() => new Function(app));
  for (const field of ["tokenTtlMinutes", "budgetLimits", "rpmLimit", "tpmLimit"]) {
    assert.match(app, new RegExp(`\\b${field}\\b`));
  }
  assert.match(app, /\/admin\/enroll-codes/);
});
