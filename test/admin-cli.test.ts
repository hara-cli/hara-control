// admin CLI pure-helper tests (the network commands are smoke-tested live against the gateway).
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtFleet, enrollHint } from "../cli/admin";

test("enrollHint: builds the hara enroll command (trims a trailing slash)", () => {
  assert.equal(enrollHint("https://api.nanhara.tech/", "hara-abc123"), "hara enroll https://api.nanhara.tech --code hara-abc123");
});

test("fmtFleet: online dot · model · spend · revoked marker; empty → message", () => {
  assert.equal(fmtFleet([]), "(no devices)");
  const out = fmtFleet([
    { device_id: "d1", name: "jeff-mbp", os: "darwin", online: true, token_active: true, model: "glm-5", spend: 1.2 },
    { device_id: "d2", name: "old", os: "linux", online: false, token_active: false, model: "", spend: 0 },
  ]);
  assert.match(out, /● jeff-mbp/);
  assert.match(out, /glm-5/);
  assert.match(out, /\$1\.20/);
  assert.match(out, /○ old/);
  assert.match(out, /\[revoked\]/);
});
