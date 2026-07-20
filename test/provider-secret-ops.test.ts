import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubBootstrapKeyFromEnvFile } from "../src/ops/provider-secret";

test("bootstrap credential scrub atomically blanks only the provider key and preserves private mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-provider-scrub-"));
  try {
    const envFile = join(dir, ".env");
    writeFileSync(
      envFile,
      "DATABASE_URL=postgresql://redacted?schema=public\nUPSTREAM_API_KEY=secret-value\nPORT=4100\n",
      { mode: 0o600 },
    );
    assert.equal(scrubBootstrapKeyFromEnvFile(envFile), true);
    const contents = readFileSync(envFile, "utf8");
    assert.match(contents, /^UPSTREAM_API_KEY=$/m);
    assert.equal(contents.includes("secret-value"), false);
    assert.match(contents, /^PORT=4100$/m);
    assert.equal(lstatSync(envFile).mode & 0o077, 0);
    assert.equal(scrubBootstrapKeyFromEnvFile(envFile), false, "already blank is idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "bootstrap credential scrub refuses a symlink",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "hara-provider-scrub-link-"));
    try {
      const target = join(dir, "target.env");
      const link = join(dir, ".env");
      writeFileSync(target, "UPSTREAM_API_KEY=keep-me\n", { mode: 0o600 });
      symlinkSync(target, link);
      assert.throws(() => scrubBootstrapKeyFromEnvFile(link), /non-symlink/);
      assert.match(readFileSync(target, "utf8"), /keep-me/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
