import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());

test("public control-core metadata agrees with the repository Apache-2.0 license", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const decisions = readFileSync(resolve(root, "docs", "decisions.md"), "utf8");
  const license = readFileSync(resolve(root, "LICENSE"), "utf8");

  assert.equal(manifest.license, "Apache-2.0");
  assert.doesNotMatch(manifest.description, /closed-source|proprietary/i);
  assert.match(license, /Apache License[\s\S]*Version 2\.0/);
  assert.match(readme, /Open source — Apache-2\.0/);
  assert.doesNotMatch(readme, /hara-control \(this repo, closed\)/);
  assert.match(decisions, /Apache-2\.0 self-hosted control core/);
  assert.match(decisions, /superseded/);
});
