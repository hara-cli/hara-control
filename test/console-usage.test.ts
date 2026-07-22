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

test("console usage dashboard exposes its route, controls, chart, quota, and breakdown hosts", () => {
  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  assert.match(html, /href=["']#\/usage["']/);
  for (const id of [
    "view-usage",
    "usage-orgid",
    "usage-refresh",
    "usage-unavailable",
    "usage-total-spend",
    "usage-total-tokens",
    "usage-total-requests",
    "usage-chart",
    "usage-quotas",
    "usage-breakdown",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const range of ["24h", "7d", "30d"]) {
    assert.match(html, new RegExp(`data-usage-range=["']${range}["']`));
  }
});

test("console usage dashboard loads the authoritative endpoint and never labels unavailable data as zero", () => {
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");
  assert.doesNotThrow(() => new Function(app));
  assert.match(app, /\/admin\/usage\?orgId=/);
  assert.match(app, /report\.available === true/);
  assert.match(app, /usage-unavailable/);
  assert.match(app, /available \? formatMoney\(totals\.spend\) : ["']—["']/);
});

test("console usage copy is complete in every supported locale", () => {
  const required = [
    "nav.usage",
    "crumb.usage",
    "usage.hint",
    "usage.org",
    "usage.range.24h",
    "usage.range.7d",
    "usage.range.30d",
    "usage.unavailable",
    "usage.kpi.spend",
    "usage.kpi.tokens",
    "usage.kpi.requests",
    "usage.chart.title",
    "usage.quota.title",
    "usage.quota.value",
    "usage.breakdown.title",
    "usage.empty.no_activity",
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const entries = dictionary(locale);
    for (const key of required) assert.ok(entries[key], `${locale} is missing ${key}`);
  }
});

test("console sends the documented parentId field when creating nested organizations", () => {
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");
  assert.match(app, /const body = parentId \? \{ name, type, parentId \}/);
  assert.doesNotMatch(app, /parentOrgId/);
});
