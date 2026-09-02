import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminRole } from "@prisma/client";
import { assertAdminOrgAccess } from "../src/common/admin-auth.guard";
import { AdminController } from "../src/admin/admin.controller";
import { AdminService } from "../src/admin/admin.service";
import { AuthService } from "../src/auth/auth.service";

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
    personId: "person-1",
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

test("an org-less tenant administrator cannot list every organization", () => {
  let calls = 0;
  const controller = new AdminController({
    listOrgs: () => { calls += 1; return []; },
  } as unknown as AdminService);
  assert.throws(
    () => controller.listOrgs({
      user: { id: "orphan-admin", email: "orphan@example.test", role: AdminRole.ADMIN, orgId: null },
    }),
    /organization access denied/,
  );
  assert.equal(calls, 0);
});

test("non-global administrator accounts require a real organization on create and role conversion", async () => {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  let current = { role: AdminRole.SUPERADMIN, orgId: null as string | null };
  const prisma = {
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) => where.id === "org-a" ? { id: "org-a" } : null,
    },
    adminUser: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => where.id ? current : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "new-user", ...data, disabledAt: null, createdAt: new Date() };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        current = {
          role: (data.role as AdminRole | undefined) ?? current.role,
          orgId: (data.orgId as string | null | undefined) ?? current.orgId,
        };
        return { id: "existing", email: "existing@example.test", ...current, disabledAt: null, createdAt: new Date() };
      },
    },
  };
  const auth = new AuthService(prisma as never);
  await assert.rejects(
    () => auth.createUser("admin@example.test", "long-enough-password", AdminRole.ADMIN),
    /must belong to an organization/,
  );
  await assert.rejects(
    () => auth.createUser("admin@example.test", "long-enough-password", AdminRole.ADMIN, "missing"),
    /organization not found/,
  );
  await auth.createUser("admin@example.test", "long-enough-password", AdminRole.ADMIN, "org-a");
  assert.equal(created.length, 1);
  assert.equal(created[0].orgId, "org-a");

  await assert.rejects(() => auth.updateUser("existing", { role: AdminRole.ADMIN }), /must belong to an organization/);
  await auth.updateUser("existing", { role: AdminRole.ADMIN, orgId: "org-a" });
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0], { role: AdminRole.ADMIN, orgId: "org-a" });
});

test("enrollment codes reject a Person owned by another organization before writing", async () => {
  let writes = 0;
  const prisma = {
    person: { findUnique: async () => ({ orgId: "org-b" }) },
    enrollCode: { create: async () => { writes += 1; return {}; } },
  };
  const service = new AdminService(
    prisma as never,
    {
      transact: async (_action: string, _actorType: string, _actorId: string, mutation: (tx: unknown) => Promise<{ result: unknown }>) =>
        (await mutation(prisma)).result,
    } as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    () => service.createEnrollCode(
      "org-a",
      "",
      undefined,
      60,
      "person-b",
      { id: "admin-a", email: "admin-a@example.test", role: AdminRole.ADMIN, orgId: "org-a" },
    ),
    /same organization/,
  );
  assert.equal(writes, 0);
});

test("enrollment codes require an accountable Person before any key can be issued", async () => {
  let writes = 0;
  const prisma = {
    person: { findUnique: async () => null },
    enrollCode: { create: async () => { writes += 1; return {}; } },
  };
  const service = new AdminService(
    prisma as never,
    {
      transact: async (_action: string, _actorType: string, _actorId: string, mutation: (tx: unknown) => Promise<{ result: unknown }>) =>
        (await mutation(prisma)).result,
    } as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    () => service.createEnrollCode(
      "org-a",
      "",
      undefined,
      60,
      "" as never,
      { id: "admin-a", email: "admin-a@example.test", role: AdminRole.ADMIN, orgId: "org-a" },
    ),
    /personId is required/,
  );
  assert.equal(writes, 0);
});

test("a legacy unassigned device can be person-bound once with an atomic audit", async () => {
  const audits: unknown[][] = [];
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    device: {
      findUnique: async () => ({ id: "device-1", orgId: "org-a", personId: null, enrollCodeId: "code-1" }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { count: 1 }; },
    },
    person: {
      findUnique: async () => ({ id: "person-1", orgId: "org-a", name: "Member", email: "member@example.test" }),
    },
    enrollCode: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { count: 1 }; },
    },
  };
  const audit = {
    transact: async (action: string, actorType: string, actorId: string, mutation: (tx: unknown) => Promise<any>) => {
      const result = await mutation(prisma);
      audits.push([action, actorType, actorId, result.orgId, result.payload]);
      return result.result;
    },
  };
  const service = new AdminService(prisma as never, audit as never, {} as never, {} as never);
  const result = await service.bindDevicePerson(
    "device-1",
    "person-1",
    { id: "admin-a", email: "admin-a@example.test", role: AdminRole.ADMIN, orgId: "org-a" },
  );
  assert.equal(result.person.id, "person-1");
  assert.deepEqual(writes, [{ personId: "person-1" }, { personId: "person-1" }]);
  assert.deepEqual(audits, [[
    "device.person.bind",
    "admin",
    "admin-a",
    "org-a",
    { deviceId: "device-1", personId: "person-1" },
  ]]);
});

test("device person binding rejects cross-tenant and already-bound reassignment", async () => {
  let existingPersonId: string | null = null;
  let personOrg = "org-b";
  const prisma = {
    device: {
      findUnique: async () => ({ id: "device-1", orgId: "org-a", personId: existingPersonId, enrollCodeId: null }),
    },
    person: {
      findUnique: async () => ({ id: "person-1", orgId: personOrg, name: "Member", email: "member@example.test" }),
    },
  };
  const service = new AdminService(prisma as never, {} as never, {} as never, {} as never);
  const actor = { id: "admin-a", email: "admin-a@example.test", role: AdminRole.ADMIN, orgId: "org-a" };
  await assert.rejects(() => service.bindDevicePerson("device-1", "person-1", actor), /same organization/);
  personOrg = "org-a";
  existingPersonId = "person-other";
  await assert.rejects(() => service.bindDevicePerson("device-1", "person-1", actor), /already bound/);
});

test("organization and enrollment bootstrap audits preserve the authenticated actor", async () => {
  const audits: unknown[][] = [];
  const prisma = {
    organization: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "org-new", ...data }),
    },
    enrollCode: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data, expiresAt: data.expiresAt }),
    },
    person: { findUnique: async () => ({ orgId: "org-new" }) },
  };
  const service = new AdminService(
    prisma as never,
    {
      transact: async (
        action: string,
        actorType: string,
        actorId: string,
        mutation: (tx: unknown) => Promise<{ result: unknown; orgId: string; payload?: Record<string, unknown> }>,
      ) => {
        const audited = await mutation(prisma);
        audits.push([audited.orgId, action, actorType, actorId, audited.payload ?? {}]);
        return audited.result;
      },
    } as never,
    {} as never,
    {} as never,
  );
  const actor = {
    id: "admin-real",
    email: "admin-real@example.test",
    role: AdminRole.SUPERADMIN,
  };
  await service.createOrg("New Org", actor);
  await service.createEnrollCode("org-new", "", undefined, 60, "person-1", actor);
  assert.deepEqual(
    audits.map((entry) => [entry[1], entry[2], entry[3]]),
    [
      ["org.create", "admin", "admin-real"],
      ["enroll_code.create", "admin", "admin-real"],
    ],
  );
});

test("tenant admins cannot create roots or cross into another organization tree", async () => {
  let writes = 0;
  const prisma = {
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
      create: async () => { writes += 1; return { id: "created" }; },
    },
  };
  const chains: Record<string, Array<{ id: string }>> = {
    "org-a": [{ id: "org-a" }],
    "team-a": [{ id: "team-a" }, { id: "org-a" }],
    "org-b": [{ id: "org-b" }],
  };
  const orgTree = {
    ancestors: async (id: string) => chains[id] ?? [],
    descendants: async (id: string) => [id],
  };
  const audit = {
    transact: async (_action: string, _actorType: string, _actorId: string, mutation: (tx: unknown) => Promise<{ result: unknown }>) =>
      (await mutation(prisma)).result,
  };
  const service = new AdminService(prisma as never, audit as never, orgTree as never, {} as never);
  const adminA = { id: "admin-a", email: "a@example.test", role: AdminRole.ADMIN, orgId: "org-a" };

  await assert.rejects(() => service.createOrg("Another root", adminA), /SUPERADMIN/);
  await assert.rejects(() => service.createOrg("Foreign child", adminA, undefined, "org-b"), /access denied/);
  await assert.rejects(() => service.orgAncestors("org-b", adminA), /access denied/);
  await assert.rejects(() => service.orgSubtree("org-b", adminA), /access denied/);
  assert.equal(writes, 0);

  await service.createOrg("Own team", adminA, undefined, "team-a");
  assert.equal(writes, 1);
  assert.deepEqual(await service.orgSubtree("team-a", adminA), ["team-a"]);
});

test("device revoke fails closed on gateway error and audits the real actor atomically on retry", async () => {
  let localUpdates = 0;
  let transactions = 0;
  const auditCalls: unknown[][] = [];
  const prisma = {
    device: { findUnique: async () => ({ id: "device-1", orgId: "org-a" }) },
    deviceToken: {
      findMany: async () => [
        { id: "token-1", gatewayKeyId: "key-1" },
        { id: "token-2", gatewayKeyId: "key-2" },
      ],
      updateMany: async () => { localUpdates += 1; return { count: 2 }; },
    },
  };
  let failSecond = true;
  const revoked: string[] = [];
  const gateway = {
    revokeKey: async (keyId: string) => {
      revoked.push(keyId);
      if (keyId === "key-2" && failSecond) throw new Error("gateway unavailable");
    },
  };
  const audit = {
    transact: async (
      action: string,
      actorType: string,
      actorId: string,
      mutation: (tx: unknown) => Promise<{ result: unknown; orgId: string; payload?: Record<string, unknown> }>,
    ) => {
      transactions += 1;
      const result = await mutation(prisma);
      auditCalls.push([action, actorType, actorId, result.orgId, result.payload]);
      return result.result;
    },
  };
  const service = new AdminService(prisma as never, audit as never, {} as never, gateway as never);
  const actor = { id: "admin-real", email: "admin@example.test", role: AdminRole.ADMIN, orgId: "org-a" };

  await assert.rejects(() => service.revokeDevice("device-1", actor), /gateway unavailable/);
  assert.equal(localUpdates, 0, "no local token may look revoked while a remote key remains active");
  assert.equal(transactions, 0);

  failSecond = false;
  const result = await service.revokeDevice("device-1", actor);
  assert.deepEqual(result, { revoked: 2 });
  assert.equal(localUpdates, 1);
  assert.equal(transactions, 1);
  assert.deepEqual(auditCalls[0].slice(0, 4), ["device.revoke", "admin", "admin-real", "org-a"]);
  assert.deepEqual(revoked, ["key-1", "key-2", "key-1", "key-2"]);
});
