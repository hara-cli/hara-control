import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  AdminRole,
  TenantServiceKind,
  TenantServiceMode,
  TenantServiceRegion,
  TenantServiceStatus,
  type TenantServiceBinding,
} from "@prisma/client";
import type { AuditService } from "../src/audit/audit.service";
import type { AuthedUser } from "../src/common/admin-auth.guard";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { SecretsService } from "../src/security/secrets.service";
import { TenantServiceBindingsService } from "../src/service-bindings/service-bindings.service";

const actor: AuthedUser = {
  id: "admin-1",
  email: "admin@example.invalid",
  role: AdminRole.SUPERADMIN,
};

function fixture() {
  const rows = new Map<string, TenantServiceBinding>();
  const storedSecrets = new Map<string, Buffer>();
  const removedSecrets: string[] = [];
  const events: Array<{ action: string; payload: Record<string, unknown> }> = [];
  let rowCounter = 0;
  const key = (orgId: string, service: TenantServiceKind) => `${orgId}:${service}`;
  const prisma = {
    organization: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id === "org-1" ? { id } : null,
    },
    tenantServiceBinding: {
      findMany: async ({ where }: {
        where: { orgId: string; status?: TenantServiceStatus };
      }) => [...rows.values()]
        .filter((row) => row.orgId === where.orgId && (!where.status || row.status === where.status))
        .sort((left, right) => left.service.localeCompare(right.service)),
      findUnique: async ({ where: { orgId_service } }: {
        where: { orgId_service: { orgId: string; service: TenantServiceKind } };
      }) => rows.get(key(orgId_service.orgId, orgId_service.service)) ?? null,
      upsert: async ({ where: { orgId_service }, create, update }: {
        where: { orgId_service: { orgId: string; service: TenantServiceKind } };
        create: Partial<TenantServiceBinding>;
        update: Partial<TenantServiceBinding> & { configVersion?: { increment: number } | number };
      }) => {
        const recordKey = key(orgId_service.orgId, orgId_service.service);
        const existing = rows.get(recordKey);
        const now = new Date("2026-08-05T12:00:00.000Z");
        if (!existing) {
          const row = {
            id: `binding-${++rowCounter}`,
            createdAt: now,
            updatedAt: now,
            ...create,
          } as TenantServiceBinding;
          rows.set(recordKey, row);
          return row;
        }
        const increment = typeof update.configVersion === "object"
          ? update.configVersion.increment
          : 0;
        const row = {
          ...existing,
          ...update,
          configVersion: typeof update.configVersion === "number"
            ? update.configVersion
            : existing.configVersion + increment,
          updatedAt: now,
        } as TenantServiceBinding;
        rows.set(recordKey, row);
        return row;
      },
      update: async ({ where: { id }, data }: {
        where: { id: string };
        data: Partial<TenantServiceBinding> & { configVersion?: { increment: number } | number };
      }) => {
        const entry = [...rows.entries()].find(([, row]) => row.id === id);
        assert.ok(entry);
        const [recordKey, existing] = entry;
        const increment = typeof data.configVersion === "object"
          ? data.configVersion.increment
          : 0;
        const row = {
          ...existing,
          ...data,
          configVersion: typeof data.configVersion === "number"
            ? data.configVersion
            : existing.configVersion + increment,
          updatedAt: new Date("2026-08-05T12:05:00.000Z"),
        } as TenantServiceBinding;
        rows.set(recordKey, row);
        return row;
      },
    },
  } as unknown as PrismaService;
  const secrets = {
    put: async (orgId: string, name: string, value: string) => {
      storedSecrets.set(`${orgId}:${name}`, Buffer.from(value));
    },
    get: async (orgId: string, name: string) => {
      const value = storedSecrets.get(`${orgId}:${name}`);
      return value ? Buffer.from(value) : null;
    },
    remove: async (orgId: string, name: string) => {
      removedSecrets.push(name);
      storedSecrets.delete(`${orgId}:${name}`);
    },
  } as unknown as SecretsService;
  const audit = {
    log: async (
      _orgId: string,
      action: string,
      _actorType: string,
      _actorId: string,
      payload: Record<string, unknown>,
    ) => {
      events.push({ action, payload });
    },
  } as unknown as AuditService;
  return {
    service: new TenantServiceBindingsService(prisma, secrets, audit),
    rows,
    storedSecrets,
    removedSecrets,
    events,
  };
}

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

test("Desk binding stores its credential separately, verifies readiness, and enrolls with a redacted descriptor", async () => {
  const health = await listen((request, response) => {
    assert.equal(request.url, "/health");
    const body = '{"ok":true,"version":"test"}';
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  const state = fixture();
  try {
    const pending = await state.service.upsert(
      "org-1",
      TenantServiceKind.DESK_TASKS,
      {
        mode: TenantServiceMode.CUSTOMER_HOSTED,
        accountRegion: TenantServiceRegion.CN,
        apiOrigin: health.origin,
        credential: "desk-enrollment-secret",
        capabilitiesVersion: 2,
      },
      actor,
    );
    assert.equal(pending.status, TenantServiceStatus.PENDING_VERIFICATION);
    assert.equal(pending.credentialConfigured, true);
    assert.equal(JSON.stringify(pending).includes("desk-enrollment-secret"), false);
    assert.equal(state.storedSecrets.size, 1);

    const active = await state.service.verify(
      "org-1",
      TenantServiceKind.DESK_TASKS,
      actor,
    );
    assert.equal(active.status, TenantServiceStatus.ACTIVE);
    const descriptors = await state.service.activeForEnrollment("org-1");
    assert.deepEqual(descriptors, [{
      tenant_id: "org-1",
      service: TenantServiceKind.DESK_TASKS,
      mode: TenantServiceMode.CUSTOMER_HOSTED,
      account_region: TenantServiceRegion.CN,
      api_origin: health.origin,
      status: "ACTIVE",
      capabilities_version: 2,
      config_version: 1,
    }]);
    assert.equal(JSON.stringify(descriptors).includes("credential"), false);

    const target = await state.service.deskProvisioningTarget("org-1");
    assert.equal(target?.url, health.origin);
    assert.equal(target?.enrollKey.toString("utf8"), "desk-enrollment-secret");
    target?.enrollKey.fill(0);

    await state.service.disable(
      "org-1",
      TenantServiceKind.DESK_TASKS,
      actor,
    );
    assert.deepEqual(await state.service.activeForEnrollment("org-1"), []);
    assert.deepEqual(state.events.map((entry) => entry.action), [
      "tenant-service.configure",
      "tenant-service.verify",
      "tenant-service.disable",
    ]);
    assert.equal(
      JSON.stringify(state.events).includes("desk-enrollment-secret"),
      false,
    );
  } finally {
    await health.close();
  }
});

test("rotating a Desk credential uses a new encrypted record and retires the old reference", async () => {
  const state = fixture();
  const input = {
    mode: TenantServiceMode.HARA_HOSTED,
    accountRegion: TenantServiceRegion.GLOBAL,
    apiOrigin: "https://desk.example.invalid",
  };
  await state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    { ...input, credential: "first-secret" },
    actor,
  );
  const firstRef = [...state.rows.values()][0].credentialRef;
  await state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    { ...input, credential: "second-secret" },
    actor,
  );
  const secondRef = [...state.rows.values()][0].credentialRef;
  assert.notEqual(firstRef, secondRef);
  assert.deepEqual(state.removedSecrets, [firstRef]);
  assert.equal(state.storedSecrets.size, 1);
  assert.equal([...state.storedSecrets.values()][0].toString(), "second-secret");
});

test("a failed readiness verification marks the binding degraded without exposing its credential", async () => {
  const health = await listen((_request, response) => {
    const body = '{"ok":false,"reason":"not-ready"}';
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  const state = fixture();
  try {
    await state.service.upsert(
      "org-1",
      TenantServiceKind.DESK_TASKS,
      {
        mode: TenantServiceMode.CUSTOMER_HOSTED,
        accountRegion: TenantServiceRegion.CN,
        apiOrigin: health.origin,
        credential: "desk-enrollment-secret",
      },
      actor,
    );

    await assert.rejects(
      state.service.verify(
        "org-1",
        TenantServiceKind.DESK_TASKS,
        actor,
      ),
      /readiness check failed/,
    );

    const row = [...state.rows.values()][0];
    assert.equal(row.status, TenantServiceStatus.DEGRADED);
    assert.equal(row.verifiedAt, null);
    assert.equal(state.events.at(-1)?.action, "tenant-service.verify-failed");
    assert.equal(JSON.stringify(state.events).includes("desk-enrollment-secret"), false);
  } finally {
    await health.close();
  }
});

test("Collab requires explicit trust metadata and rejects credential-bearing or insecure endpoints", async () => {
  const state = fixture();
  await assert.rejects(
    state.service.upsert(
      "org-1",
      TenantServiceKind.COLLAB,
      {
        mode: TenantServiceMode.HARA_HOSTED,
        accountRegion: TenantServiceRegion.GLOBAL,
        apiOrigin: "https://user:password@collab.example.invalid",
      },
      actor,
    ),
    /credentials|apiOrigin/,
  );
  await assert.rejects(
    state.service.upsert(
      "org-1",
      TenantServiceKind.COLLAB,
      {
        mode: TenantServiceMode.HARA_HOSTED,
        accountRegion: TenantServiceRegion.GLOBAL,
        apiOrigin: "https://collab.example.invalid",
      },
      actor,
    ),
    /requires issuer, jwksUri, and audience/,
  );
  await assert.rejects(
    state.service.upsert(
      "org-1",
      TenantServiceKind.MODEL_CONTROL,
      {
        mode: TenantServiceMode.HARA_HOSTED,
        accountRegion: TenantServiceRegion.CN,
        apiOrigin: "http://control.example.invalid",
      },
      actor,
    ),
    /HTTPS/,
  );
});
