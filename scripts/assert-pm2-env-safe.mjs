#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_ENV_NAMES = new Set([
  "DATABASE_URL",
  "LITELLM_DATABASE_URL",
  "HARA_CONTROL_ADMIN_KEY",
  "HARA_JWT_SECRET",
  "HARA_KMS_MASTER_KEY",
  "HARA_KMS_KEYFILE",
  "LITELLM_MASTER_KEY",
  "UPSTREAM_API_KEY",
]);

export function unsafePm2Environment(processes, expectedNames) {
  const expected = new Set(expectedNames);
  const found = [];
  for (const processEntry of processes) {
    const name = processEntry?.name;
    if (!expected.has(name)) continue;
    const pm2Env = processEntry?.pm2_env ?? {};
    const snapshots = [pm2Env, pm2Env.env ?? {}];
    for (const key of FORBIDDEN_ENV_NAMES) {
      if (snapshots.some((env) => Object.hasOwn(env, key))) found.push({ name, key });
    }
  }
  return found;
}

function fail(message) {
  process.stderr.write(`PM2 environment boundary failed: ${message}\n`);
  process.exit(1);
}

function main(argv) {
  const [pm2Bin, ...expectedNames] = argv;
  if (!pm2Bin || expectedNames.length === 0) {
    fail("usage: assert-pm2-env-safe.mjs <pm2-bin> <process-name> [...]");
  }
  const result = spawnSync(pm2Bin, ["jlist"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      PM2_HOME: process.env.PM2_HOME ?? "",
    },
  });
  if (result.status !== 0) fail("could not inspect the PM2 process list");

  let processes;
  try {
    processes = JSON.parse(result.stdout);
  } catch {
    fail("PM2 returned an unreadable process list");
  }
  const present = new Set(processes.map((entry) => entry?.name));
  const missing = expectedNames.filter((name) => !present.has(name));
  if (missing.length > 0) fail(`expected managed process is missing: ${missing.join(", ")}`);

  const unsafe = unsafePm2Environment(processes, expectedNames);
  if (unsafe.length > 0) {
    fail(
      `forbidden variables are serialized for ${unsafe
        .map(({ name, key }) => `${name}:${key}`)
        .join(", ")}`,
    );
  }
  process.stdout.write("✓ PM2 environment boundary verified\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
