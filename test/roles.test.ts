// B3 unit tests — the role-bundle resolver + policy merge, offline with a fake Prisma.
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { RolesService, mergePolicy } from "../src/roles/roles.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";
import type { EntitlementService } from "../src/license/license.service";

const fakeAudit = { log: async () => {} } as unknown as AuditService;
const fakeEntitlement = { assert: () => {}, seatCheck: async () => {} } as unknown as EntitlementService;

const rolesServiceWith = (data: {
  device?: unknown;
  assignments?: unknown[];
  teams?: unknown[];
  deviceToken?: unknown;
}) => {
  const prisma = {
    device: { findUnique: async () => data.device ?? null },
    digitalEmployee: { findMany: async () => data.assignments ?? [] },
    team: { findMany: async () => data.teams ?? [] },
    deviceToken: { findUnique: async () => data.deviceToken ?? null },
  } as unknown as PrismaService;
  return new RolesService(prisma, fakeAudit, fakeEntitlement);
};

const role = (key: string, over: Record<string, unknown> = {}) => ({
  id: key, orgId: "o1", key, description: "", owns: [], rejects: [], model: null,
  reasoningEffort: null, allowTools: [], denyTools: [], system: `sys ${key}`, version: 1, archivedAt: null, ...over,
});
const assignment = (assignedRole: ReturnType<typeof role>, over: Record<string, unknown> = {}) => ({
  role: assignedRole,
  policy: {},
  person: null,
  team: null,
  ...over,
});

test("mergePolicy: deny-lists union, approval flag OR-s, and explicit allows only narrow", () => {
  const m = mergePolicy(
    { modelDeny: ["a"], toolDeny: ["bash"], allowPersonalModelConnections: true },
    { modelDeny: ["b"], requireApprovalForWrites: true, modelAllow: ["x", "y"] },
    { modelAllow: ["y", "z"], allowPersonalModelConnections: false },
  );
  assert.deepEqual([...m.modelDeny!].sort(), ["a", "b"]);
  assert.deepEqual(m.toolDeny, ["bash"]);
  assert.equal(m.requireApprovalForWrites, true);
  assert.deepEqual(m.modelAllow, ["y"]);
  assert.equal(m.allowPersonalModelConnections, false, "a lower layer may deny but never widen company BYOK consent");
});

test("mergePolicy: omitted personal-route consent remains fail-closed while an explicit org allow survives inheritance", () => {
  assert.equal(mergePolicy({ modelAllow: ["x"] }).allowPersonalModelConnections, undefined);
  assert.equal(
    mergePolicy({ allowPersonalModelConnections: true }, { toolDeny: ["bash"] }).allowPersonalModelConnections,
    true,
  );
  assert.throws(
    () => mergePolicy({ allowPersonalModelConnections: "yes" } as never),
    /allowPersonalModelConnections must be a boolean/,
  );
});

test("mergePolicy: an explicit empty allow-list remains deny-all", () => {
  assert.deepEqual(
    mergePolicy({ modelAllow: ["x"] }, { modelAllow: [] }).modelAllow,
    [],
  );
});

test("mergePolicy rejects malformed JSON policy and keeps budgets monotonically restrictive", () => {
  assert.throws(
    () => mergePolicy({ modelDeny: "not-an-array" } as never),
    /modelDeny must be an array/,
  );
  assert.throws(
    () => mergePolicy({ modelAlow: ["typo-must-not-widen"] } as never),
    /unsupported field 'modelAlow'/,
  );
  assert.deepEqual(
    mergePolicy(
      { budget: { month: 500, nested: { rpm: 100 } } },
      { budget: { month: 900, nested: { rpm: 40 }, week: 80 } },
    ).budget,
    { month: 500, nested: { rpm: 40 }, week: 80 },
  );
});

test("resolveBundleForDevice: person's direct + team roles, deduped + governance-merged", async () => {
  const svc = rolesServiceWith({
    device: { id: "d1", orgId: "o1", personId: "p1", person: { orgId: "o1", teams: [{ teamId: "t1" }] }, org: { policy: { modelDeny: ["gpt-4o"], modelAllow: ["qwen-max", "qwen-plus"] } } },
    // reviewer assigned twice (direct + via team) — same role row, must dedupe to one
    assignments: [
      assignment(role("reviewer", { model: "qwen-max" }), { person: { orgId: "o1" } }),
      assignment(role("planner"), { team: { orgId: "o1" }, policy: { modelAllow: [], toolDeny: ["network"] } }),
      assignment(role("reviewer", { model: "qwen-max" }), { team: { orgId: "o1" } }),
    ],
    teams: [{ id: "t1", orgId: "o1", policy: { requireApprovalForWrites: true, toolDeny: ["bash"] } }],
  });
  const b = await svc.resolveBundleForDevice("d1");
  assert.deepEqual(b.roles.map((r) => r.name).sort(), ["planner", "reviewer"], "deduped role set");
  assert.equal(b.roles.find((r) => r.name === "reviewer")!.model, "qwen-max");
  assert.deepEqual([...b.org_policy.modelDeny!], ["gpt-4o"]);
  assert.equal(b.org_policy.requireApprovalForWrites, true, "team policy merged into org_policy");
  assert.deepEqual(b.org_policy.toolDeny, ["bash", "network"]);
  assert.deepEqual(b.org_policy.modelAllow, [], "assignment-level deny-all reaches the effective bundle");
  assert.ok(b.version > 0, "non-empty bundle has a version watermark");
});

test("resolveBundleForDevice includes the company-controlled Agent reasoning override", async () => {
  const svc = rolesServiceWith({
    device: { id: "d1", orgId: "o1", personId: "p1", person: { orgId: "o1", teams: [] }, org: { policy: {} } },
    assignments: [assignment(role("analyst", {
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    }), { person: { orgId: "o1" } })],
  });
  const bundle = await svc.resolveBundleForDevice("d1");
  assert.equal(bundle.roles[0]?.model, "deepseek-v4-pro");
  assert.equal(bundle.roles[0]?.reasoning_effort, "high");
});

test("company Agent execution overrides are validated and updated atomically", async () => {
  let current = role("analyst", {
    id: "role-1",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
  });
  let createdData: Record<string, unknown> | undefined;
  let updatedData: Record<string, unknown> | undefined;
  const prisma = {
    role: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdData = data;
        return { ...current, ...data };
      },
      findUnique: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updatedData = data;
        current = { ...current, ...data, version: current.version + 1 };
        return current;
      },
    },
  } as unknown as PrismaService;
  const audit = {
    transact: async (
      _action: string,
      _actorType: string,
      _actorId: string,
      mutation: (tx: unknown) => Promise<{ result: unknown }>,
    ) => (await mutation(prisma)).result,
  } as unknown as AuditService;
  const svc = new RolesService(prisma, audit, fakeEntitlement);
  const actor = { id: "admin-1", role: "ADMIN", orgId: "o1", viaSharedKey: false } as never;

  await svc.createRole("o1", {
    key: "reviewer",
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
  }, actor);
  assert.equal(createdData?.model, "deepseek-v4-flash");
  assert.equal(createdData?.reasoningEffort, "max");

  await assert.rejects(
    () => svc.updateRole("role-1", { model: "custom-model" }, actor),
    /does not support Agent reasoning effort 'high'/,
    "changing a model cannot strand the existing effort override",
  );
  await svc.updateRole("role-1", { reasoningEffort: "" }, actor);
  assert.equal(updatedData?.reasoningEffort, null, "empty clears the override and restores inheritance");
});

test("resolveBundleForDevice: archived roles excluded; no person → empty bundle", async () => {
  const archived = rolesServiceWith({
    device: { id: "d1", orgId: "o1", personId: "p1", person: { orgId: "o1", teams: [] }, org: { policy: {} } },
    assignments: [assignment(role("old", { archivedAt: new Date() }), {
      person: { orgId: "o1" },
      policy: { modelAllow: [], toolDeny: ["bash"] },
    })],
  });
  const archivedBundle = await archived.resolveBundleForDevice("d1");
  assert.deepEqual(archivedBundle.roles, [], "archived role excluded");
  assert.deepEqual(archivedBundle.org_policy, {}, "archived assignment policy is excluded with its role");

  const noPerson = rolesServiceWith({ device: { id: "d2", orgId: "o1", personId: null, person: null, org: { policy: {} } } });
  const b = await noPerson.resolveBundleForDevice("d2");
  assert.deepEqual(b.roles, []);
  assert.equal(b.version, 0);
});

test("resolveBundleForDevice fails closed on a historical cross-organization assignment", async () => {
  const corrupted = rolesServiceWith({
    device: { id: "d1", orgId: "o1", personId: "p1", person: { orgId: "o1", teams: [] }, org: { policy: {} } },
    assignments: [assignment(role("foreign", { orgId: "o2" }), { person: { orgId: "o1" } })],
  });
  await assert.rejects(
    () => corrupted.resolveBundleForDevice("d1"),
    /assignment organization binding is invalid/,
  );
});

test("bundleForBearer: unknown / revoked / missing token rejected", async () => {
  const svc = rolesServiceWith({ deviceToken: null });
  await assert.rejects(() => svc.bundleForBearer("sk-x"), /unknown|revoked/i);
  await assert.rejects(() => svc.bundleForBearer(undefined), /missing/i);
});
