#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`LiteLLM schema sync failed: ${message}`);
}

function databaseIdentity(raw, expectedSchema) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`database URL for schema=${expectedSchema} is invalid`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    fail(`database URL for schema=${expectedSchema} must use PostgreSQL`);
  }
  if (url.searchParams.get("schema") !== expectedSchema) {
    fail(`database URL must explicitly use schema=${expectedSchema}`);
  }
  return {
    url,
    identity: [url.hostname, url.port || "5432", url.pathname, url.username].join("\n"),
  };
}

export function assertIsolatedLiteLLMDatabase(controlRaw, liteLlmRaw) {
  const control = databaseIdentity(controlRaw, "public");
  const liteLlm = databaseIdentity(liteLlmRaw, "litellm");
  if (control.identity !== liteLlm.identity) {
    fail("control and LiteLLM URLs must use the same host, port, database, and role");
  }
  return liteLlm.url.toString();
}

export function assertNonDestructiveSchemaPlan(sql) {
  const destructive = [
    /\bDROP\s+(?:TABLE|SCHEMA|TYPE)\b/i,
    /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN\b/i,
    /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
  ];
  if (destructive.some((pattern) => pattern.test(sql))) {
    fail("the generated Prisma plan contains a destructive operation; review it manually");
  }
}

export function prismaChildEnv(base, databaseUrl) {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ];
  const env = {};
  for (const name of allowed) {
    if (base[name]) env[name] = base[name];
  }
  env.DATABASE_URL = databaseUrl;
  env.PRISMA_HIDE_UPDATE_MESSAGE = "1";
  return env;
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "command failed")
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[redacted]")
      .trim()
      .slice(-2_000);
    fail(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout || "");
}

function resolveRuntime(appDir) {
  const runtime = realpathSync(resolve(appDir, ".litellm-venv"));
  const managedRoot = `${realpathSync(resolve(appDir, ".litellm-venvs"))}${sep}`;
  if (!runtime.startsWith(managedRoot)) fail(".litellm-venv is outside the managed runtime directory");
  const python = resolve(runtime, "bin", "python3");
  const prisma = resolve(runtime, "bin", "prisma");
  const schemaOutput = commandResult(
    python,
    [
      "-c",
      "import pathlib, litellm; print((pathlib.Path(litellm.__file__).parent / 'proxy' / 'schema.prisma').resolve())",
    ],
    { env: prismaChildEnv(process.env, "postgresql://unused:unused@127.0.0.1:1/unused") },
  ).trim();
  const schema = realpathSync(schemaOutput);
  if (!schema.startsWith(`${runtime}${sep}`)) fail("LiteLLM schema is outside the pinned runtime");
  return { prisma, schema };
}

function schemaDiff(prisma, schema, env) {
  return commandResult(
    prisma,
    [
      "migrate",
      "diff",
      `--from-schema-datasource=${schema}`,
      `--to-schema-datamodel=${schema}`,
      "--script",
    ],
    { env },
  );
}

export function isEmptySchemaPlan(sql) {
  const normalized = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, "")
    .trim();
  return normalized.length === 0;
}

function schemaContext(appDir, env) {
  const databaseUrl = assertIsolatedLiteLLMDatabase(env.DATABASE_URL, env.LITELLM_DATABASE_URL);
  const runtime = resolveRuntime(appDir);
  const childEnv = prismaChildEnv(env, databaseUrl);
  return { ...runtime, childEnv };
}

export function previewLiteLLMSchema({ appDir = process.cwd(), env = process.env } = {}) {
  const context = schemaContext(appDir, env);
  return schemaDiff(context.prisma, context.schema, context.childEnv);
}

export function syncLiteLLMSchema({ appDir = process.cwd(), env = process.env } = {}) {
  const runtime = schemaContext(appDir, env);
  const before = schemaDiff(runtime.prisma, runtime.schema, runtime.childEnv);
  if (isEmptySchemaPlan(before)) {
    process.stdout.write("✓ LiteLLM database schema is current\n");
    return;
  }
  assertNonDestructiveSchemaPlan(before);
  process.stdout.write("▶ applying verified non-destructive LiteLLM schema changes\n");
  commandResult(
    runtime.prisma,
    ["db", "push", "--skip-generate", `--schema=${runtime.schema}`],
    { env: runtime.childEnv, stdio: ["ignore", "inherit", "pipe"] },
  );
  const after = schemaDiff(runtime.prisma, runtime.schema, runtime.childEnv);
  if (!isEmptySchemaPlan(after)) fail("Prisma still reports schema drift after db push");
  process.stdout.write("✓ LiteLLM database schema synchronized and rechecked\n");
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    syncLiteLLMSchema({ appDir: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "LiteLLM schema sync failed"}\n`);
    process.exitCode = 1;
  }
}
