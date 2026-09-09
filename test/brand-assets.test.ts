import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("console surfaces use the canonical Hara V3.2 B mark", () => {
  const html = readFileSync(join(root, "public", "console", "index.html"), "utf8");
  const mark = readFileSync(join(root, "public", "console", "hara-mark.svg"), "utf8");

  assert.equal((html.match(/src="hara-mark\.svg"/g) ?? []).length, 2);
  assert.match(html, /rel="icon" href="hara-mark\.svg"/);
  assert.doesNotMatch(html, /simplified hara dot|<circle cx="16" cy="16" r="10"/);
  assert.match(mark, /data-brand-version="3\.2"/);
  assert.match(mark, /d="M1950 2059/);
});
