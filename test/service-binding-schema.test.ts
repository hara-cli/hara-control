import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");

test("organization service bindings have a tenant-scoped schema and never store plaintext credentials", () => {
  const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
  const migration = readFileSync(
    join(
      root,
      "prisma",
      "migrations",
      "20260805220000_tenant_service_bindings",
      "migration.sql",
    ),
    "utf8",
  );
  assert.match(schema, /model TenantServiceBinding/);
  assert.match(schema, /@@unique\(\[orgId, service\]\)/);
  assert.match(schema, /credentialRef\s+String\?/);
  assert.doesNotMatch(schema, /enrollKey|credentialPlaintext|apiKey/);
  assert.match(migration, /FOREIGN KEY \("orgId"\)/);
  assert.match(migration, /ON DELETE CASCADE/);
  assert.doesNotMatch(migration, /enroll_key|api_key|plaintext/i);
});
