const DEFAULT_MANAGED_MODELS = ["deepseek-chat", "deepseek-pro"] as const;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Server-authoritative aliases exposed by the managed LiteLLM config. */
export function allowedManagedModels(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = (env.HARA_ALLOWED_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const models = configured.length > 0 ? [...new Set(configured)] : [...DEFAULT_MANAGED_MODELS];
  if (models.some((model) => !SAFE_MODEL_ID.test(model))) {
    throw new Error("HARA_ALLOWED_MODELS contains an invalid model id");
  }
  return models;
}

export function defaultManagedModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const allowed = allowedManagedModels(env);
  const model = (env.HARA_DEFAULT_MODEL || allowed[0]).trim();
  if (!allowed.includes(model)) {
    throw new Error("HARA_DEFAULT_MODEL must be present in HARA_ALLOWED_MODELS");
  }
  return model;
}

/** Mock/dev keeps its existing arbitrary model behavior. Formal LiteLLM enrollment always resolves
 * to one server-approved alias, including old enrollment codes whose stored model is empty. */
export function resolveEnrollmentModel(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = (requested || "").trim();
  if (env.GATEWAY_ADAPTER !== "litellm") return model;
  const allowed = allowedManagedModels(env);
  const resolved = model || defaultManagedModel(env);
  if (!allowed.includes(resolved)) {
    throw new Error(`model "${resolved}" is not allowed by this Hara deployment`);
  }
  return resolved;
}
