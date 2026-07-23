#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`security bootstrap failed: ${message}\n`);
  process.exit(1);
}

const envPath = resolve(process.argv[2] || ".env");

if (!existsSync(envPath)) fail(`${envPath} is missing`);
const envStat = lstatSync(envPath);
if (envStat.isSymbolicLink() || !envStat.isFile()) fail(".env must be a regular, non-symlink file");
if (typeof process.geteuid === "function" && envStat.uid !== process.geteuid()) {
  fail(".env must be owned by the deployment user");
}
// Tighten permissions before reading any existing credential material.
chmodSync(envPath, 0o600);

const envFd = openSync(envPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
let contents;
try {
  const opened = fstatSync(envFd);
  if (opened.dev !== envStat.dev || opened.ino !== envStat.ino || !opened.isFile()) {
    fail(".env changed while it was being opened");
  }
  contents = readFileSync(envFd, "utf8");
} finally {
  closeSync(envFd);
}
const configuredKeyfile = contents.match(/^HARA_KMS_KEYFILE=(.*)$/m)?.[1]?.trim();
const keyfile = resolve(process.argv[3] || configuredKeyfile || "/etc/hara-control/kms-master.key");
const keyDir = dirname(keyfile);
mkdirSync(keyDir, { recursive: true, mode: 0o700 });
if (existsSync(keyfile)) {
  const keyStat = lstatSync(keyfile);
  if (keyStat.isSymbolicLink() || !keyStat.isFile()) fail("KMS keyfile must be a regular, non-symlink file");
  if (typeof process.geteuid === "function" && keyStat.uid !== process.geteuid()) {
    fail("existing KMS keyfile must be owned by the deployment user");
  }
  if ((keyStat.mode & 0o077) !== 0) fail("existing KMS keyfile must be owner-only (chmod 600)");
} else {
  writeFileSync(keyfile, `${randomBytes(32).toString("base64")}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}
chmodSync(keyfile, 0o600);

function currentValue(name) {
  return contents.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
}

function setValue(name, value, replacePlaceholder = true) {
  const re = new RegExp(`^${name}=.*$`, "m");
  const existing = currentValue(name);
  const shouldReplace =
    !existing ||
    (replacePlaceholder &&
      (/^__SET/.test(existing) || /change-me/i.test(existing)));
  if (re.test(contents)) {
    if (shouldReplace) contents = contents.replace(re, `${name}=${value}`);
  } else {
    contents += `${contents.endsWith("\n") ? "" : "\n"}${name}=${value}\n`;
  }
}

function decodedCurrentValue(name) {
  const value = currentValue(name);
  if (!value) return value;
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.at(-1) === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function isolatedLiteLLMDatabaseUrl() {
  const raw = decodedCurrentValue("DATABASE_URL");
  if (!raw) fail("DATABASE_URL is required before production security bootstrap");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    fail("DATABASE_URL must use postgresql:// or postgres://");
  }
  if (url.searchParams.get("schema") !== "public") {
    fail("DATABASE_URL must explicitly use schema=public");
  }
  url.searchParams.set("schema", "litellm");
  return url.toString();
}

if (/^NODE_ENV=.*$/m.test(contents)) {
  contents = contents.replace(/^NODE_ENV=.*$/m, "NODE_ENV=production");
} else {
  contents += `${contents.endsWith("\n") ? "" : "\n"}NODE_ENV=production\n`;
}
setValue("HARA_CONTROL_ADMIN_KEY", randomBytes(32).toString("hex"));
setValue("HARA_JWT_SECRET", randomBytes(32).toString("hex"));
setValue("LITELLM_MASTER_KEY", `sk-hara-${randomBytes(32).toString("hex")}`);
setValue("HARA_KMS_PROVIDER", "local");
setValue("HARA_KMS_KEYFILE", keyfile);
if (decodedCurrentValue("GATEWAY_ADAPTER") === "litellm") {
  setValue("LITELLM_DATABASE_URL", isolatedLiteLLMDatabaseUrl());
  setValue("HARA_ALLOWED_MODELS", "deepseek-v4-flash,deepseek-v4-pro");
  setValue("HARA_DEFAULT_MODEL", "deepseek-v4-flash");
}

const admin = currentValue("HARA_CONTROL_ADMIN_KEY");
const jwt = currentValue("HARA_JWT_SECRET");
const master = currentValue("LITELLM_MASTER_KEY");
if (!admin || !jwt || !master) fail("required security values could not be established");
if (new Set([admin, jwt, master]).size !== 3) fail("admin, JWT and LiteLLM secrets must be distinct");

const tmp = `${envPath}.security-${process.pid}.tmp`;
writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
chmodSync(tmp, 0o600);
const currentEnvStat = lstatSync(envPath);
if (
  currentEnvStat.isSymbolicLink() ||
  !currentEnvStat.isFile() ||
  currentEnvStat.dev !== envStat.dev ||
  currentEnvStat.ino !== envStat.ino
) {
  try {
    unlinkSync(tmp);
  } catch {
    // The staging file is owner-only; retain the original failure if cleanup itself races.
  }
  fail(".env changed during security bootstrap");
}
try {
  renameSync(tmp, envPath);
} catch {
  try {
    unlinkSync(tmp);
  } catch {
    // Owner-only staging cleanup is best-effort; do not replace the atomic-write failure.
  }
  fail(".env atomic replacement failed");
}
process.stdout.write("production security material configured (values not displayed)\n");
