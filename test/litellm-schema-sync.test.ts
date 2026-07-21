import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertIsolatedLiteLLMDatabase,
  assertNonDestructiveSchemaPlan,
  isEmptySchemaPlan,
  prismaChildEnv,
} from "../scripts/sync-litellm-schema.mjs";

test("LiteLLM schema sync requires one database and an isolated litellm schema", () => {
  const control = "postgresql://user:secret@db.internal:5432/hara?schema=public";
  const liteLlm = "postgresql://user:secret@db.internal:5432/hara?schema=litellm";
  assert.equal(assertIsolatedLiteLLMDatabase(control, liteLlm), liteLlm);
  assert.throws(
    () => assertIsolatedLiteLLMDatabase(control, "postgresql://user:secret@other/hara?schema=litellm"),
    /same host/,
  );
  assert.throws(
    () => assertIsolatedLiteLLMDatabase(control, "postgresql://user:secret@db.internal:5432/hara?schema=public"),
    /schema=litellm/,
  );
});

test("LiteLLM schema sync rejects destructive plans before db push", () => {
  assert.doesNotThrow(() =>
    assertNonDestructiveSchemaPlan(
      'ALTER TABLE "LiteLLM_VerificationToken" ADD COLUMN "budget_fallbacks" JSONB NOT NULL DEFAULT \'{}\';',
    ),
  );
  for (const sql of [
    'DROP TABLE "LiteLLM_VerificationToken";',
    'ALTER TABLE "LiteLLM_VerificationToken" DROP COLUMN "token";',
    'ALTER TABLE "LiteLLM_VerificationToken" ALTER COLUMN "spend" TYPE INTEGER;',
    'DELETE FROM "LiteLLM_SpendLogs";',
  ]) {
    assert.throws(() => assertNonDestructiveSchemaPlan(sql), /destructive/);
  }
});

test("Prisma schema child receives only operational environment and the isolated URL", () => {
  const env = prismaChildEnv(
    {
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      HARA_CONTROL_ADMIN_KEY: "must-not-pass",
      LITELLM_MASTER_KEY: "must-not-pass",
      UPSTREAM_API_KEY: "must-not-pass",
    },
    "postgresql://user:secret@db/hara?schema=litellm",
  );
  assert.equal(env.HOME, "/tmp/home");
  assert.equal(env.DATABASE_URL, "postgresql://user:secret@db/hara?schema=litellm");
  assert.equal("HARA_CONTROL_ADMIN_KEY" in env, false);
  assert.equal("LITELLM_MASTER_KEY" in env, false);
  assert.equal("UPSTREAM_API_KEY" in env, false);
  assert.equal(isEmptySchemaPlan("-- This is an empty migration.\n"), true);
  assert.equal(isEmptySchemaPlan("CREATE TABLE example (id INTEGER);"), false);
});
