const DEFAULT_MANAGED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const LEGACY_MANAGED_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-chat": "deepseek-v4-flash",
  "deepseek-pro": "deepseek-v4-pro",
};

const DEEPSEEK_V4_DETAILS: Readonly<Record<string, {
  provider: "deepseek";
  family: "deepseek-v4";
  tier: "flash" | "pro";
  contextWindowTokens: number;
  maxOutputTokens: number;
  thinkingEfforts: readonly ["off", "high", "max"];
}>> = {
  "deepseek-v4-flash": {
    provider: "deepseek",
    family: "deepseek-v4",
    tier: "flash",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    thinkingEfforts: ["off", "high", "max"],
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    family: "deepseek-v4",
    tier: "pro",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    thinkingEfforts: ["off", "high", "max"],
  },
};

export type ManagedModelOption = {
  id: string;
  provider: string;
  family: string;
  tier: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  thinkingEfforts: string[];
  isDefault: boolean;
};

/** Keep already-issued codes and deployments configured with Hara's pre-V4 aliases usable, while
 * every new code and client profile receives the provider's canonical model id. */
export function canonicalManagedModelId(model: string): string {
  const trimmed = model.trim();
  return LEGACY_MANAGED_MODEL_ALIASES[trimmed] ?? trimmed;
}

/** Server-authoritative aliases exposed by the managed LiteLLM config. */
export function allowedManagedModels(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = (env.HARA_ALLOWED_MODELS || "")
    .split(",")
    .map(canonicalManagedModelId)
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
  const model = canonicalManagedModelId(env.HARA_DEFAULT_MODEL || allowed[0]);
  if (!allowed.includes(model)) {
    throw new Error("HARA_DEFAULT_MODEL must be present in HARA_ALLOWED_MODELS");
  }
  return model;
}

/** Admin-facing, non-secret model catalog. Unknown deployment-specific aliases remain selectable,
 * but only the two official DeepSeek V4 ids receive capability metadata. */
export function managedModelOptions(
  env: NodeJS.ProcessEnv = process.env,
): ManagedModelOption[] {
  const selectedDefault = defaultManagedModel(env);
  return allowedManagedModels(env).map((id) => {
    const details = DEEPSEEK_V4_DETAILS[id];
    return {
      id,
      provider: details?.provider ?? "custom",
      family: details?.family ?? "custom",
      tier: details?.tier ?? "custom",
      contextWindowTokens: details?.contextWindowTokens ?? null,
      maxOutputTokens: details?.maxOutputTokens ?? null,
      thinkingEfforts: details ? [...details.thinkingEfforts] : [],
      isDefault: id === selectedDefault,
    };
  });
}

/** Capabilities attached to an enrollment response. The response stays safe for custom/mock models by
 * advertising no thinking dial unless Hara knows the model's exact wire contract. */
export function managedModelThinkingEfforts(model: string): string[] {
  const details = DEEPSEEK_V4_DETAILS[canonicalManagedModelId(model)];
  return details ? [...details.thinkingEfforts] : [];
}

/** Mock/dev keeps its existing arbitrary model behavior. Formal LiteLLM enrollment always resolves
 * to one server-approved alias, including old enrollment codes whose stored model is empty. */
export function resolveEnrollmentModel(
  requested: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const requestedModel = (requested || "").trim();
  if (env.GATEWAY_ADAPTER !== "litellm") return requestedModel;
  const model = canonicalManagedModelId(requestedModel);
  const allowed = allowedManagedModels(env);
  const resolved = model || defaultManagedModel(env);
  if (!allowed.includes(resolved)) {
    throw new Error(`model "${resolved}" is not allowed by this Hara deployment`);
  }
  return resolved;
}
