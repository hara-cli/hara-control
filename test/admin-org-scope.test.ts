import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminRole } from "@prisma/client";
import { assertAdminOrgAccess } from "../src/common/admin-auth.guard";
import { AdminController } from "../src/admin/admin.controller";
import type { AdminService } from "../src/admin/admin.service";

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

test("non-expiring enrollment is restricted to a global superadmin", () => {
  let calls = 0;
  const controller = new AdminController({
    createEnrollCode: () => {
      calls += 1;
      return { code: "synthetic" };
    },
  } as unknown as AdminService);
  const dto = {
    orgId: "org-1",
    tokenNeverExpires: true,
  };

  assert.throws(
    () => controller.createEnrollCode({
      user: { id: "admin", email: "admin@example.test", role: AdminRole.ADMIN, orgId: "org-1" },
    }, dto),
    /SUPERADMIN/,
  );
  assert.equal(calls, 0);

  assert.deepEqual(
    controller.createEnrollCode({
      user: { id: "super", email: "super@example.test", role: AdminRole.SUPERADMIN },
    }, dto),
    { code: "synthetic" },
  );
  assert.equal(calls, 1);
});
