import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditService } from "../src/audit/audit.service";
import type { AuthedUser } from "../src/common/admin-auth.guard";
import type { GatewayAdapter } from "../src/gateway/gateway-adapter";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { SecretsService } from "../src/security/secrets.service";
import {
  DEEPSEEK_DIRECT_PROBE_MODEL,
  ProviderCredentialsService,
} from "../src/providers/provider-credentials.service";

const actor: AuthedUser = {
  id: "admin-1",
  email: "admin@example.invalid",
  role: "SUPERADMIN",
};

test("stored credential probe uses the current DeepSeek V4 API name, not a retiring legacy name", () => {
  assert.equal(DEEPSEEK_DIRECT_PROBE_MODEL, "deepseek-v4-flash");
});
function fixtures(
  initial: string | null = null,
  activeVersion: number | null = null,
  runtimeReachable = true,
) {
  let stored = initial === null ? null : Buffer.from(initial);
  let updatedAt = initial === null ? null : new Date("2026-07-20T00:00:00Z");
  let version = initial === null ? null : 1;
  const events: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const secrets = {
    describe: async () => ({
      exists: stored !== null,
      version,
      createdAt: updatedAt,
      updatedAt,
    }),
    get: async () => (stored ? Buffer.from(stored) : null),
    putWithSystemAudit: async (
      _orgId: null,
      _name: string,
      value: Buffer,
      event: { action: string; payload: Record<string, unknown> },
    ) => {
      stored?.fill(0);
      stored = Buffer.from(value);
      updatedAt = new Date("2026-07-20T01:00:00Z");
      version = (version ?? 0) + 1;
      events.push({ action: event.action, payload: event.payload });
    },
  } as unknown as SecretsService;
  const audit = {
    logSystem: async (action: string, _actorType: string, _actorId: string, payload: Record<string, unknown>) => {
      events.push({ action, payload });
    },
  } as unknown as AuditService;
  const prisma = {
    providerActivation: {
      findUnique: async () =>
        activeVersion === null
          ? null
          : {
              provider: "deepseek",
              secretName: "provider.deepseek.api_key",
              secretVersion: activeVersion,
              runtimeId: "runtime-test",
              activatedAt: new Date("2026-07-20T00:30:00Z"),
            },
    },
  } as unknown as PrismaService;
  const gateway = {
    readiness: async () => ({ ok: runtimeReachable }),
  } as unknown as GatewayAdapter;
  return {
    service: new ProviderCredentialsService(secrets, audit, prisma, gateway),
    events,
    getStored: () => stored,
  };
}

test("status distinguishes encrypted storage from the active LiteLLM runtime without exposing values", async () => {
  const { service } = fixtures("sk-stored-value", 0);
  const status = await service.deepSeekStatus();
  assert.equal(status.stored, true);
  assert.equal(status.runtime_configured, true);
  assert.equal(status.active, false);
  assert.equal(status.requires_activation, true);
  assert.equal(status.activation, "deploy-restart-required");
  const json = JSON.stringify(status);
  assert.equal(json.includes("sk-runtime"), false);
  assert.equal(json.includes("sk-stored"), false);
});

test("store rotates encrypted source-of-truth, never echoes/logs the credential, and requires activation", async () => {
  const { service, events, getStored } = fixtures("sk-old-value", 1);
  const status = await service.putDeepSeek("sk-replacement-value", actor);
  assert.equal(status.active, false, "a newly stored revision is not active until controlled restart");
  assert.equal(status.requires_activation, true);
  assert.equal(getStored()?.toString("utf8"), "sk-replacement-value");
  assert.deepEqual(events, [
    {
      action: "provider.credential.store",
      payload: { provider: "deepseek", operation: "replace" },
    },
  ]);
  assert.equal(JSON.stringify({ status, events }).includes("sk-replacement-value"), false);
});

test("status reports active only when the supervised runtime loaded the current non-secret revision", async () => {
  const { service } = fixtures("sk-current-value", 1);
  const status = await service.deepSeekStatus();
  assert.equal(status.runtime_configured, true);
  assert.equal(status.active, true);
  assert.equal(status.requires_activation, false);
  assert.equal(status.activated_at?.toISOString(), "2026-07-20T00:30:00.000Z");
});

test("status rejects a stale activation record when the supervised runtime is unreachable", async () => {
  const { service } = fixtures("sk-current-value", 1, false);
  const status = await service.deepSeekStatus();
  assert.equal(status.runtime_configured, true);
  assert.equal(status.runtime_reachable, false);
  assert.equal(status.active, false);
  assert.equal(status.requires_activation, true);
});
