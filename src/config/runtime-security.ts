/**
 * Defense-in-depth for operators who bypass the supported deploy scripts. Production must have
 * passed the owner-only env preflight and must not reuse control-plane secrets.
 */
import { allowedManagedModels, defaultManagedModel } from "../providers/model-policy";
import { kmsProvider, LocalKeyfileKms } from "../security/kms";

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
  if (env.HARA_CONTROL_ADMIN_KEY === env.HARA_JWT_SECRET) {
    throw new Error("HARA_CONTROL_ADMIN_KEY and HARA_JWT_SECRET must be different");
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
  kmsMaster.fill(0);
  if (
    env.HARA_KMS_MASTER_KEY &&
    [env.HARA_CONTROL_ADMIN_KEY, env.HARA_JWT_SECRET, env.LITELLM_MASTER_KEY].includes(
      env.HARA_KMS_MASTER_KEY,
    )
  ) {
    throw new Error("the KMS master key must be independent from auth and gateway secrets");
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
