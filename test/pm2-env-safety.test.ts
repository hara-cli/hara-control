import assert from "node:assert/strict";
import test from "node:test";
import { unsafePm2Environment } from "../scripts/assert-pm2-env-safe.mjs";

test("PM2 environment boundary ignores unrelated apps and accepts wrapper-only managed apps", () => {
  const processes = [
    { name: "unrelated", pm2_env: { DATABASE_URL: "not-our-process" } },
    { name: "hara-control", pm2_env: { HOME: "/root", PATH: "/usr/bin" } },
    { name: "litellm", pm2_env: { HOME: "/root", PATH: "/usr/bin" } },
  ];
  assert.deepEqual(unsafePm2Environment(processes, ["hara-control", "litellm"]), []);
});

test("PM2 environment boundary reports names only, never credential values", () => {
  const processes = [
    {
      name: "hara-control",
      pm2_env: {
        DATABASE_URL: "postgresql://sensitive",
        HARA_CONTROL_ADMIN_KEY: "sensitive-admin",
      },
    },
  ];
  assert.deepEqual(unsafePm2Environment(processes, ["hara-control"]), [
    { name: "hara-control", key: "DATABASE_URL" },
    { name: "hara-control", key: "HARA_CONTROL_ADMIN_KEY" },
  ]);
});

test("PM2 environment boundary also rejects the nested serialized environment snapshot", () => {
  const processes = [
    {
      name: "litellm",
      pm2_env: {
        env: { UPSTREAM_API_KEY: "sensitive-provider-value" },
      },
    },
  ];
  assert.deepEqual(unsafePm2Environment(processes, ["litellm"]), [
    { name: "litellm", key: "UPSTREAM_API_KEY" },
  ]);
});
