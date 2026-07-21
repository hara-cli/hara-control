// The narrow seam between the control plane (this product) and the data plane (a bought/embedded
// engine — LiteLLM in Phase 1). Keep it small: only what hara-control genuinely needs. Swapping
// LiteLLM for Bifrost / a direct provider / a custom core later means writing one new adapter,
// never touching the control plane or clients.

import type { GatewayKeyLimits } from "./key-policy";

export interface IssuedKey {
  /** the gateway virtual key — returned to the device as its device token, never stored raw */
  key: string;
  /** stable id we use to revoke later (we key off an alias we set, not the raw key) */
  keyId: string;
  /** authoritative data-plane expiry returned by the gateway */
  expiresAt: Date;
}

export interface SpendRecord {
  keyId: string;
  /** null means the authoritative usage source could not provide a value; never substitute fake zero. */
  spend: number | null;
}

export interface GatewayReadiness {
  ok: boolean;
}

export interface GatewayAdapter {
  issueKey(opts: {
    model: string;
    alias: string;
    expiresAt: Date;
    metadata?: Record<string, unknown>;
    limits?: GatewayKeyLimits;
  }): Promise<IssuedKey>;
  revokeKey(keyId: string): Promise<void>;
  listSpend(keyIds: string[]): Promise<SpendRecord[]>;
  /**
   * Cheap read-only readiness. It must verify the key-management data path without issuing a
   * provider completion, exposing upstream details, or creating/revoking credentials.
   */
  readiness(): Promise<GatewayReadiness>;
}

export const GATEWAY_ADAPTER = Symbol("GATEWAY_ADAPTER");
