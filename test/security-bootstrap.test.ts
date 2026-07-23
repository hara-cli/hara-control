import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/bootstrap-production-security.mjs");

test("security bootstrap creates distinct non-echoed values and owner-only files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-control-bootstrap-"));
  try {
    const envFile = join(dir, ".env");
    const keyfile = join(dir, "keys", "kms.key");
    writeFileSync(
      envFile,
      [
        "HARA_CONTROL_ADMIN_KEY=existing-admin-value-that-is-long",
        "HARA_JWT_SECRET=__SET_A_DIFFERENT_STRONG_RANDOM__",
        "LITELLM_MASTER_KEY=__SET_A_DISTINCT_STRONG_RANDOM__",
        "GATEWAY_ADAPTER=litellm",
        "DATABASE_URL=postgresql://hara:p%40ss@db.internal:5432/hara?schema=public&sslmode=require",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [script, envFile, keyfile], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /values not displayed/);
    assert.equal(result.stdout.includes("existing-admin"), false);
    const contents = readFileSync(envFile, "utf8");
    const value = (name: string) => contents.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
    assert.equal(value("HARA_CONTROL_ADMIN_KEY"), "existing-admin-value-that-is-long");
    assert.ok(value("HARA_JWT_SECRET"));
    assert.ok(value("LITELLM_MASTER_KEY"));
    assert.equal(new Set([
      value("HARA_CONTROL_ADMIN_KEY"),
      value("HARA_JWT_SECRET"),
      value("LITELLM_MASTER_KEY"),
    ]).size, 3);
    assert.equal(lstatSync(envFile).mode & 0o077, 0);
    assert.equal(lstatSync(keyfile).mode & 0o077, 0);
    assert.equal(Buffer.from(readFileSync(keyfile, "utf8").trim(), "base64").length, 32);
    const litellmUrl = new URL(value("LITELLM_DATABASE_URL")!);
    assert.equal(litellmUrl.searchParams.get("schema"), "litellm");
    assert.equal(litellmUrl.searchParams.get("sslmode"), "require");
    assert.equal(litellmUrl.username, "hara");
    assert.equal(litellmUrl.password, "p%40ss");
    assert.equal(value("HARA_ALLOWED_MODELS"), "deepseek-v4-flash,deepseek-v4-pro");
    assert.equal(value("HARA_DEFAULT_MODEL"), "deepseek-v4-flash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
