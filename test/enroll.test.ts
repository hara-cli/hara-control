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
import type { DeskProvisioner } from "../src/enroll/desk-provisioner";
import type { TenantServiceBindingsService } from "../src/service-bindings/service-bindings.service";

type Code = {
  id: string;
  orgId: string;
  code: string;
  model: string;
  reasoningEffort?: string;
  baseUrl: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  tokenTtlMinutes?: number | null;
  tokenNeverExpires?: boolean;
  budgetLimits?: unknown;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  personId?: string | null;
};
type Dev = { id: string; orgId: string; name: string; os: string; haraVersion: string; lastSeenAt: Date; enrollCodeId: string };
type Tok = {
  id: string;
  deviceId: string;
  tokenHash: string;
  gatewayKeyId: string;
  model: string;
  reasoningEffort?: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  budgetLimits?: unknown;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
};

function fakePrisma() {
  const db = { codes: new Map<string, Code>(), devices: new Map<string, Dev>(), tokens: [] as Tok[] };
  let n = 0;
  const id = () => `id_${++n}`;
  const prisma = {
    db,
    organization: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => ({ id, name: `Organization ${id}` }),
    },
    person: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => ({ id, orgId: "o1", email: `${id}@example.test` }),
    },
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

test("enroll: a legacy cross-organization Person binding fails before consuming the code", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-cross-org", {
    id: "c-cross-org",
    orgId: "o1",
    code: "hara-cross-org",
    model: "glm-5",
    baseUrl: null,
    personId: "person-b",
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  prisma.person.findUnique = async () => ({ id: "person-b", orgId: "o2", email: "person-b@example.test" });
  const service = svcFor(prisma);

  await assert.rejects(
    () => service.enroll("hara-cross-org", { name: "laptop", os: "macOS", hara_version: "0.1.0" }),
    /bad or expired code/,
  );
  assert.equal(prisma.db.codes.get("hara-cross-org")?.usedAt, null);
  assert.equal(prisma.db.devices.size, 0);
});

const fakeAudit = { log: async () => {} } as unknown as AuditService;
const fakeEntitlement = { assert: () => {}, seatCheck: async () => {} } as unknown as import("../src/license/license.service").EntitlementService;
const svcFor = (
  prisma: ReturnType<typeof fakePrisma>,
  gateway: GatewayAdapter = new MockGatewayAdapter(),
  deskProvisioner?: DeskProvisioner,
  audit: AuditService = fakeAudit,
  serviceBindings?: TenantServiceBindingsService,
) =>
  new EnrollService(
    prisma as unknown as PrismaService,
    audit,
    gateway,
    fakeEntitlement,
    deskProvisioner,
    serviceBindings,
  );

test("enroll: valid code -> device token; code is single-use", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-good", { id: "c1", orgId: "o1", code: "hara-good", model: "glm-5", baseUrl: null, expiresAt: new Date(Date.now() + 60_000), usedAt: null });
  const svc = svcFor(prisma);

  const res = await svc.enroll("hara-good", { name: "mac", os: "darwin", hara_version: "0.68.0" });
  assert.ok(res.device_token.startsWith("sk-hara-mock-"), "issued a device token");
  assert.equal(res.model, "glm-5");
  assert.deepEqual(res.available_models, ["glm-5"]);
  assert.deepEqual(res.thinking_efforts, []);
  assert.deepEqual(res.model_capabilities, [{ model: "glm-5", thinking_efforts: [] }]);
  assert.equal(res.default_reasoning_effort, null);
  assert.equal(res.tenant_id, "o1");
  assert.equal(res.tenant_name, "Organization o1");
  assert.ok(res.device_id, "returned a device id");
  assert.equal(prisma.db.tokens.length, 1, "stored exactly one token");
  assert.ok(prisma.db.tokens[0].tokenHash && prisma.db.tokens[0].tokenHash !== res.device_token, "stored the HASH, not the raw token");
  assert.equal(res.expires_at, prisma.db.tokens[0].expiresAt.toISOString(), "client and control plane use the gateway expiry");

  await assert.rejects(() => svc.enroll("hara-good", { name: "mac2", os: "darwin", hara_version: "0.68.0" }), /expired|bad/i, "code can't be reused");
});

test("enroll: configured organization returns model access and a separate Desk binding together", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-bundle", {
    id: "c-bundle",
    orgId: "o-bundle",
    code: "hara-bundle",
    model: "glm-5",
    baseUrl: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  let provisionInput: { orgId: string; owner: string; deviceName: string } | undefined;
  const deskProvisioner = {
    provision: async (input: { orgId: string; owner: string; deviceName: string }) => {
      provisionInput = input;
      return {
        url: "https://desk.example.test",
        agent_id: "desk-device-1",
        owner: input.owner,
        token: "separate-desk-bearer",
      };
    },
  } as unknown as DeskProvisioner;
  const result = await svcFor(
    prisma,
    new MockGatewayAdapter(),
    deskProvisioner,
  ).enroll("hara-bundle", {
    name: "bundle-mac",
    os: "darwin",
    hara_version: "0.136.0",
  });

  assert.equal(result.device_id, prisma.db.tokens[0].deviceId);
  assert.deepEqual(result.desk, {
    url: "https://desk.example.test",
    agent_id: "desk-device-1",
    owner: "bundle-mac",
    token: "separate-desk-bearer",
  });
  assert.deepEqual(provisionInput, {
    orgId: "o-bundle",
    owner: "bundle-mac",
    deviceName: "bundle-mac",
  });
});

test("enroll: one exchange returns only active redacted organization service descriptors", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-services", {
    id: "c-services",
    orgId: "o-services",
    code: "hara-services",
    model: "glm-5",
    baseUrl: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  const serviceBindings = {
    activeForEnrollment: async () => [{
      tenant_id: "o-services",
      service: "COLLAB",
      mode: "HARA_HOSTED",
      account_region: "GLOBAL",
      api_origin: "https://collab.example.test",
      issuer: "https://account.example.test",
      jwks_uri: "https://account.example.test/.well-known/jwks.json",
      audience: "hara-collab",
      status: "ACTIVE",
      capabilities_version: 1,
      config_version: 3,
    }],
  } as unknown as TenantServiceBindingsService;
  const result = await svcFor(
    prisma,
    new MockGatewayAdapter(),
    undefined,
    fakeAudit,
    serviceBindings,
  ).enroll("hara-services", {
    name: "services-mac",
    os: "darwin",
    hara_version: "0.140.0",
  });

  assert.deepEqual(result.service_bindings, [{
    tenant_id: "o-services",
    service: "COLLAB",
    mode: "HARA_HOSTED",
    account_region: "GLOBAL",
    api_origin: "https://collab.example.test",
    issuer: "https://account.example.test",
    jwks_uri: "https://account.example.test/.well-known/jwks.json",
    audience: "hara-collab",
    status: "ACTIVE",
    capabilities_version: 1,
    config_version: 3,
  }]);
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("enroll: a Desk provisioning failure rolls back model access, restores the code, and audits the rollback", async () => {
  const prisma = fakePrisma();
  prisma.db.codes.set("hara-desk-retry", {
    id: "c-desk-retry",
    orgId: "o-desk-retry",
    code: "hara-desk-retry",
    model: "glm-5",
    baseUrl: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  const auditEvents: Array<{
    action: string;
    actorType: string;
    actorId: string;
    payload: Record<string, unknown>;
  }> = [];
  const audit = {
    log: async (
      _orgId: string,
      action: string,
      actorType: string,
      actorId: string,
      payload: Record<string, unknown>,
    ) => {
      auditEvents.push({ action, actorType, actorId, payload });
    },
  } as unknown as AuditService;
  const deskProvisioner = {
    provision: async () => {
      throw new Error("Desk rejected server-held-secret-value");
    },
  } as unknown as DeskProvisioner;

  await assert.rejects(
    () => svcFor(
      prisma,
      new MockGatewayAdapter(),
      deskProvisioner,
      audit,
    ).enroll(
      "hara-desk-retry",
      { name: "bundle-mac", os: "darwin", hara_version: "0.136.0" },
    ),
    /Desk rejected/,
  );

  assert.equal(prisma.db.devices.size, 0);
  assert.equal(prisma.db.tokens.length, 0);
  assert.equal(prisma.db.codes.get("hara-desk-retry")?.usedAt, null);
  assert.deepEqual(
    auditEvents.map(({ action, actorType, payload }) => ({
      action,
      actorType,
      payload,
    })),
    [
      {
        action: "enroll",
        actorType: "device",
        payload: {
          name: "bundle-mac",
          os: "darwin",
          accessPolicy: auditEvents[0].payload.accessPolicy,
        },
      },
      {
        action: "enroll.rollback",
        actorType: "system",
        payload: {
          gatewayRevoked: true,
          deviceRemoved: true,
          codeRestored: true,
        },
      },
    ],
  );
  assert.equal(
    JSON.stringify(auditEvents).includes("server-held-secret-value"),
    false,
    "rollback audit never records the upstream error or secret",
  );
});

test("enroll: applies and persists the admin-issued lifetime, rolling budgets, RPM, and TPM", async () => {
  const prisma = fakePrisma();
  const now = new Date("2026-07-22T00:00:00Z");
  prisma.db.codes.set("hara-limited", {
    id: "c-limited",
    orgId: "o1",
    code: "hara-limited",
    model: "deepseek-chat",
    reasoningEffort: "high",
    baseUrl: null,
    expiresAt: new Date("2026-07-22T01:00:00Z"),
    usedAt: null,
    tokenTtlMinutes: 2 * 24 * 60,
    budgetLimits: [
      { window: "5h", maxUsd: 2, budgetDuration: "5h" },
      { window: "week", maxUsd: 20, budgetDuration: "7d" },
      { window: "month", maxUsd: 60, budgetDuration: "30d" },
    ],
    rpmLimit: 30,
    tpmLimit: 120_000,
  });
  let issuedOpts: Parameters<GatewayAdapter["issueKey"]>[0] | null = null;
  const delegate = new MockGatewayAdapter();
  const gateway = {
    issueKey: async (opts: Parameters<GatewayAdapter["issueKey"]>[0]) => {
      issuedOpts = opts;
      return delegate.issueKey(opts);
    },
    revokeKey: (keyId: string) => delegate.revokeKey(keyId),
    listSpend: (keyIds: string[]) => delegate.listSpend(keyIds),
    readiness: () => delegate.readiness(),
  } satisfies GatewayAdapter;

  const result = await svcFor(prisma, gateway).enroll(
    "hara-limited",
    { name: "limited-mac", os: "darwin", hara_version: "0.132.4" },
    now,
  );

  assert.equal(issuedOpts!.expiresAt.toISOString(), "2026-07-24T00:00:00.000Z");
  assert.deepEqual(issuedOpts!.limits, {
    budgetLimits: [
      { budgetDuration: "5h", maxBudgetUsd: 2 },
      { budgetDuration: "7d", maxBudgetUsd: 20 },
      { budgetDuration: "30d", maxBudgetUsd: 60 },
    ],
    rpmLimit: 30,
    tpmLimit: 120_000,
  });
  assert.equal(result.expires_at, "2026-07-24T00:00:00.000Z");
  assert.deepEqual(result.available_models, ["deepseek-chat"]);
  assert.deepEqual(result.thinking_efforts, ["off", "low", "high", "max"]);
  assert.equal(result.default_reasoning_effort, "high");
  assert.equal(prisma.db.tokens[0].reasoningEffort, "high");
  assert.equal(result.access_policy.tokenTtlMinutes, 2 * 24 * 60);
  assert.equal(prisma.db.tokens[0].rpmLimit, 30);
  assert.equal(prisma.db.tokens[0].tpmLimit, 120_000);
  assert.deepEqual(prisma.db.tokens[0].budgetLimits, result.access_policy.budgetLimits);
});

test("enroll: explicitly non-expiring personal keys remain budgeted, visible, and revocable", async () => {
  const prisma = fakePrisma();
  const now = new Date("2026-08-05T03:00:00Z");
  prisma.db.codes.set("hara-personal", {
    id: "c-personal",
    orgId: "o1",
    code: "hara-personal",
    model: "deepseek-v4-flash",
    baseUrl: null,
    expiresAt: new Date("2026-08-12T03:00:00Z"),
    usedAt: null,
    tokenTtlMinutes: null,
    tokenNeverExpires: true,
    budgetLimits: [{ window: "month", maxUsd: 100, budgetDuration: "30d" }],
    rpmLimit: null,
    tpmLimit: null,
  });
  let issuedOpts: Parameters<GatewayAdapter["issueKey"]>[0] | null = null;
  const delegate = new MockGatewayAdapter();
  const gateway = {
    issueKey: async (opts: Parameters<GatewayAdapter["issueKey"]>[0]) => {
      issuedOpts = opts;
      return delegate.issueKey(opts);
    },
    syncKeyModels: (keyId: string, models: string[]) => delegate.syncKeyModels(keyId, models),
    revokeKey: (keyId: string) => delegate.revokeKey(keyId),
    listSpend: (keyIds: string[]) => delegate.listSpend(keyIds),
    usage: () => delegate.usage(),
    readiness: () => delegate.readiness(),
  } satisfies GatewayAdapter;

  const result = await svcFor(prisma, gateway).enroll(
    "hara-personal",
    { name: "personal-mac", os: "darwin", hara_version: "0.139.0" },
    now,
  );

  assert.equal(issuedOpts!.expiresAt, null);
  assert.equal(result.expires_at, null);
  assert.equal(prisma.db.tokens[0].expiresAt, null);
  assert.equal(result.access_policy.tokenNeverExpires, true);
  assert.deepEqual(issuedOpts!.limits, {
    budgetLimits: [{ budgetDuration: "30d", maxBudgetUsd: 100 }],
  });
});

test("formal managed enrollment and heartbeat expose all three models on the same unchanged device key", async () => {
  const previous = {
    gateway: process.env.GATEWAY_ADAPTER,
    allowed: process.env.HARA_ALLOWED_MODELS,
    selectedDefault: process.env.HARA_DEFAULT_MODEL,
  };
  process.env.GATEWAY_ADAPTER = "litellm";
  process.env.HARA_ALLOWED_MODELS = "deepseek-v4-flash,deepseek-v4-pro,deepseek-v4-flash-vision-exp";
  process.env.HARA_DEFAULT_MODEL = "deepseek-v4-flash";
  try {
    const prisma = fakePrisma();
    prisma.db.codes.set("hara-multi", {
      id: "c-multi",
      orgId: "o1",
      code: "hara-multi",
      model: "deepseek-chat",
      reasoningEffort: "max",
      baseUrl: null,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const delegate = new MockGatewayAdapter();
    let issued: Parameters<GatewayAdapter["issueKey"]>[0] | null = null;
    const synchronized: Array<{ keyId: string; models: string[] }> = [];
    const gateway = {
      issueKey: async (opts: Parameters<GatewayAdapter["issueKey"]>[0]) => {
        issued = opts;
        return delegate.issueKey(opts);
      },
      syncKeyModels: async (keyId: string, models: string[]) => {
        synchronized.push({ keyId, models });
        return delegate.syncKeyModels(keyId, models);
      },
      revokeKey: (keyId: string) => delegate.revokeKey(keyId),
      listSpend: (keyIds: string[]) => delegate.listSpend(keyIds),
      usage: () => delegate.usage(),
      readiness: () => delegate.readiness(),
    } satisfies GatewayAdapter;
    const service = svcFor(prisma, gateway);
    const enrolled = await service.enroll(
      "hara-multi",
      { name: "winter-mac", os: "darwin", hara_version: "0.134.2" },
    );

    assert.equal(enrolled.model, "deepseek-v4-flash");
    assert.deepEqual(enrolled.available_models, [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
    assert.equal(enrolled.default_reasoning_effort, "max");
    assert.deepEqual(enrolled.model_capabilities, [
      { model: "deepseek-v4-flash", thinking_efforts: ["off", "low", "high", "max"] },
      { model: "deepseek-v4-pro", thinking_efforts: ["off", "low", "high", "max"] },
      { model: "deepseek-v4-flash-vision-exp", thinking_efforts: ["off", "low", "high", "max"] },
    ]);
    assert.deepEqual(issued!.models, [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
    const originalDeviceToken = enrolled.device_token;
    // Simulate a key issued before canonical V4 ids existed. New clients should see only the
    // canonical catalog, while the old persisted alias remains usable at the data plane.
    prisma.db.tokens[0].model = "deepseek-chat";
    const heartbeat = await service.heartbeat(
      originalDeviceToken,
      { hara_version: "0.134.2", os: "darwin" },
    );
    assert.deepEqual(heartbeat.available_models, [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
    assert.equal(heartbeat.default_reasoning_effort, "max");
    assert.equal(enrolled.device_token, originalDeviceToken, "the user-facing key is not rotated");
    assert.deepEqual(synchronized, [{
      keyId: enrolled.device_id,
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp", "deepseek-chat"],
    }]);
  } finally {
    if (previous.gateway === undefined) delete process.env.GATEWAY_ADAPTER;
    else process.env.GATEWAY_ADAPTER = previous.gateway;
    if (previous.allowed === undefined) delete process.env.HARA_ALLOWED_MODELS;
    else process.env.HARA_ALLOWED_MODELS = previous.allowed;
    if (previous.selectedDefault === undefined) delete process.env.HARA_DEFAULT_MODEL;
    else process.env.HARA_DEFAULT_MODEL = previous.selectedDefault;
  }
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
