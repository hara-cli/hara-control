// Device-token discipline, in one place so every validation site enforces it identically:
//   • short TTL              — tokens carry expiresAt; expired tokens are rejected
//   • explicit revocation    — revokedAt must be null
//   • per-device / per-tenant spend (rate) cap — a HOOK with an enforcement point. The cap VALUE is
//     configurable (env) and the live spend lookup is pluggable; until wired to LiteLLM spend it is a
//     no-op (never throws), so this is structure + the seam, not a behavior change.
//
// Kept dependency-free (no Nest, no Prisma type import) so it's trivially unit-testable and callable
// from any service that has already fetched a DeviceToken row.

import { UnauthorizedException, ForbiddenException } from "@nestjs/common";

/** The subset of a DeviceToken row the discipline check needs. expiresAt optional = legacy/no-TTL. */
export interface ValidatableToken {
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  deviceId?: string;
  gatewayKeyId?: string;
}

/** Default device-token TTL. Operators tune via HARA_DEVICE_TOKEN_TTL_MINUTES. */
export const DEFAULT_DEVICE_TOKEN_TTL_MINUTES = 7 * 24 * 60; // 7 days

export function deviceTokenTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.HARA_DEVICE_TOKEN_TTL_MINUTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEVICE_TOKEN_TTL_MINUTES;
}

/** Compute an expiry Date for a freshly-issued token. */
export function deviceTokenExpiry(now = new Date(), env: NodeJS.ProcessEnv = process.env): Date {
  return new Date(now.getTime() + deviceTokenTtlMinutes(env) * 60_000);
}

/**
 * Per-device / per-tenant spend (rate) cap. The VALUE is config; the live-usage lookup is injected by
 * the caller (e.g. the gateway adapter's listSpend joined to LiteLLM). Until a checker is supplied
 * this is a no-op — the documented enforcement seam, exercised but inert by default.
 */
export type SpendChecker = (token: ValidatableToken) => Promise<number> | number; // returns current spend (USD)

export function deviceSpendCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.HARA_DEVICE_SPEND_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 0; // 0 = uncapped
}

export interface TokenDisciplineOpts {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** optional live-spend lookup; if omitted the spend cap is not enforced (hook only) */
  spendChecker?: SpendChecker;
}

/**
 * The single chokepoint every device-token validation path runs. Throws on revoked / expired /
 * over-cap; returns silently when the token may proceed. Call AFTER the token row is fetched and the
 * "missing/unknown" case handled by the caller (kept here too for safety).
 */
export async function assertTokenUsable(token: ValidatableToken | null | undefined, opts: TokenDisciplineOpts = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;

  if (!token || token.revokedAt) throw new UnauthorizedException("revoked or unknown token");

  // short-TTL enforcement — legacy tokens with no expiresAt are treated as non-expiring (backward-compat)
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    throw new UnauthorizedException("token expired — re-enroll the device");
  }

  // spend-cap hook — only enforced when BOTH a cap value and a live-spend checker are present
  const cap = deviceSpendCapUsd(env);
  if (cap > 0 && opts.spendChecker) {
    const spent = await opts.spendChecker(token);
    if (spent >= cap) {
      throw new ForbiddenException(`device spend cap reached ($${spent.toFixed(2)} / $${cap.toFixed(2)})`);
    }
  }
}
