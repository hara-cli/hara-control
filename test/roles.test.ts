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
  allowTools: [], denyTools: [], system: `sys ${key}`, version: 1, archivedAt: null, ...over,
});

test("mergePolicy: deny-lists union, approval flag OR-s, allow = last non-empty", () => {
  const m = mergePolicy(
    { modelDeny: ["a"], toolDeny: ["bash"] },
    { modelDeny: ["b"], requireApprovalForWrites: true, modelAllow: ["x"] },
    { modelAllow: ["y", "z"] },
  );
  assert.deepEqual([...m.modelDeny!].sort(), ["a", "b"]);
  assert.deepEqual(m.toolDeny, ["bash"]);
  assert.equal(m.requireApprovalForWrites, true);
  assert.deepEqual(m.modelAllow, ["y", "z"]);
});

test("resolveBundleForDevice: person's direct + team roles, deduped + governance-merged", async () => {
  const svc = rolesServiceWith({
    device: { id: "d1", orgId: "o1", personId: "p1", person: { teams: [{ teamId: "t1" }] }, org: { policy: { modelDeny: ["gpt-4o"] } } },
    // reviewer assigned twice (direct + via team) — same role row, must dedupe to one
    assignments: [{ role: role("reviewer", { model: "qwen-max" }) }, { role: role("planner") }, { role: role("reviewer", { model: "qwen-max" }) }],
    teams: [{ id: "t1", policy: { requireApprovalForWrites: true, toolDeny: ["bash"] } }],
  });
  const b = await svc.resolveBundleForDevice("d1");
  assert.deepEqual(b.roles.map((r) => r.name).sort(), ["planner", "reviewer"], "deduped role set");
  assert.equal(b.roles.find((r) => r.name === "reviewer")!.model, "qwen-max");
  assert.deepEqual([...b.org_policy.modelDeny!], ["gpt-4o"]);
  assert.equal(b.org_policy.requireApprovalForWrites, true, "team policy merged into org_policy");
  assert.deepEqual(b.org_policy.toolDeny, ["bash"]);
  assert.ok(b.version > 0, "non-empty bundle has a version watermark");
});

test("resolveBundleForDevice: archived roles excluded; no person → empty bundle", async () => {
  const archived = rolesServiceWith({
    device: { id: "d1", orgId: "o1", personId: "p1", person: { teams: [] }, org: { policy: {} } },
    assignments: [{ role: role("old", { archivedAt: new Date() }) }],
  });
  assert.deepEqual((await archived.resolveBundleForDevice("d1")).roles, [], "archived role excluded");

  const noPerson = rolesServiceWith({ device: { id: "d2", orgId: "o1", personId: null, person: null, org: { policy: {} } } });
  const b = await noPerson.resolveBundleForDevice("d2");
  assert.deepEqual(b.roles, []);
  assert.equal(b.version, 0);
});

test("bundleForBearer: unknown / revoked / missing token rejected", async () => {
  const svc = rolesServiceWith({ deviceToken: null });
  await assert.rejects(() => svc.bundleForBearer("sk-x"), /unknown|revoked/i);
  await assert.rejects(() => svc.bundleForBearer(undefined), /missing/i);
});
