import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(".github/workflows/publish-image.yml"), "utf8");
const receiver = readFileSync(
  resolve("deploy/nanhara-tech/release-receiver.sh"),
  "utf8",
);

test("tag release deploys only after the verified multi-arch image through a protected environment", () => {
  assert.match(workflow, /deploy_production:\n\s+needs: image/);
  assert.match(workflow, /environment:\n\s+name: hara-control-production/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /deploy \$GITHUB_REF_NAME \$GITHUB_SHA/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
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
    ".litellm-runtime/",
    "postgres-data/",
  ]) {
    assert.ok(receiver.includes(`--exclude='${boundary}'`), `missing preserved boundary: ${boundary}`);
  }
});
