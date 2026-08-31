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

test("operator console exposes a SUPERADMIN-only numbered ticket workflow", () => {
  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");
  const controller = readFileSync(
    join(root, "src", "feedback-tickets", "feedback-tickets.controller.ts"),
    "utf8",
  );

  for (const id of [
    "nav-tickets",
    "view-tickets",
    "ticket-refresh",
    "ticket-status",
    "ticket-kind",
    "ticket-priority",
    "ticket-body",
    "ticket-detail",
    "ticket-timeline",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(app, /\["users", "tickets", "crashes"\]\.includes\(name\)/);
  assert.match(app, /api\("GET", `\/admin\/feedback-tickets\?\$\{query\}`\)/);
  assert.match(app, /api\("PATCH", `\/admin\/feedback-tickets\/\$\{encodeURIComponent\(selectedTicket\.id\)\}`/);
  assert.match(app, /escapeHtml\(row\.title/);
  assert.match(app, /escapeHtml\(entry\.note\)/);
  assert.match(controller, /@Roles\(AdminRole\.SUPERADMIN\)/);
  assert.doesNotThrow(() => new Function(app));
});

test("ticket workflow copy is complete in all console locales", () => {
  const required = [
    "nav.tickets",
    "crumb.tickets",
    "tickets.hint",
    "tickets.status.RECEIVED",
    "tickets.status.ACKNOWLEDGED",
    "tickets.status.IN_PROGRESS",
    "tickets.status.WAITING_RELEASE",
    "tickets.status.WAITING_VERIFICATION",
    "tickets.status.CLOSED",
    "tickets.kind.BUG",
    "tickets.priority.URGENT",
    "tickets.source.FEISHU",
    "tickets.fix_version",
    "tickets.verification",
    "tickets.timeline",
    "tickets.event.CREATED",
    "tickets.event.RELEASED",
    "tickets.event.CLOSED",
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const entries = dictionary(locale);
    for (const key of required) assert.ok(entries[key], `${locale} is missing ${key}`);
  }
});
