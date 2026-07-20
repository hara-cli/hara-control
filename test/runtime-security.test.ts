import { test } from "node:test";
import assert from "node:assert/strict";
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
});

test("development/test runtime remains zero-config", () => {
  assert.doesNotThrow(() => assertProductionRuntime({ NODE_ENV: "test" }));
});
