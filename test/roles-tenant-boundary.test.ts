import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminRole } from "@prisma/client";
import { RolesController } from "../src/roles/roles.controller";
import { RolesService } from "../src/roles/roles.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";
import type { EntitlementService } from "../src/license/license.service";

const orgAdmin = {
  id: "admin-a",
  email: "admin-a@example.test",
  role: AdminRole.ADMIN,
  orgId: "org-a",
};

test("RolesController rejects org-scoped admins before list or ID-based mutations cross tenants", async () => {
  let listCalls = 0;
  let updateCalls = 0;
  const controller = new RolesController({
    listRoles: () => {
      listCalls += 1;
      return [];
    },
    roleOrgId: async () => "org-b",
    updateRole: async () => {
      updateCalls += 1;
      return {};
    },
  } as unknown as RolesService);

  assert.throws(
    () => controller.listRoles({ user: orgAdmin }, "org-b"),
    /organization access denied/,
  );
  assert.equal(listCalls, 0);

  await assert.rejects(
    () => controller.updateRole({ user: orgAdmin }, "role-b", {}),
    /organization access denied/,
  );
  assert.equal(updateCalls, 0);
});

test("RolesController permits a global operator and forwards the real audit actor", async () => {
  const superadmin = {
    id: "super",
    email: "super@example.test",
    role: AdminRole.SUPERADMIN,
  };
  let actorId = "";
  const controller = new RolesController({
    roleOrgId: async () => "org-b",
    updateRole: async (_id: string, _input: unknown, actor: { id: string }) => {
      actorId = actor.id;
      return { id: "role-b" };
    },
  } as unknown as RolesService);

  assert.deepEqual(
    await controller.updateRole({ user: superadmin }, "role-b", {}),
    { id: "role-b" },
  );
  assert.equal(actorId, "super");
});

test("RolesService rejects cross-organization team membership and Agent assignments", async () => {
  let memberWrites = 0;
  let assignmentWrites = 0;
  const prisma = {
    team: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        orgId: where.id === "team-a" ? "org-a" : "org-b",
      }),
    },
    person: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        orgId: where.id === "person-a" ? "org-a" : "org-b",
      }),
    },
    role: {
      findUnique: async () => ({ orgId: "org-a" }),
    },
    personTeam: {
      upsert: async () => {
        memberWrites += 1;
      },
    },
    digitalEmployee: {
      create: async () => {
        assignmentWrites += 1;
        return { id: "assignment" };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    transact: async (_action: string, _actorType: string, _actorId: string, mutation: (tx: unknown) => Promise<{ result: unknown }>) =>
      (await mutation(prisma)).result,
  } as unknown as AuditService;
  const entitlement = { assert: () => {} } as unknown as EntitlementService;
  const service = new RolesService(prisma, audit, entitlement);

  await assert.rejects(
    () => service.addTeamMember("team-a", "person-b", orgAdmin),
    /same organization/,
  );
  assert.equal(memberWrites, 0);

  await assert.rejects(
    () => service.createAssignment("org-a", "role-a", { personId: "person-b" }, orgAdmin),
    /same organization/,
  );
  assert.equal(assignmentWrites, 0);
});

test("RolesService audit events identify the administrator separately from the resource", async () => {
  const auditEvents: Array<{ actorType: string; actorId: string; payload: Record<string, unknown> }> = [];
  const prisma = {
    role: {
      create: async () => ({ id: "role-1", orgId: "org-a", key: "reviewer" }),
    },
  } as unknown as PrismaService;
  const audit = {
    transact: async (
      action: string,
      actorType: string,
      actorId: string,
      mutation: (tx: unknown) => Promise<{ result: unknown; payload?: Record<string, unknown> }>,
    ) => {
      const audited = await mutation(prisma);
      auditEvents.push({ actorType, actorId, payload: audited.payload ?? {} });
      return audited.result;
    },
  } as unknown as AuditService;
  const entitlement = { assert: () => {} } as unknown as EntitlementService;
  const service = new RolesService(prisma, audit, entitlement);

  await service.createRole("org-a", { key: "reviewer" }, orgAdmin);
  assert.deepEqual(auditEvents, [{
    actorType: "admin",
    actorId: "admin-a",
    payload: { resourceId: "role-1", key: "reviewer" },
  }]);
});

test("adding a team member persists the tenant key and audits the real administrator", async () => {
  let created: Record<string, unknown> | undefined;
  const auditEvents: Array<{ action: string; actorId: string; payload: Record<string, unknown> }> = [];
  const prisma = {
    team: { findUnique: async () => ({ orgId: "org-a" }) },
    person: { findUnique: async () => ({ orgId: "org-a" }) },
    personTeam: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => { created = create; },
    },
  } as unknown as PrismaService;
  const audit = {
    transact: async (
      action: string,
      _actorType: string,
      actorId: string,
      mutation: (tx: unknown) => Promise<{ result: unknown; payload?: Record<string, unknown> }>,
    ) => {
      const audited = await mutation(prisma);
      auditEvents.push({ action, actorId, payload: audited.payload ?? {} });
      return audited.result;
    },
  } as unknown as AuditService;
  const service = new RolesService(prisma, audit, { assert: () => {} } as unknown as EntitlementService);

  await service.addTeamMember("team-a", "person-a", orgAdmin);
  assert.deepEqual(created, { orgId: "org-a", personId: "person-a", teamId: "team-a" });
  assert.deepEqual(auditEvents, [{
    action: "team.member.add",
    actorId: "admin-a",
    payload: { resourceId: "team-a", personId: "person-a" },
  }]);
});
