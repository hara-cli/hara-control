export const ACCESS_BUDGET_WINDOWS = ["5h", "week", "month"] as const;

export type AccessBudgetWindow = (typeof ACCESS_BUDGET_WINDOWS)[number];

export interface AccessBudgetLimitInput {
  window: AccessBudgetWindow;
  maxUsd: number;
}

export interface GatewayBudgetLimit {
  budgetDuration: "5h" | "7d" | "30d";
  maxBudgetUsd: number;
}

export interface GatewayKeyLimits {
  budgetLimits: GatewayBudgetLimit[];
  rpmLimit?: number;
  tpmLimit?: number;
}

export interface StoredAccessBudgetLimit extends AccessBudgetLimitInput {
  budgetDuration: GatewayBudgetLimit["budgetDuration"];
}

export interface StoredAccessKeyPolicy {
  tokenTtlMinutes: number;
  budgetLimits: StoredAccessBudgetLimit[];
  rpmLimit: number | null;
  tpmLimit: number | null;
}

export interface AccessKeyPolicyInput {
  tokenTtlMinutes?: number;
  budgetLimits?: AccessBudgetLimitInput[];
  rpmLimit?: number;
  tpmLimit?: number;
}

const WINDOW_DURATION: Record<AccessBudgetWindow, GatewayBudgetLimit["budgetDuration"]> = {
  "5h": "5h",
  week: "7d",
  month: "30d",
};

export const MIN_TOKEN_TTL_MINUTES = 5;
export const MAX_TOKEN_TTL_MINUTES = 365 * 24 * 60;
export const MAX_BUDGET_USD = 1_000_000;
export const MAX_RPM_LIMIT = 1_000_000;
export const MAX_TPM_LIMIT = 1_000_000_000;

function finiteInteger(value: number | undefined, label: string, max: number): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be a whole number between 1 and ${max}`);
  }
  return value;
}

export function normalizeAccessKeyPolicy(
  input: AccessKeyPolicyInput,
  defaultTokenTtlMinutes: number,
): StoredAccessKeyPolicy {
  const tokenTtlMinutes = input.tokenTtlMinutes ?? defaultTokenTtlMinutes;
  if (
    !Number.isSafeInteger(tokenTtlMinutes) ||
    tokenTtlMinutes < MIN_TOKEN_TTL_MINUTES ||
    tokenTtlMinutes > MAX_TOKEN_TTL_MINUTES
  ) {
    throw new Error(
      `tokenTtlMinutes must be a whole number between ${MIN_TOKEN_TTL_MINUTES} and ${MAX_TOKEN_TTL_MINUTES}`,
    );
  }

  const source = input.budgetLimits ?? [];
  if (!Array.isArray(source) || source.length > ACCESS_BUDGET_WINDOWS.length) {
    throw new Error("budgetLimits may contain at most one 5h, week, and month window");
  }
  const seen = new Set<AccessBudgetWindow>();
  const budgetLimits = source.map((entry): StoredAccessBudgetLimit => {
    if (!ACCESS_BUDGET_WINDOWS.includes(entry.window)) {
      throw new Error("budget window must be one of: 5h, week, month");
    }
    if (seen.has(entry.window)) throw new Error(`duplicate budget window: ${entry.window}`);
    seen.add(entry.window);
    if (!Number.isFinite(entry.maxUsd) || entry.maxUsd < 0.01 || entry.maxUsd > MAX_BUDGET_USD) {
      throw new Error(`budget maxUsd must be between 0.01 and ${MAX_BUDGET_USD}`);
    }
    return {
      window: entry.window,
      maxUsd: Math.round(entry.maxUsd * 1_000_000) / 1_000_000,
      budgetDuration: WINDOW_DURATION[entry.window],
    };
  });

  return {
    tokenTtlMinutes,
    budgetLimits,
    rpmLimit: finiteInteger(input.rpmLimit, "rpmLimit", MAX_RPM_LIMIT),
    tpmLimit: finiteInteger(input.tpmLimit, "tpmLimit", MAX_TPM_LIMIT),
  };
}

export function gatewayLimits(policy: StoredAccessKeyPolicy): GatewayKeyLimits {
  return {
    budgetLimits: policy.budgetLimits.map((entry) => ({
      budgetDuration: entry.budgetDuration,
      maxBudgetUsd: entry.maxUsd,
    })),
    ...(policy.rpmLimit == null ? {} : { rpmLimit: policy.rpmLimit }),
    ...(policy.tpmLimit == null ? {} : { tpmLimit: policy.tpmLimit }),
  };
}

export function parseStoredAccessKeyPolicy(input: {
  tokenTtlMinutes: number | null;
  budgetLimits: unknown;
  rpmLimit: number | null;
  tpmLimit: number | null;
}, defaultTokenTtlMinutes: number): StoredAccessKeyPolicy {
  const rawLimits = Array.isArray(input.budgetLimits) ? input.budgetLimits : [];
  return normalizeAccessKeyPolicy(
    {
      tokenTtlMinutes: input.tokenTtlMinutes ?? defaultTokenTtlMinutes,
      budgetLimits: rawLimits.map((entry) => {
        if (!entry || typeof entry !== "object") throw new Error("stored budget limit is malformed");
        const row = entry as Record<string, unknown>;
        return {
          window: row.window as AccessBudgetWindow,
          maxUsd: Number(row.maxUsd),
        };
      }),
      rpmLimit: input.rpmLimit ?? undefined,
      tpmLimit: input.tpmLimit ?? undefined,
    },
    defaultTokenTtlMinutes,
  );
}
