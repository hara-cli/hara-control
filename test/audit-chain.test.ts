// Tamper-evident audit hash-chain unit tests — offline, fake Prisma (no Postgres).  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditService } from "../src/audit/audit.service";
import type { PrismaService } from "../src/prisma/prisma.service";

type Row = { id: string; orgId: string; action: string; actorType: string; actorId: string; payload: unknown; at: Date; seq: number; prevHash: string; rowHash: string };

function fakePrisma() {
  const rows: Row[] = [];
  let n = 0;
  const auditLog = {
    findFirst: async ({ where: { orgId }, orderBy }: { where: { orgId: string }; orderBy: { seq: "desc" } }) => {
      void orderBy;
      const ofOrg = rows.filter((r) => r.orgId === orgId).sort((a, b) => b.seq - a.seq);
      return ofOrg[0] ?? null;
    },
    findMany: async ({ where: { orgId } }: { where: { orgId: string }; orderBy: { seq: "asc" } }) =>
      rows.filter((r) => r.orgId === orgId).sort((a, b) => a.seq - b.seq),
    create: async ({ data }: { data: Omit<Row, "id"> }) => {
      const r: Row = { id: `a_${++n}`, ...data };
      rows.push(r);
      return r;
    },
  };
  const prisma = {
    rows,
    auditLog,
    // run the callback against the same fake (single-threaded test, no real isolation needed)
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ auditLog }),
  };
  return prisma;
}

const svcFor = (p: ReturnType<typeof fakePrisma>) => new AuditService(p as unknown as PrismaService);

test("audit chain: links rows, verify() passes on an intact chain", async () => {
  const p = fakePrisma();
  const svc = svcFor(p);
  await svc.log("o1", "enroll", "device", "d1", { name: "mac" });
  await svc.log("o1", "revoke", "admin", "d1", { tokens: 1 });
  await svc.log("o1", "role.create", "admin", "r1", { key: "reviewer" });

  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].seq, 0);
  assert.equal(p.rows[0].prevHash, "", "genesis has empty prevHash");
  assert.equal(p.rows[1].prevHash, p.rows[0].rowHash, "row 2 links to row 1");
  assert.equal(p.rows[2].prevHash, p.rows[1].rowHash, "row 3 links to row 2");

  const res = await svc.verify("o1");
  assert.equal(res.ok, true, "intact chain verifies");
  assert.equal(res.count, 3);
});

test("audit chain: verify() detects a tampered historical row", async () => {
  const p = fakePrisma();
  const svc = svcFor(p);
  await svc.log("o1", "enroll", "device", "d1", { name: "mac" });
  await svc.log("o1", "revoke", "admin", "d1", { tokens: 1 });

  // attacker rewrites the payload of an existing row but can't recompute the downstream chain
  p.rows[0].payload = { name: "rewritten" };

  const res = await svc.verify("o1");
  assert.equal(res.ok, false, "tamper detected");
  assert.equal(res.brokenAt?.seq, 0);
  assert.match(res.brokenAt!.reason, /tamper|mismatch/i);
});

test("audit chain: per-org isolation (separate chains)", async () => {
  const p = fakePrisma();
  const svc = svcFor(p);
  await svc.log("o1", "enroll", "device", "d1");
  await svc.log("o2", "enroll", "device", "d9");
  await svc.log("o1", "revoke", "admin", "d1");

  const o1 = p.rows.filter((r) => r.orgId === "o1");
  const o2 = p.rows.filter((r) => r.orgId === "o2");
  assert.deepEqual(o1.map((r) => r.seq), [0, 1], "o1 has its own seq sequence");
  assert.deepEqual(o2.map((r) => r.seq), [0], "o2 chain independent");
  assert.equal((await svc.verify("o1")).ok, true);
  assert.equal((await svc.verify("o2")).ok, true);
});

test("audit chain: preserves and reports an unauthenticated legacy prefix before the hashed suffix", async () => {
  const p = fakePrisma();
  p.rows.push(
    {
      id: "legacy-1",
      orgId: "o1",
      action: "legacy.one",
      actorType: "system",
      actorId: "",
      payload: {},
      at: new Date("2026-01-01T00:00:00Z"),
      seq: 0,
      prevHash: "",
      rowHash: "",
    },
    {
      id: "legacy-2",
      orgId: "o1",
      action: "legacy.two",
      actorType: "system",
      actorId: "",
      payload: {},
      at: new Date("2026-01-01T00:01:00Z"),
      seq: 1,
      prevHash: "",
      rowHash: "",
    },
  );
  const svc = svcFor(p);
  await svc.log("o1", "anchored", "system");

  const result = await svc.verify("o1");
  assert.deepEqual(result, { ok: true, count: 3, legacyPrefix: 2 });
  assert.equal(p.rows[2].seq, 2);
  assert.equal(p.rows[2].prevHash, "");
  assert.notEqual(p.rows[2].rowHash, "");
});

test("audit chain: append uses serializable isolation and retries a bounded write conflict", async () => {
  const p = fakePrisma();
  const baseTransaction = p.$transaction;
  let attempts = 0;
  let isolationLevel = "";
  (p as unknown as {
    $transaction: (
      fn: (tx: unknown) => Promise<unknown>,
      options?: { isolationLevel?: string },
    ) => Promise<unknown>;
  }).$transaction = async (fn, options) => {
    attempts += 1;
    isolationLevel = options?.isolationLevel ?? "";
    if (attempts === 1) throw Object.assign(new Error("serialization conflict"), { code: "P2034" });
    return baseTransaction(fn);
  };
  await svcFor(p).log("o1", "concurrent", "system");
  assert.equal(attempts, 2);
  assert.equal(isolationLevel, "Serializable");
  assert.equal(p.rows.length, 1);
});
