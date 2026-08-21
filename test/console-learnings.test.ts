import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
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

test("console exposes the organization learning review ledger and bounded evidence UI", () => {
  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  assert.match(html, /href=["']#\/learnings["']/);
  for (const id of [
    "view-learnings",
    "learning-orgid",
    "learning-refresh",
    "learning-review-count",
    "learning-active-count",
    "learning-stable-count",
    "learning-total-count",
    "learning-list",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const filter of ["review", "active", "history", "all"]) {
    assert.match(html, new RegExp(`data-learning-filter=["']${filter}["']`));
  }
});

test("console reviews learning optimistically and never stores evidence in browser storage", () => {
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");
  assert.doesNotThrow(() => new Function(app));
  assert.match(app, /\/admin\/learnings\?orgId=/);
  assert.match(app, /\/admin\/learnings\/\$\{encodeURIComponent\(id\)\}\/review/);
  assert.match(app, /expected_revision:\s*expectedRevision/);
  assert.match(app, /escapeHtml\(item\.summary/);
  assert.match(app, /row\.status === "pending" \|\| Boolean\(row\.pending_summary\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*(?:learning|evidence)/i);
});

test("organization learning copy is complete in every supported locale", () => {
  const required = [
    "nav.learnings",
    "crumb.learnings",
    "learnings.hint",
    "learnings.guardrail.title",
    "learnings.guardrail.body",
    "learnings.kpi.review",
    "learnings.kpi.active",
    "learnings.kpi.stable",
    "learnings.status.pending",
    "learnings.status.approved",
    "learnings.kind.business_rule",
    "learnings.kind.action_ownership",
    "learnings.source.runtime_guard",
    "learnings.action.approve",
    "learnings.action.reject",
    "learnings.action.revoke",
    "learnings.confirm.revoke",
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const entries = dictionary(locale);
    for (const key of required) assert.ok(entries[key], `${locale} is missing ${key}`);
  }
});
