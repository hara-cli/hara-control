import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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

test("operator console exposes a SUPERADMIN-only crash report inbox", () => {
  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");

  for (const id of ["nav-crashes", "view-crashes", "crash-refresh", "crash-status", "crash-count", "crash-body"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /\["users", "tickets", "crashes"\]\.includes\(name\)/);
  assert.match(app, /me\.role === "SUPERADMIN"[\s\S]*nav-crashes/);
  assert.match(app, /api\("GET", `\/admin\/crash-reports\?\$\{query\}`\)/);
  const controller = readFileSync(join(root, "src", "crash-reports", "crash-reports.controller.ts"), "utf8");
  assert.match(controller, /@Roles\(AdminRole\.SUPERADMIN\)/);
  assert.match(controller, /@Get\(":id"\)/);
  assert.match(app, /api\("PATCH", `\/admin\/crash-reports\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(app, /api\("POST", `\/admin\/crash-reports\/\$\{encodeURIComponent\(id\)\}\/retry-alert`/);
  assert.match(app, /escapeHtml\(row\.userDescription\)/, "user-authored crash context is escaped");
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*crash/i, "reports never persist in browser storage");
  assert.doesNotThrow(() => new Function(app));
});

test("crash report privacy and workflow copy exists in every console locale", () => {
  const required = [
    "nav.crashes",
    "crumb.crashes",
    "crashes.hint",
    "crashes.privacy.title",
    "crashes.privacy.body",
    "crashes.status.NEW",
    "crashes.status.REVIEWING",
    "crashes.status.RESOLVED",
    "crashes.status.IGNORED",
    "crashes.note.placeholder",
    "crashes.saved",
    "crashes.alert.label",
    "crashes.alert.PENDING",
    "crashes.alert.SENDING",
    "crashes.alert.SENT",
    "crashes.alert.FAILED",
    "crashes.alert.retry",
    "crashes.alert.retried",
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const entries = dictionary(locale);
    for (const key of required) assert.ok(entries[key], `${locale} is missing ${key}`);
  }
});
