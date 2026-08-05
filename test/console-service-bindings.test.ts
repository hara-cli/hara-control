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

test("admin console manages organization services without exposing their credential", () => {
  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  const app = readFileSync(join(root, "public", "console", "app.js"), "utf8");
  assert.doesNotThrow(() => new Function(app));
  for (const id of [
    "service-orgid",
    "service-kind",
    "service-mode",
    "service-region",
    "service-origin",
    "service-credential",
    "service-issuer",
    "service-jwks",
    "service-audience",
    "service-save",
    "service-verify",
    "service-disable",
    "service-bindings-list",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(
    html,
    /id="service-credential"[^>]+type="password"[^>]+autocomplete="new-password"/,
  );
  assert.match(app, /\/admin\/orgs\/\$\{encodeURIComponent\(orgId\)\}\/service-bindings/);
  assert.match(app, /body\.credential = \$\("#service-credential"\)\.value/);
  assert.match(app, /\$\("#service-credential"\)\.value = ""/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*service-credential/);
});

test("organization service management copy is complete in every console locale", () => {
  const required = [
    "orgs.services.section",
    "orgs.services.hint",
    "orgs.services.kind.DESK_TASKS",
    "orgs.services.kind.COLLAB",
    "orgs.services.credential.hint",
    "orgs.services.save",
    "orgs.services.verify",
    "orgs.services.disable",
    "orgs.services.status.PENDING_VERIFICATION",
    "orgs.services.status.ACTIVE",
    "orgs.services.saved",
    "orgs.services.verified",
    "orgs.services.disabled",
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"] as const) {
    const entries = dictionary(locale);
    for (const key of required) {
      assert.ok(entries[key], `${locale} is missing ${key}`);
    }
  }
});
