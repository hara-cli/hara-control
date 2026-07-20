import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/with-production-env.mjs");
const deployScript = resolve("deploy/nanhara-tech/deploy-ai-rds.sh");

function withTemp(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hara-control-env-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validEnv(dir: string): string {
  const keyfile = join(dir, "kms.key");
  writeFileSync(keyfile, Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "NODE_ENV=production",
      "DATABASE_URL=postgresql://user:password@db.invalid/hara?schema=public",
      "HARA_CONTROL_ADMIN_KEY=admin-abcdefghijklmnopqrstuvwxyz",
      "HARA_JWT_SECRET=jwt-abcdefghijklmnopqrstuvwxyz0123",
      `HARA_KMS_KEYFILE=${keyfile}`,
      "GATEWAY_ADAPTER=litellm",
      "LITELLM_URL=http://127.0.0.1:4000",
      "LITELLM_MASTER_KEY=master-abcdefghijklmnopqrstuvwxyz",
      "LITELLM_DATABASE_URL=postgresql://user:password@db.invalid/hara?schema=litellm",
      "UPSTREAM_API_KEY=sk-deepseek-abcdefghijklmnopqrstuvwxyz",
    ].join("\n"),
    { mode: 0o600 },
  );
  return envFile;
}

test("production wrapper parses values as data and launches the command with checked env", () => {
  withTemp((dir) => {
    const envFile = validEnv(dir);
    const result = spawnSync(
      process.execPath,
      [script, envFile, "--", process.execPath, "-e", "process.stdout.write(process.env.HARA_ENV_LOADED || '')"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "1");
  });
});

test("production wrapper rejects broad env permissions before reading/launching", () => {
  withTemp((dir) => {
    const envFile = validEnv(dir);
    chmodSync(envFile, 0o644);
    const result = spawnSync(process.execPath, [script, envFile, "--", process.execPath, "-e", ""], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /chmod 600/);
  });
});

test("production wrapper rejects shell syntax instead of executing it", () => {
  withTemp((dir) => {
    const envFile = validEnv(dir);
    writeFileSync(envFile, "export MALICIOUS=$(touch should-never-run)\n", { mode: 0o600 });
    const result = spawnSync(process.execPath, [script, envFile, "--", process.execPath, "-e", ""], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must use NAME=value/);
  });
});

test("production wrapper rejects a LiteLLM database URL that can touch the control schema", () => {
  withTemp((dir) => {
    const envFile = validEnv(dir);
    const unsafe = readFileSync(envFile, "utf8").replace(
      "LITELLM_DATABASE_URL=postgresql://user:password@db.invalid/hara?schema=litellm",
      "LITELLM_DATABASE_URL=postgresql://user:password@db.invalid/hara?schema=public",
    );
    writeFileSync(envFile, unsafe, { mode: 0o600 });
    const result = spawnSync(process.execPath, [script, envFile, "--", process.execPath, "-e", ""], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LITELLM_DATABASE_URL.*schema=litellm/);
  });
});

test("production deploy replaces the canonical existing LiteLLM PM2 process", () => {
  const source = readFileSync(deployScript, "utf8");
  assert.match(
    source,
    /LITELLM_PM2_NAME="\$\{LITELLM_PM2_NAME:-hara-litellm\}"/,
    "the default must match the existing production process identity",
  );
  assert.match(
    source,
    /pm2_clean delete "\$LITELLM_PM2_NAME"/,
    "the old provider-bearing definition must be deleted before replacement",
  );
});
