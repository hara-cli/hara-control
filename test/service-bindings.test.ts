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
  const devices = new Map<string, {
    id: string;
    orgId: string;
    deskProvisionedAt: Date | null;
    deskCleanupPendingAt: Date | null;
    deskOwner: string | null;
    deskOrigin: string | null;
  }>();
  const storedSecrets = new Map<string, Buffer>();
  const removedSecrets: string[] = [];
  const events: Array<{ action: string; payload: Record<string, unknown> }> = [];
  let rowCounter = 0;
  let provisionedDeskDevices = 0;
  let beforeBindingUpsert: (() => Promise<void>) | undefined;
  let beforeDeviceUpdate: (() => Promise<void>) | undefined;
  const key = (orgId: string, service: TenantServiceKind) => `${orgId}:${service}`;
  const mutablePrisma = {
    organization: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id === "org-1" ? { id } : null,
    },
    device: {
      count: async () => provisionedDeskDevices + [...devices.values()].filter((device) =>
        device.deskProvisionedAt !== null || device.deskCleanupPendingAt !== null).length,
      update: async ({ where: { id }, data }: {
        where: { id: string };
        data: Partial<(typeof devices extends Map<string, infer V> ? V : never)>;
      }) => {
        await beforeDeviceUpdate?.();
        const device = devices.get(id);
        assert.ok(device);
        Object.assign(device, data);
        return device;
      },
      updateMany: async ({ where, data }: {
        where: {
          id: string;
          orgId: string;
          deskProvisionedAt: null;
          deskCleanupPendingAt: { not: null };
          deskOwner: string;
          deskOrigin: string;
        };
        data: { deskCleanupPendingAt: null; deskOwner: null; deskOrigin: null };
      }) => {
        const device = devices.get(where.id);
        if (
          !device
          || device.orgId !== where.orgId
          || device.deskProvisionedAt !== null
          || device.deskCleanupPendingAt === null
          || device.deskOwner !== where.deskOwner
          || device.deskOrigin !== where.deskOrigin
        ) return { count: 0 };
        Object.assign(device, data);
        return { count: 1 };
      },
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
        await beforeBindingUpsert?.();
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
    $executeRaw: async () => 0,
  };
  let transactionTail: Promise<void> = Promise.resolve();
  mutablePrisma.$transaction = async <T>(operation: (tx: typeof mutablePrisma) => Promise<T>) => {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation(mutablePrisma);
    } finally {
      release();
    }
  };
  const prisma = mutablePrisma as unknown as PrismaService;
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
    devices,
    storedSecrets,
    removedSecrets,
    events,
    setProvisionedDeskDevices: (count: number) => { provisionedDeskDevices = count; },
    setBeforeBindingUpsert: (hook?: () => Promise<void>) => { beforeBindingUpsert = hook; },
    setBeforeDeviceUpdate: (hook?: () => Promise<void>) => { beforeDeviceUpdate = hook; },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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
    const body = JSON.stringify({
      ok: true,
      version: "test",
      deployment: {
        mode: "self-hosted",
        tenancy: "single-organization",
        realmId: "org-1",
      },
    });
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

test("a Desk binding cannot rotate or disable while provisioned devices still depend on it", async () => {
  const state = fixture();
  await state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    {
      mode: TenantServiceMode.CUSTOMER_HOSTED,
      accountRegion: TenantServiceRegion.CN,
      apiOrigin: "http://127.0.0.1:4200",
      credential: "first-control-only-secret",
    },
    actor,
  );
  state.setProvisionedDeskDevices(1);
  await assert.rejects(
    state.service.upsert(
      "org-1",
      TenantServiceKind.DESK_TASKS,
      {
        mode: TenantServiceMode.CUSTOMER_HOSTED,
        accountRegion: TenantServiceRegion.CN,
        apiOrigin: "http://127.0.0.1:4300",
        credential: "rotated-control-only-secret",
      },
      actor,
    ),
    /revoke every provisioned Desk device/,
  );
  await assert.rejects(
    state.service.disable("org-1", TenantServiceKind.DESK_TASKS, actor),
    /revoke every provisioned Desk device/,
  );
  assert.equal(state.storedSecrets.size, 1, "a rejected rotation does not persist a second secret");
  state.setProvisionedDeskDevices(0);
  const disabled = await state.service.disable(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    actor,
  );
  assert.equal(disabled.status, TenantServiceStatus.DISABLED);
});

test("Desk binding rotation wins the shared lock before enrollment reservation", async () => {
  const state = fixture();
  await state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    {
      mode: TenantServiceMode.CUSTOMER_HOSTED,
      accountRegion: TenantServiceRegion.CN,
      apiOrigin: "https://desk-old.example.invalid",
      credential: "first-control-only-secret",
    },
    actor,
  );
  [...state.rows.values()][0].status = TenantServiceStatus.ACTIVE;
  state.devices.set("device-rotation-wins", {
    id: "device-rotation-wins",
    orgId: "org-1",
    deskProvisionedAt: null,
    deskCleanupPendingAt: null,
    deskOwner: null,
    deskOrigin: null,
  });
  const rotationEntered = deferred();
  const finishRotation = deferred();
  state.setBeforeBindingUpsert(async () => {
    rotationEntered.resolve();
    await finishRotation.promise;
  });
  const rotating = state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    {
      mode: TenantServiceMode.CUSTOMER_HOSTED,
      accountRegion: TenantServiceRegion.CN,
      apiOrigin: "https://desk-new.example.invalid",
      credential: "second-control-only-secret",
    },
    actor,
  );
  await rotationEntered.promise;
  const reserving = state.service.reserveDeskProvisioning({
    orgId: "org-1",
    deviceId: "device-rotation-wins",
    owner: "member@example.invalid",
    preparedAt: new Date("2026-09-11T08:00:00.000Z"),
    legacyOrigin: "https://legacy.example.invalid",
  });
  finishRotation.resolve();
  await rotating;
  const reservation = await reserving;
  assert.deepEqual(reservation, { managedConfigured: true, prepared: false });
  assert.equal(state.devices.get("device-rotation-wins")?.deskCleanupPendingAt, null);
  assert.equal([...state.rows.values()][0].apiOrigin, "https://desk-new.example.invalid");
  assert.equal([...state.rows.values()][0].status, TenantServiceStatus.PENDING_VERIFICATION);
});

test("Desk enrollment reservation wins the shared lock and blocks concurrent rotation", async () => {
  const state = fixture();
  await state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    {
      mode: TenantServiceMode.CUSTOMER_HOSTED,
      accountRegion: TenantServiceRegion.CN,
      apiOrigin: "https://desk-old.example.invalid",
      credential: "first-control-only-secret",
    },
    actor,
  );
  [...state.rows.values()][0].status = TenantServiceStatus.ACTIVE;
  state.devices.set("device-reservation-wins", {
    id: "device-reservation-wins",
    orgId: "org-1",
    deskProvisionedAt: null,
    deskCleanupPendingAt: null,
    deskOwner: null,
    deskOrigin: null,
  });
  const reservationEntered = deferred();
  const finishReservation = deferred();
  state.setBeforeDeviceUpdate(async () => {
    reservationEntered.resolve();
    await finishReservation.promise;
  });
  const reserving = state.service.reserveDeskProvisioning({
    orgId: "org-1",
    deviceId: "device-reservation-wins",
    owner: "member@example.invalid",
    preparedAt: new Date("2026-09-11T08:00:00.000Z"),
    legacyOrigin: "https://legacy.example.invalid",
  });
  await reservationEntered.promise;
  const rotating = state.service.upsert(
    "org-1",
    TenantServiceKind.DESK_TASKS,
    {
      mode: TenantServiceMode.CUSTOMER_HOSTED,
      accountRegion: TenantServiceRegion.CN,
      apiOrigin: "https://desk-new.example.invalid",
      credential: "second-control-only-secret",
    },
    actor,
  );
  finishReservation.resolve();
  const reservation = await reserving;
  assert.equal(reservation.managedConfigured, true);
  assert.equal(reservation.prepared, true);
  assert.equal(reservation.target?.url, "https://desk-old.example.invalid");
  reservation.target?.enrollKey.fill(0);
  await assert.rejects(rotating, /revoke every provisioned Desk device/);
  assert.equal([...state.rows.values()][0].apiOrigin, "https://desk-old.example.invalid");
  assert.ok(state.devices.get("device-reservation-wins")?.deskCleanupPendingAt instanceof Date);
});

test("Desk readiness rejects a healthy instance bound to another organization realm", async () => {
  const health = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      deployment: {
        mode: "self-hosted",
        tenancy: "single-organization",
        realmId: "org-other",
      },
    }));
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
      state.service.verify("org-1", TenantServiceKind.DESK_TASKS, actor),
      /readiness check failed/,
    );
    assert.equal([...state.rows.values()][0].status, TenantServiceStatus.DEGRADED);
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
    const revocation = await state.service.deskRevocationResolution(
      "org-1",
      health.origin,
    );
    assert.equal(revocation.managedConfigured, true);
    assert.equal(revocation.target?.url, health.origin);
    assert.equal(revocation.target?.enrollKey.toString("utf8"), "desk-enrollment-secret");
    revocation.target?.enrollKey.fill(0);
    await assert.rejects(
      state.service.deskRevocationResolution(
        "org-1",
        "https://another-desk.example.invalid",
      ),
      /does not match the enrolled installation origin/,
    );
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
