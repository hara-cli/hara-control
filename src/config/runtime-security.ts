/**
 * Defense-in-depth for operators who bypass the supported deploy scripts. Production must have
 * passed the owner-only env preflight and must not reuse control-plane secrets.
 */
import { timingSafeEqual } from "node:crypto";
import { allowedManagedModels, defaultManagedModel } from "../providers/model-policy";
import { kmsProvider, LocalKeyfileKms } from "../security/kms";
import { loadFeedbackIntakeKey } from "./feedback-intake";

function requireLongValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length < 24) {
    throw new Error(`production configuration missing or too short ${name}`);
  }
  return value;
}

function requireDatabaseSchema(
  env: NodeJS.ProcessEnv,
  name: string,
  expectedSchema: string,
): void {
  const raw = env[name];
  if (!raw) throw new Error(`production configuration missing ${name}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid database URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${name} must use PostgreSQL`);
  }
  if (url.searchParams.get("schema") !== expectedSchema) {
    throw new Error(`${name} must explicitly use schema=${expectedSchema}`);
  }
}

function secretDecodesTo(secret: string, expected: Buffer): boolean {
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/u.test(secret)) candidates.push(Buffer.from(secret, "hex"));
  try {
    const decoded = Buffer.from(secret, "base64url");
    if (decoded.length === expected.length) candidates.push(decoded);
  } catch {
    // Non-encoded purpose credentials are valid; they simply cannot equal the encoded KMS key.
  }
  return candidates.some((candidate) => (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  ));
}

function assertCrashAlertConfiguration(env: NodeJS.ProcessEnv): void {
  const names = [
    "HARA_CRASH_FEISHU_APP_ID",
    "HARA_CRASH_FEISHU_APP_SECRET",
    "HARA_CRASH_FEISHU_CHAT_ID",
    "HARA_CRASH_FEISHU_MENTION_OPEN_ID",
  ] as const;
  const values = names.map((name) => env[name] || "");
  if (values.every((value) => !value)) return;
  if (values.some((value) => !value)) {
    throw new Error("production crash alerts require all four HARA_CRASH_FEISHU_* settings");
  }
  if (!/^cli_[A-Za-z0-9]+$/u.test(env.HARA_CRASH_FEISHU_APP_ID!)) {
    throw new Error("production HARA_CRASH_FEISHU_APP_ID is invalid");
  }
  if (env.HARA_CRASH_FEISHU_APP_SECRET!.length < 20) {
    throw new Error("production HARA_CRASH_FEISHU_APP_SECRET is too short");
  }
  if (!/^oc_[A-Za-z0-9]+$/u.test(env.HARA_CRASH_FEISHU_CHAT_ID!)) {
    throw new Error("production HARA_CRASH_FEISHU_CHAT_ID is invalid");
  }
  if (!/^ou_[A-Za-z0-9]+$/u.test(env.HARA_CRASH_FEISHU_MENTION_OPEN_ID!)) {
    throw new Error("production HARA_CRASH_FEISHU_MENTION_OPEN_ID is invalid");
  }
}

export function assertProductionRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (env.HARA_ENV_LOADED !== "1" && env.HARA_ENV_LOADED !== "container") {
    throw new Error(
      "production must start through scripts/with-production-env.mjs or the published container entrypoint",
    );
  }
  requireDatabaseSchema(env, "DATABASE_URL", "public");
  requireLongValue(env, "HARA_CONTROL_ADMIN_KEY");
  requireLongValue(env, "HARA_JWT_SECRET");
  const feedbackIntakeKey = loadFeedbackIntakeKey(env);
  assertCrashAlertConfiguration(env);
  if (env.HARA_CONTROL_ADMIN_KEY === env.HARA_JWT_SECRET) {
    throw new Error("HARA_CONTROL_ADMIN_KEY and HARA_JWT_SECRET must be different");
  }
  if (
    feedbackIntakeKey
    && [
      env.HARA_CONTROL_ADMIN_KEY,
      env.HARA_JWT_SECRET,
      env.LITELLM_MASTER_KEY,
      env.UPSTREAM_API_KEY,
      env.HARA_CRASH_FEISHU_APP_SECRET,
    ]
      .includes(feedbackIntakeKey)
  ) {
    throw new Error("HARA_FEEDBACK_INTAKE_KEY must be independent from all runtime secrets");
  }
  if (!env.HARA_KMS_KEYFILE && !env.HARA_KMS_MASTER_KEY) {
    throw new Error("production configuration missing a KMS master-key source");
  }
  if (env.HARA_KMS_KEYFILE && env.HARA_KMS_MASTER_KEY) {
    throw new Error("production must configure only one KMS master-key source");
  }
  if (kmsProvider(env) !== "local") {
    throw new Error("the configured production KMS provider is not implemented");
  }
  const kmsMaster = LocalKeyfileKms.loadMasterKey(env);
  if (feedbackIntakeKey && secretDecodesTo(feedbackIntakeKey, kmsMaster)) {
    kmsMaster.fill(0);
    throw new Error("HARA_FEEDBACK_INTAKE_KEY must be independent from the KMS master key");
  }
  kmsMaster.fill(0);
  if (
    env.HARA_KMS_MASTER_KEY &&
    [env.HARA_CONTROL_ADMIN_KEY, env.HARA_JWT_SECRET, env.LITELLM_MASTER_KEY].includes(
      env.HARA_KMS_MASTER_KEY,
    )
  ) {
    throw new Error("the KMS master key must be independent from auth and gateway secrets");
  }
  if (
    env.HARA_CRASH_FEISHU_APP_SECRET &&
    [env.HARA_CONTROL_ADMIN_KEY, env.HARA_JWT_SECRET, env.LITELLM_MASTER_KEY, env.HARA_KMS_MASTER_KEY]
      .includes(env.HARA_CRASH_FEISHU_APP_SECRET)
  ) {
    throw new Error("the Feishu App Secret must be independent from Hara runtime secrets");
  }
  if (env.GATEWAY_ADAPTER === "litellm") {
    requireLongValue(env, "LITELLM_MASTER_KEY");
    requireDatabaseSchema(env, "LITELLM_DATABASE_URL", "litellm");
    if (!env.LITELLM_URL) {
      throw new Error("production LiteLLM configuration missing LITELLM_URL");
    }
    let litellmUrl: URL;
    try {
      litellmUrl = new URL(env.LITELLM_URL);
    } catch {
      throw new Error("LITELLM_URL is not a valid URL");
    }
    if (
      !["127.0.0.1", "localhost", "::1"].includes(litellmUrl.hostname) &&
      env.HARA_ALLOW_REMOTE_LITELLM !== "1"
    ) {
      throw new Error("production LITELLM_URL must be loopback");
    }
    if (
      env.LITELLM_MASTER_KEY === env.HARA_CONTROL_ADMIN_KEY ||
      env.LITELLM_MASTER_KEY === env.HARA_JWT_SECRET
    ) {
      throw new Error("LITELLM_MASTER_KEY must be independent from control-plane auth secrets");
    }
    allowedManagedModels(env);
    defaultManagedModel(env);
  }
}
