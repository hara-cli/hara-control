import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { GatewayAdapter } from "../src/gateway/gateway-adapter";
import { HealthService } from "../src/health/health.service";

const originalEnv = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnv };
});

test("readiness reports only boolean checks and is ready for a healthy LiteLLM deployment", async () => {
  process.env.DATABASE_URL = "postgresql://redacted";
  process.env.GATEWAY_ADAPTER = "litellm";
  process.env.LITELLM_URL = "http://127.0.0.1:4000";
  process.env.LITELLM_MASTER_KEY = "master-redacted";
  process.env.LITELLM_DATABASE_URL = "postgresql://redacted/litellm?schema=litellm";
  const prisma = { $queryRaw: async () => [{ "?column?": 1 }] } as unknown as PrismaService;
  const gateway = { readiness: async () => ({ ok: true }) } as unknown as GatewayAdapter;
  const result = await new HealthService(prisma, gateway).ready();
  assert.deepEqual(result, {
    status: "ok",
    checks: { database: true, gateway: true, configuration: true },
  });
  assert.equal(JSON.stringify(result).includes("redacted"), false);
});

test("readiness fails closed when database, gateway or required runtime config is missing", async () => {
  delete process.env.DATABASE_URL;
  process.env.GATEWAY_ADAPTER = "litellm";
  delete process.env.LITELLM_DATABASE_URL;
  const prisma = {
    $queryRaw: async () => {
      throw new Error("database details must not escape");
    },
  } as unknown as PrismaService;
  const gateway = { readiness: async () => ({ ok: false }) } as unknown as GatewayAdapter;
  const result = await new HealthService(prisma, gateway).ready();
  assert.equal(result.status, "not_ready");
  assert.deepEqual(result.checks, { database: false, gateway: false, configuration: false });
  assert.equal(JSON.stringify(result).includes("database details"), false);
});
