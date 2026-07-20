#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function fail(message) {
  process.stderr.write(`production env preflight failed: ${message}\n`);
  process.exit(1);
}

function decodeQuoted(raw, lineNumber) {
  const value = raw.trim();
  if (!value) return "";
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value;
  if (value.length < 2 || value[value.length - 1] !== quote) {
    fail(`line ${lineNumber} has an unterminated quoted value`);
  }
  const body = value.slice(1, -1);
  if (quote === "'") {
    if (body.includes("'")) fail(`line ${lineNumber} contains an unsupported single quote`);
    return body;
  }
  return body.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

export function parseEnvFile(contents) {
  const parsed = {};
  for (const [index, original] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      fail(`line ${lineNumber} must use NAME=value, not shell syntax`);
    }
    const match = original.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) fail(`line ${lineNumber} is not a valid NAME=value assignment`);
    const [, name, raw] = match;
    if (Object.hasOwn(parsed, name)) fail(`line ${lineNumber} repeats ${name}`);
    const value = decodeQuoted(raw, lineNumber);
    if (/[\u0000\r\n]/.test(value)) fail(`line ${lineNumber} contains a forbidden control character`);
    parsed[name] = value;
  }
  return parsed;
}

function assertPrivateFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  if (!stat.isFile()) fail(`${label} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) fail(`${label} must not grant group/other permissions (use chmod 600)`);
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    fail(`${label} must be owned by the deployment user`);
  }
  return stat;
}

function readPrivateFile(path, label) {
  const before = assertPrivateFile(path, label);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    fail(`${label} could not be opened without following aliases`);
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      fail(`${label} changed while it was being opened`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function requireValue(env, name, minLength = 1) {
  const value = env[name];
  if (!value || value.length < minLength) fail(`${name} is missing or too short`);
}

function requireDatabaseSchema(env, name, expectedSchema) {
  requireValue(env, name);
  let url;
  try {
    url = new URL(env[name]);
  } catch {
    fail(`${name} is not a valid database URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    fail(`${name} must use postgresql:// or postgres://`);
  }
  const schema = url.searchParams.get("schema");
  if (schema !== expectedSchema) {
    fail(`${name} must explicitly use schema=${expectedSchema}`);
  }
  return url;
}

function decodeMasterKey(raw) {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function validateProductionEnv(env, envPath) {
  requireDatabaseSchema(env, "DATABASE_URL", "public");
  requireValue(env, "HARA_CONTROL_ADMIN_KEY", 24);
  requireValue(env, "HARA_JWT_SECRET", 24);
  if (env.HARA_CONTROL_ADMIN_KEY === env.HARA_JWT_SECRET) {
    fail("HARA_CONTROL_ADMIN_KEY and HARA_JWT_SECRET must be different");
  }

  if ((env.GATEWAY_ADAPTER || "mock") === "litellm") {
    requireValue(env, "LITELLM_URL");
    requireValue(env, "LITELLM_MASTER_KEY", 24);
    requireDatabaseSchema(env, "LITELLM_DATABASE_URL", "litellm");

    let litellmUrl;
    try {
      litellmUrl = new URL(env.LITELLM_URL);
    } catch {
      fail("LITELLM_URL is not a valid URL");
    }
    const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
    if (!localHosts.has(litellmUrl.hostname) && env.HARA_ALLOW_REMOTE_LITELLM !== "1") {
      fail("LITELLM_URL must be loopback unless HARA_ALLOW_REMOTE_LITELLM=1 is explicitly set");
    }

    const values = new Map();
    for (const name of [
      "HARA_CONTROL_ADMIN_KEY",
      "HARA_JWT_SECRET",
      "LITELLM_MASTER_KEY",
      "UPSTREAM_API_KEY",
    ]) {
      if (!env[name]) continue;
      const duplicate = values.get(env[name]);
      if (duplicate) fail(`${name} must not reuse ${duplicate}`);
      values.set(env[name], name);
    }
  }

  const keyfile = env.HARA_KMS_KEYFILE;
  const inline = env.HARA_KMS_MASTER_KEY;
  if (!keyfile && !inline) fail("configure HARA_KMS_KEYFILE (preferred) or HARA_KMS_MASTER_KEY");
  if (keyfile && inline) fail("configure only one of HARA_KMS_KEYFILE or HARA_KMS_MASTER_KEY");

  let masterRaw;
  if (keyfile) {
    const path = resolve(keyfile);
    masterRaw = readPrivateFile(path, "HARA_KMS_KEYFILE").trim();
  } else {
    masterRaw = inline.trim();
  }
  const master = decodeMasterKey(masterRaw);
  if (!master) fail("the KMS master key must decode to exactly 32 bytes");
  master.fill(0);

  for (const name of [
    "HARA_CONTROL_ADMIN_KEY",
    "HARA_JWT_SECRET",
    "LITELLM_MASTER_KEY",
    "UPSTREAM_API_KEY",
  ]) {
    if (env[name] && env[name] === masterRaw) fail(`the KMS master key must not reuse ${name}`);
  }

  if (env.NODE_ENV && env.NODE_ENV !== "production") {
    fail("NODE_ENV must be production for this deployment path");
  }
  if (!envPath) fail("env path missing");
}

const thisScriptPath = resolve(fileURLToPath(import.meta.url));

/** PM2 imports ESM applications from ProcessContainerFork.js instead of making them argv[1].
 * Accept that exact, manager-provided executable path only when a numeric PM2 id is also present. */
export function isMainInvocation(argv1, env = process.env) {
  const direct =
    typeof argv1 === "string"
    && import.meta.url === pathToFileURL(resolve(argv1)).href;
  if (direct) return true;
  const pmExecPath = env?.pm_exec_path;
  const pmId = String(env?.pm_id ?? "");
  return (
    typeof pmExecPath === "string"
    && /^\d+$/.test(pmId)
    && resolve(pmExecPath) === thisScriptPath
  );
}

if (isMainInvocation(process.argv[1], process.env)) {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  if (argv.length < 3 || separator !== 1 || separator === argv.length - 1) {
    fail("usage: node scripts/with-production-env.mjs <env-file> -- <command> [args...]");
  }

  const envPath = resolve(argv[0]);
  const parsed = parseEnvFile(readPrivateFile(envPath, ".env"));
  validateProductionEnv(parsed, envPath);

  const [command, ...commandArgs] = argv.slice(separator + 1);
  const child = spawn(command, commandArgs, {
    env: { ...process.env, ...parsed, NODE_ENV: "production", HARA_ENV_LOADED: "1" },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => fail(`could not start ${command}: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}
