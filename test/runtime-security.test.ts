import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProductionRuntime } from "../src/config/runtime-security";

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  HARA_ENV_LOADED: "1",
  DATABASE_URL: "postgresql://user:redacted@db/hara?schema=public",
  HARA_CONTROL_ADMIN_KEY: "a".repeat(32),
  HARA_JWT_SECRET: "j".repeat(32),
  HARA_KMS_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  GATEWAY_ADAPTER: "litellm",
  LITELLM_URL: "http://127.0.0.1:4000",
  LITELLM_MASTER_KEY: `sk-${"m".repeat(32)}`,
  LITELLM_DATABASE_URL: "postgresql://user:redacted@db/hara?schema=litellm",
};

test("production runtime accepts a preflighted, separated configuration", () => {
  assert.doesNotThrow(() => assertProductionRuntime({ ...valid }));
  assert.doesNotThrow(() => assertProductionRuntime({ ...valid, HARA_ENV_LOADED: "container" }));
  assert.doesNotThrow(() => assertProductionRuntime({
    ...valid,
    HARA_FEEDBACK_INTAKE_KEY: "feedback-abcdefghijklmnopqrstuvwxyz",
  }));
  const dir = mkdtempSync(join(tmpdir(), "hara-feedback-key-"));
  try {
    const keyfile = join(dir, "feedback.key");
    writeFileSync(keyfile, "feedback-file-abcdefghijklmnopqrstuvwxyz", { mode: 0o600 });
    assert.doesNotThrow(() => assertProductionRuntime({
      ...valid,
      HARA_FEEDBACK_INTAKE_KEYFILE: keyfile,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production runtime rejects deploy-script bypass and reused signing/admin secrets", () => {
  assert.throws(
    () => assertProductionRuntime({ ...valid, HARA_ENV_LOADED: undefined }),
    /with-production-env/,
  );
  assert.throws(
    () => assertProductionRuntime({ ...valid, HARA_JWT_SECRET: valid.HARA_CONTROL_ADMIN_KEY }),
    /must be different/,
  );
  assert.throws(
    () => assertProductionRuntime({ ...valid, DATABASE_URL: "postgresql://db/hara" }),
    /schema=public/,
  );
  assert.throws(
    () => assertProductionRuntime({ ...valid, LITELLM_URL: "https://gateway.example" }),
    /loopback/,
  );
  assert.throws(
    () => assertProductionRuntime({ ...valid, HARA_KMS_MASTER_KEY: "too-short" }),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => assertProductionRuntime({ ...valid, HARA_FEEDBACK_INTAKE_KEY: "short" }),
    /feedback intake credential is too short/,
  );
  assert.throws(
    () => assertProductionRuntime({
      ...valid,
      HARA_FEEDBACK_INTAKE_KEY: valid.HARA_JWT_SECRET,
    }),
    /must be independent/,
  );
  assert.throws(
    () => assertProductionRuntime({
      ...valid,
      HARA_FEEDBACK_INTAKE_KEY: valid.HARA_KMS_MASTER_KEY,
    }),
    /KMS master key/,
  );
});

test("production runtime requires a complete, independent crash alert configuration", () => {
  assert.throws(
    () => assertProductionRuntime({ ...valid, HARA_CRASH_FEISHU_APP_ID: "cli_valid123" }),
    /all four/,
  );
  const alertEnv = {
    ...valid,
    HARA_CRASH_FEISHU_APP_ID: "cli_valid123",
    HARA_CRASH_FEISHU_APP_SECRET: "f".repeat(32),
    HARA_CRASH_FEISHU_CHAT_ID: "oc_17590648f393135cde6a6b9cd6f1c710",
    HARA_CRASH_FEISHU_MENTION_OPEN_ID: "ou_32b2bd011e81f02315e58c707949fbb5",
  };
  assert.doesNotThrow(() => assertProductionRuntime(alertEnv));
  assert.throws(
    () => assertProductionRuntime({
      ...alertEnv,
      HARA_CRASH_FEISHU_APP_SECRET: valid.HARA_JWT_SECRET,
    }),
    /independent/,
  );
});

test("development/test runtime remains zero-config", () => {
  assert.doesNotThrow(() => assertProductionRuntime({ NODE_ENV: "test" }));
});
