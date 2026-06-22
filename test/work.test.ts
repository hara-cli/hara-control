// Work-behavior tamper-evidence chain unit tests.  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainHash } from "../src/work/work.service";

test("chainHash: deterministic, sha256 hex, links on prevHash", () => {
  const f = { deviceId: "d1", seq: 1, kind: "CODING" };
  const h1 = chainHash(f, "");
  assert.equal(h1, chainHash(f, ""), "same input → same hash");
  assert.equal(h1.length, 64, "sha256 hex");
  assert.notEqual(h1, chainHash(f, "prevrow"), "a different prevHash changes the row hash (chain links)");
});

test("chainHash: different identity → different hash", () => {
  assert.notEqual(chainHash({ seq: 1 }, ""), chainHash({ seq: 2 }, ""));
});
