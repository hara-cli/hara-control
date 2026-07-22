import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminRole } from "@prisma/client";
import { assertAdminOrgAccess } from "../src/common/admin-auth.guard";

test("organization access permits global operators and the assigned org only", () => {
  assert.doesNotThrow(() => assertAdminOrgAccess({
    id: "super",
    email: "super@example.test",
    role: AdminRole.SUPERADMIN,
  }, "org-any"));
  assert.doesNotThrow(() => assertAdminOrgAccess({
    id: "admin",
    email: "admin@example.test",
    role: AdminRole.ADMIN,
    orgId: "org-1",
  }, "org-1"));
  assert.throws(() => assertAdminOrgAccess({
    id: "admin",
    email: "admin@example.test",
    role: AdminRole.ADMIN,
    orgId: "org-1",
  }, "org-2"), /organization access denied/);
  assert.throws(() => assertAdminOrgAccess({
    id: "admin",
    email: "admin@example.test",
    role: AdminRole.ADMIN,
  }, "org-1"), /organization access denied/);
});
