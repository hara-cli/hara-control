import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const helper = join(import.meta.dirname, "..", "scripts", "run-with-timeout.mjs");

test("bounded command preserves a successful exit code", () => {
  const result = spawnSync(process.execPath, [helper, "2", process.execPath, "-e", "process.exit(0)"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("bounded command terminates the child process group and returns 124", () => {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [helper, "0.1", process.execPath, "-e", "setTimeout(() => {}, 10000)"],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /exceeded 0\.1s/);
  assert.ok(Date.now() - startedAt < 3_000, "timeout wrapper must not leave the child running");
});
