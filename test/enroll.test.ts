// Phase-1 logic tests for the enroll flow — run offline with a fake Prisma + the mock gateway
// adapter (no Postgres, no Nest, no LiteLLM). Live e2e against Postgres is a separate step.
//   npm test   (node --test --import tsx test/*.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnrollService } from "../src/enroll/enroll.service";
import { MockGatewayAdapter } from "../src/gateway/mock.adapter";
import type { GatewayAdapter } from "../src/gateway/gateway-adapter";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";

type Code = { id: string; orgId: string; code: string; model: string; baseUrl: string | null; expiresAt: Date; usedAt: Date | null };
type Dev = { id: string; orgId: string; name: string; os: string; haraVersion: string; lastSeenAt: Date; enrollCodeId: string };
type Tok = { id: string; deviceId: string; tokenHash: string; gatewayKeyId: string; model: string; expiresAt: Date; revokedAt: Date | null };

function fakePrisma() {
  const db = { codes: new Map<string, Code>(), devices: new Map<string, Dev>(), tokens: [] as Tok[] };
  let n = 0;
  const id = () => `id_${++n}`;
  const prisma = {
    db,
    enrollCode: {
      findUnique: async ({ where: { code } }: { where: { code: string } }) => db.codes.get(code) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          usedAt?: Date | null;
          expiresAt?: { gte: Date };
        };
        data: Partial<Code>;
      }) => {
        const id = where.id;
        const ec = [...db.codes.values()].find((c) => c.id === id);
        if (
          !ec ||
          (Object.hasOwn(where, "usedAt") &&
            ec.usedAt?.getTime() !== where.usedAt?.getTime()) ||
          (where.expiresAt && ec.expiresAt.getTime() < where.expiresAt.gte.getTime())
        ) {
          return { count: 0 };
        }
        Object.assign(ec, data);
        return { count: 1 };
      },
    },
    device: {
      create: async ({ data }: { data: Omit<Dev, "id" | "lastSeenAt"> }) => {
        const d: Dev = { id: id(), lastSeenAt: new Date(0), ...data };
        db.devices.set(d.id, d);
        return d;
      },
      update: async ({ where: { id }, data }: { where: { id: string }; data: Partial<Dev> }) => {
        const d = db.devices.get(id)!;
        Object.assign(d, data);
        return d;
      },
      delete: async ({ where: { id } }: { where: { id: string } }) => {
        const d = db.devices.get(id);
        db.devices.delete(id);
        for (let i = db.tokens.length - 1; i >= 0; i--) {
          if (db.tokens[i].deviceId === id) db.tokens.splice(i, 1);
        }
        return d;
      },
    },
    deviceToken: {
      create: async ({ data }: { data: Omit<Tok, "id" | "revokedAt"> }) => {
        const t: Tok = { id: id(), revokedAt: null, ...data };
        db.tokens.push(t);
        return t;
      },
      findUnique: async ({ where: { tokenHash } }: { where: { tokenHash: string } }) =>
        db.tokens.find((t) => t.tokenHash === tokenHash) ?? null,
    },
  };
  return prisma;
}

const fakeAudit = { log: async () => {} } as unknown as AuditService;
const fakeEntitlement = { assert: () => {}, seatCheck: async () => {} } as unknown as import("../src/license/license.service").EntitlementService;
const svcFor = (
  prisma: ReturnType<typeof fakePrisma>,
  gateway: GatewayAdapter = new MockGatewayAdapter(),
) =>
  new EnrollService(prisma as unknown as PrismaService, fakeAudit, gateway, fakeEntitlement);

test("enroll: valid code -> device token; code is single-use", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-good", { id: "c1", orgId: "o1", code: "hara-good", model: "glm-5", baseUrl: null, expiresAt: new Date(Date.now() + 60_000), usedAt: null });
  const svc = svcFor(prisma);

  const res = await svc.enroll("hara-good", { name: "mac", os: "darwin", hara_version: "0.68.0" });
  assert.ok(res.device_token.startsWith("sk-hara-mock-"), "issued a device token");
  assert.equal(res.model, "glm-5");
  assert.ok(res.device_id, "returned a device id");
  assert.equal(prisma.db.tokens.length, 1, "stored exactly one token");
  assert.ok(prisma.db.tokens[0].tokenHash && prisma.db.tokens[0].tokenHash !== res.device_token, "stored the HASH, not the raw token");
  assert.equal(res.expires_at, prisma.db.tokens[0].expiresAt.toISOString(), "client and control plane use the gateway expiry");

  await assert.rejects(() => svc.enroll("hara-good", { name: "mac2", os: "darwin", hara_version: "0.68.0" }), /expired|bad/i, "code can't be reused");
});

test("enroll: expired or unknown code is rejected", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-old", { id: "c2", orgId: "o1", code: "hara-old", model: "", baseUrl: null, expiresAt: new Date(Date.now() - 1_000), usedAt: null });
  const svc = svcFor(prisma);
  await assert.rejects(() => svc.enroll("hara-old", { name: "x", os: "", hara_version: "" }), /expired|bad/i);
  await assert.rejects(() => svc.enroll("nope", { name: "x", os: "", hara_version: "" }), /expired|bad/i);
});

test("enroll: concurrent exchange atomically consumes a one-time code once", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-race", {
    id: "c-race",
    orgId: "o1",
    code: "hara-race",
    model: "glm-5",
    baseUrl: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  const svc = svcFor(prisma);
  const device = { name: "mac", os: "darwin", hara_version: "0.1.2" };

  const settled = await Promise.allSettled([
    svc.enroll("hara-race", device),
    svc.enroll("hara-race", device),
  ]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  assert.equal(prisma.db.devices.size, 1);
  assert.equal(prisma.db.tokens.length, 1);
});

test("enroll: a gateway issue failure removes the incomplete device so the same unused code can retry", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-retry", {
    id: "c-retry",
    orgId: "o1",
    code: "hara-retry",
    model: "glm-5",
    baseUrl: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  const delegate = new MockGatewayAdapter();
  let attempts = 0;
  const flaky = {
    issueKey: async (opts: Parameters<GatewayAdapter["issueKey"]>[0]) => {
      attempts += 1;
      if (attempts === 1) throw new Error("gateway unavailable");
      return delegate.issueKey(opts);
    },
    revokeKey: (keyId: string) => delegate.revokeKey(keyId),
    listSpend: (keyIds: string[]) => delegate.listSpend(keyIds),
    readiness: () => delegate.readiness(),
  } satisfies GatewayAdapter;
  const svc = svcFor(prisma, flaky);

  await assert.rejects(
    () => svc.enroll("hara-retry", { name: "mac", os: "darwin", hara_version: "0.1.2" }),
    /gateway unavailable/,
  );
  assert.equal(prisma.db.devices.size, 0, "incomplete Device was removed");
  assert.equal(prisma.db.codes.get("hara-retry")?.usedAt, null, "code remains unused");

  const retry = await svc.enroll(
    "hara-retry",
    { name: "mac", os: "darwin", hara_version: "0.1.2" },
  );
  assert.ok(retry.device_token);
  assert.equal(prisma.db.devices.size, 1);
});

test("enroll: a post-issue database failure revokes the gateway key and removes local state", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-db-fail", {
    id: "c-db-fail",
    orgId: "o1",
    code: "hara-db-fail",
    model: "glm-5",
    baseUrl: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  const revoked: string[] = [];
  const gateway = {
    issueKey: async (opts: Parameters<GatewayAdapter["issueKey"]>[0]) => ({
      key: "sk-issued-before-db-failure",
      keyId: opts.alias,
      expiresAt: opts.expiresAt,
    }),
    revokeKey: async (keyId: string) => {
      revoked.push(keyId);
    },
    listSpend: async () => [],
    readiness: async () => ({ ok: true }),
  } satisfies GatewayAdapter;
  prisma.deviceToken.create = async () => {
    throw new Error("database write failed");
  };

  await assert.rejects(
    () =>
      svcFor(prisma, gateway).enroll(
        "hara-db-fail",
        { name: "mac", os: "darwin", hara_version: "0.1.2" },
      ),
    /database write failed/,
  );
  assert.equal(revoked.length, 1);
  assert.equal(prisma.db.devices.size, 0);
  assert.equal(prisma.db.tokens.length, 0);
  assert.equal(prisma.db.codes.get("hara-db-fail")?.usedAt, null);
});

test("heartbeat: valid token updates lastSeen + version; revoked/unknown/missing rejected", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-hb", { id: "c3", orgId: "o1", code: "hara-hb", model: "", baseUrl: null, expiresAt: new Date(Date.now() + 60_000), usedAt: null });
  const svc = svcFor(prisma);
  const res = await svc.enroll("hara-hb", { name: "mac", os: "darwin", hara_version: "0.67.0" });

  await svc.heartbeat(res.device_token, { hara_version: "0.68.0" });
  assert.equal(prisma.db.devices.get(res.device_id)!.haraVersion, "0.68.0", "heartbeat updated version");

  await assert.rejects(() => svc.heartbeat("sk-hara-mock-bogus", {}), /unknown|revoked/i);
  await assert.rejects(() => svc.heartbeat(undefined, {}), /missing/i);

  // revoke -> heartbeat rejected
  prisma.db.tokens[0].revokedAt = new Date();
  await assert.rejects(() => svc.heartbeat(res.device_token, {}), /revoked|unknown/i);
});
