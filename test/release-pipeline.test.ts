import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(".github/workflows/publish-image.yml"), "utf8");
const receiver = readFileSync(
  resolve("deploy/nanhara-tech/release-receiver.sh"),
  "utf8",
);
const liteLlmRequirements = readFileSync(
  resolve("deploy/nanhara-tech/requirements-litellm.txt"),
  "utf8",
);
const liteLlmInstaller = readFileSync(
  resolve("scripts/ensure-litellm-venv.sh"),
  "utf8",
);
const rdsDeploy = readFileSync(
  resolve("deploy/nanhara-tech/deploy-ai-rds.sh"),
  "utf8",
);

test("tag release deploys only after the verified multi-arch image through a protected environment", () => {
  assert.match(workflow, /deploy_production:\n\s+needs: image/);
  assert.match(workflow, /environment:\n\s+name: hara-control-production/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /HARA_CONTROL_AUTO_DEPLOY_ENABLED == '1'/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /deploy \$GITHUB_REF_NAME \$GITHUB_SHA/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
});

test("release verification audits the build toolchain as well as runtime dependencies", () => {
  assert.match(workflow, /npm audit --registry=https:\/\/registry\.npmjs\.org/);
  assert.doesNotMatch(workflow, /npm audit[^\n]*--omit=dev/);
});

test("forced receiver accepts only a stable tag plus exact workflow SHA", () => {
  assert.match(receiver, /SSH_ORIGINAL_COMMAND/);
  assert.match(receiver, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(receiver, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(receiver, /resolved_sha.*expected_sha/);
  assert.match(receiver, /"v\$package_version".*"\$tag"/);
});

test("forced receiver backs up code and preserves every production secret/runtime boundary", () => {
  const backupAt = receiver.indexOf("tar -C");
  const syncAt = receiver.indexOf("rsync -a");
  const deployAt = receiver.indexOf('bash "$APP_DIR/deploy/nanhara-tech/deploy-ai-rds.sh"');
  assert.ok(backupAt >= 0 && syncAt > backupAt && deployAt > syncAt);
  for (const boundary of [
    ".git/",
    ".env",
    ".npmrc",
    "node_modules/",
    ".litellm-venv/",
    ".litellm-venvs/",
    ".litellm-runtime/",
    "postgres-data/",
  ]) {
    assert.ok(receiver.includes(`--exclude='${boundary}'`), `missing preserved boundary: ${boundary}`);
  }
  assert.match(receiver, /--exclude='\.\/\.litellm-venvs'/, "versioned runtimes must be excluded from rollback archives");
  assert.match(receiver, /--exclude='\.litellm-venvs\/'/, "versioned runtimes must survive rsync --delete");
});

test("LiteLLM runtime pins its database client and never reuses a drifted virtualenv", () => {
  assert.match(liteLlmRequirements, /^litellm\[proxy\]==1\.92\.0$/m);
  assert.match(liteLlmRequirements, /^prisma==0\.11\.0$/m);
  assert.match(liteLlmInstaller, /REQUIREMENTS_SHA/);
  assert.match(liteLlmInstaller, /LAYOUT_VERSION="v3"/);
  assert.match(liteLlmInstaller, /TARGET="\$BASE\/\$LAYOUT_VERSION-\$VERSION-\$REQUIREMENTS_SHA"/);
  assert.match(liteLlmInstaller, /\.hara-runtime-complete/);
  assert.match(liteLlmInstaller, /expected_shebang="#!\$TARGET\/bin\/python3"/);
  assert.doesNotMatch(liteLlmInstaller, /mv "\$staging" "\$TARGET"/);
  assert.match(liteLlmInstaller, /import prisma/);
  assert.match(liteLlmInstaller, /from prisma import Prisma/);
  assert.match(liteLlmInstaller, /"\$TARGET\/bin\/prisma" generate --schema="\$schema"/);
  assert.match(liteLlmInstaller, /mktemp -d "\/tmp\/hara-litellm-prisma\.XXXXXX"/);
  assert.match(liteLlmInstaller, /env -i/);
  assert.match(liteLlmInstaller, /DATABASE_URL="postgresql:\/\/unused:unused@127\.0\.0\.1:1\/unused"/);
  assert.match(liteLlmInstaller, /schema\.is_file\(\)/);
});

test("RDS deploy synchronizes LiteLLM schema before startup and disables runtime mutation", () => {
  const ensureAt = rdsDeploy.indexOf("bash scripts/ensure-litellm-venv.sh");
  const syncAt = rdsDeploy.indexOf("node scripts/sync-litellm-schema.mjs");
  const startAt = rdsDeploy.indexOf('pm2_clean start "$APP_DIR/scripts/with-production-env.mjs"');
  assert.ok(ensureAt >= 0 && syncAt > ensureAt && startAt > syncAt);
  assert.match(rdsDeploy, /DISABLE_SCHEMA_UPDATE=true/);
  assert.doesNotMatch(rdsDeploy, /--accept-data-loss/);
});
