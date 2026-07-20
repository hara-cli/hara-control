import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideKnownMigrationRecovery,
  FAILED_RELEASE_CHECKSUM,
  KNOWN_MIGRATION,
} from "../scripts/recover-known-failed-migration.mjs";

function knownFailure() {
  return {
    failedMigrations: [
      {
        migration_name: KNOWN_MIGRATION,
        checksum: FAILED_RELEASE_CHECKSUM,
        logs:
          'Database error code: 42P07\nERROR: relation "Secret_global_name_key" already exists',
        started_at: new Date(),
        finished_at: null,
        rolled_back_at: null,
      },
    ],
    newObjects: {
      system_audit_log: false,
      system_audit_at_idx: false,
      system_audit_action_idx: false,
      provider_activation: false,
      provider_activation_idx: false,
      audit_unique_idx: false,
      secret_version_column: false,
    },
    globalSecretIndexMatches: true,
  };
}

test("migration recovery is a no-op when there is no active known failure", () => {
  const state = knownFailure();
  state.failedMigrations = [];
  assert.equal(decideKnownMigrationRecovery(state), "none");
});

test("migration recovery recognizes the exact released duplicate-index failure", () => {
  assert.equal(decideKnownMigrationRecovery(knownFailure()), "recover");
});

test("migration recovery rejects a different checksum or error signature", () => {
  const changed = knownFailure();
  changed.failedMigrations[0].checksum = "different";
  assert.throws(() => decideKnownMigrationRecovery(changed), /checksum/);

  const unrelated = knownFailure();
  unrelated.failedMigrations[0].logs = "P3018: a different migration error";
  assert.throws(() => decideKnownMigrationRecovery(unrelated), /signature/);
});

test("migration recovery rejects partial application or an unexpected existing index", () => {
  const partial = knownFailure();
  partial.newObjects.system_audit_log = true;
  assert.throws(() => decideKnownMigrationRecovery(partial), /partially applied/);

  const wrongIndex = knownFailure();
  wrongIndex.globalSecretIndexMatches = false;
  assert.throws(() => decideKnownMigrationRecovery(wrongIndex), /unexpected semantics/);
});

test("production paths recover before deploy and the corrected migration does not recreate the old index", () => {
  const deploy = readFileSync(resolve("deploy/nanhara-tech/deploy-ai-rds.sh"), "utf8");
  const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
  const migration = readFileSync(
    resolve(`prisma/migrations/${KNOWN_MIGRATION}/migration.sql`),
    "utf8",
  );

  assert.match(deploy, /npm run prisma:deploy/);
  assert.match(dockerfile, /npm run prisma:deploy/);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX "Secret_global_name_key"/);
});
