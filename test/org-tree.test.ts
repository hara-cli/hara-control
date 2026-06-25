// Org-unit hierarchy + downward-inheritance unit tests — offline, fake Prisma (no Postgres).  npm test
//   - selectInherited: PURE nearest-defined-wins over a leaf-first ancestor chain (dept→company→group)
//   - ancestors / descendants / resolveInherited over a fake Prisma tree
//   - cycle guard (a node can't be its own ancestor)
import { test } from "node:test";
import assert from "node:assert/strict";
import { OrgTreeService, selectInherited } from "../src/org/org-tree.service";
import type { PrismaService } from "../src/prisma/prisma.service";

type Node = { id: string; name: string; type: string; parentId: string | null; policy: Record<string, unknown> };

// A minimal fake Prisma exposing just the organization.findUnique / findMany the service uses.
function fakePrisma(nodes: Node[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return {
    organization: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => byId.get(id) ?? null,
      findMany: async ({ where: { parentId } }: { where: { parentId: string }; select?: unknown }) =>
        nodes.filter((n) => n.parentId === parentId).map((n) => ({ id: n.id })),
    },
  };
}

const svcFor = (nodes: Node[]) => new OrgTreeService(fakePrisma(nodes) as unknown as PrismaService);

// A synthetic 集团→公司→部门 chain expressed leaf-first (the order ancestors() returns).
const deptFirstChain = (over: { dept?: unknown; company?: unknown; group?: unknown }) => [
  { id: "dept", policy: { v: over.dept } },
  { id: "company", policy: { v: over.company } },
  { id: "group", policy: { v: over.group } },
];

// ── PURE selection ────────────────────────────────────────────────────────────────────────────

test("selectInherited: nearest-defined wins (department overrides company overrides group)", () => {
  const chain = deptFirstChain({ dept: "D", company: "C", group: "G" });
  assert.equal(selectInherited(chain, (n) => n.policy.v), "D", "own value beats inherited");
});

test("selectInherited: inherits from company when the department doesn't define it", () => {
  const chain = deptFirstChain({ dept: undefined, company: "C", group: "G" });
  assert.equal(selectInherited(chain, (n) => n.policy.v), "C", "nearest defined ancestor (company)");
});

test("selectInherited: inherits all the way up to the group root", () => {
  const chain = deptFirstChain({ dept: undefined, company: undefined, group: "G" });
  assert.equal(selectInherited(chain, (n) => n.policy.v), "G");
});

test("selectInherited: undefined all the way → undefined", () => {
  const chain = deptFirstChain({ dept: undefined, company: undefined, group: undefined });
  assert.equal(selectInherited(chain, (n) => n.policy.v), undefined);
});

test("selectInherited: null is treated as 'not defined' (skipped, keeps walking up)", () => {
  const chain = deptFirstChain({ dept: null, company: "C", group: "G" });
  assert.equal(selectInherited(chain, (n) => n.policy.v as unknown), "C");
});

test("selectInherited: a falsy-but-defined value (0 / '' / false) still wins", () => {
  assert.equal(selectInherited(deptFirstChain({ dept: 0, company: "C" }), (n) => n.policy.v), 0);
  assert.equal(selectInherited(deptFirstChain({ dept: "", company: "C" }), (n) => n.policy.v), "");
  assert.equal(selectInherited(deptFirstChain({ dept: false, company: "C" }), (n) => n.policy.v), false);
});

// ── DB-walking helpers over a fake tree ─────────────────────────────────────────────────────────

// group(root) → company → dept → team ; plus a sibling dept2 under company.
const tree: Node[] = [
  { id: "group", name: "南荒集团", type: "GROUP", parentId: null, policy: { modelDeny: ["evil"], budget: 1000 } },
  { id: "company", name: "南荒科技", type: "COMPANY", parentId: "group", policy: { budget: 500 } },
  { id: "dept", name: "工程部", type: "DEPARTMENT", parentId: "company", policy: { requireApprovalForWrites: true } },
  { id: "dept2", name: "财务部", type: "DEPARTMENT", parentId: "company", policy: {} },
  { id: "team", name: "平台组", type: "TEAM", parentId: "dept", policy: {} },
];

test("ancestors: leaf-first chain self → … → root", async () => {
  const svc = svcFor(tree);
  const chain = await svc.ancestors("team");
  assert.deepEqual(chain.map((o) => o.id), ["team", "dept", "company", "group"]);
});

test("ancestors: a standalone company root returns just itself", async () => {
  const svc = svcFor([{ id: "solo", name: "OneCo", type: "COMPANY", parentId: null, policy: {} }]);
  const chain = await svc.ancestors("solo");
  assert.deepEqual(chain.map((o) => o.id), ["solo"]);
});

test("ancestors: missing starting node throws", async () => {
  const svc = svcFor(tree);
  await assert.rejects(() => svc.ancestors("nope"), /not found/);
});

test("descendants: subtree incl. self (company + its departments + team)", async () => {
  const svc = svcFor(tree);
  const ids = await svc.descendants("company");
  assert.deepEqual(new Set(ids), new Set(["company", "dept", "dept2", "team"]));
  assert.equal(ids[0], "company", "self first (BFS from root)");
});

test("descendants: a leaf team is just itself", async () => {
  const svc = svcFor(tree);
  assert.deepEqual(await svc.descendants("team"), ["team"]);
});

test("resolveInherited: department inherits the company's (then group's) policy values", async () => {
  const svc = svcFor(tree);
  // dept defines requireApprovalForWrites itself
  assert.equal(await svc.resolveInherited("dept", (o) => (o.policy as any).requireApprovalForWrites), true);
  // dept doesn't set budget → inherits company's 500 (nearer than group's 1000)
  assert.equal(await svc.resolveInherited("dept", (o) => (o.policy as any).budget), 500);
  // neither dept nor company set modelDeny → inherits the group root's
  assert.deepEqual(await svc.resolveInherited("team", (o) => (o.policy as any).modelDeny), ["evil"]);
  // nobody sets it → undefined
  assert.equal(await svc.resolveInherited("team", (o) => (o.policy as any).nonexistent), undefined);
});

// ── cycle guard ─────────────────────────────────────────────────────────────────────────────────

test("ancestors: cycle is detected and throws (a node can't be its own ancestor)", async () => {
  // a ↔ b cycle
  const cyclic: Node[] = [
    { id: "a", name: "A", type: "COMPANY", parentId: "b", policy: {} },
    { id: "b", name: "B", type: "DEPARTMENT", parentId: "a", policy: {} },
  ];
  const svc = svcFor(cyclic);
  await assert.rejects(() => svc.ancestors("a"), /cycle/i);
});

test("descendants: a cycle does not loop forever (guarded, returns the set once)", async () => {
  const cyclic: Node[] = [
    { id: "a", name: "A", type: "COMPANY", parentId: "b", policy: {} },
    { id: "b", name: "B", type: "DEPARTMENT", parentId: "a", policy: {} },
  ];
  const svc = svcFor(cyclic);
  const ids = await svc.descendants("a");
  assert.deepEqual(new Set(ids), new Set(["a", "b"]));
});
