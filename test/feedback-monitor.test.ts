import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const monitorPath = join(root, "scripts", "hara-feishu-monitor.py");

test("repository-managed Feishu monitor passes its deterministic self-test", () => {
  const result = spawnSync("python3", [monitorPath, "--self-test"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /self-test passed/);
});

test("monitor claims one Control ticket before replying and keeps the credential out of argv", () => {
  const monitor = readFileSync(monitorPath, "utf8");
  const installer = readFileSync(join(root, "scripts", "install-hara-feishu-monitor.sh"), "utf8");

  assert.match(monitor, /\/v1\/internal\/feedback-tickets\/intake/);
  assert.match(monitor, /controlClaimGranted/);
  assert.match(monitor, /Persist the local work item before any network request/);
  assert.match(monitor, /atomic_json\(queued, record\)[\s\S]*sync_control_intake\(record\)/);
  assert.match(monitor, /recent_codex_reply_exists\(message_id\)/);
  assert.match(monitor, /handledByExistingCodex/);
  assert.match(monitor, /acknowledgment_was_in_flight/);
  assert.match(monitor, /X-Hara-Feedback-Key/);
  assert.match(monitor, /os\.open\(CONTROL_KEY_FILE/);
  assert.match(monitor, /handle\.read\(4096\)/);
  assert.doesNotMatch(monitor, /LOGGER\.[a-z]+\([^\n]*\bkey\b[^\n]*\)/i);
  assert.match(installer, /HARA_FEEDBACK_INTAKE_KEY_FILE/);
  assert.doesNotMatch(installer, /HARA_FEEDBACK_INTAKE_KEY=/);
});
