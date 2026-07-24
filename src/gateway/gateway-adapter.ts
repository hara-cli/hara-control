// The narrow seam between the control plane (this product) and the data plane (a bought/embedded
// engine — LiteLLM in Phase 1). Keep it small: only what hara-control genuinely needs. Swapping
// LiteLLM for Bifrost / a direct provider / a custom core later means writing one new adapter,
// never touching the control plane or clients.

import type { GatewayKeyLimits } from "./key-policy";
import type { UsageRange } from "./usage";

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

export interface GatewayUsageBucket {
  keyId: string;
  bucketAt: Date;
  model: string;
  spend: number;
  totalTokens: number;
  requests: number;
  lastRequestAt: Date;
}

export interface GatewayRollingSpend {
  keyId: string;
  spend5h: number;
  spend7d: number;
  spend30d: number;
}

export interface GatewayUsageReport {
  /** false means the authoritative ledger was unavailable; callers must not render fake zeroes. */
  available: boolean;
  buckets: GatewayUsageBucket[];
  rolling: GatewayRollingSpend[];
}

export interface GatewayAdapter {
  issueKey(opts: {
    /** Default model selected when the connection is first created. */
    model: string;
    /** Complete authorized model catalog for this one device key. */
    models?: string[];
    alias: string;
    expiresAt: Date;
    metadata?: Record<string, unknown>;
    limits?: GatewayKeyLimits;
  }): Promise<IssuedKey>;
  /** Reconcile an existing key in place. The raw virtual key is never required or returned. */
  syncKeyModels(keyId: string, models: string[]): Promise<string[]>;
  revokeKey(keyId: string): Promise<void>;
  listSpend(keyIds: string[]): Promise<SpendRecord[]>;
  usage(keyIds: string[], range: UsageRange, now?: Date): Promise<GatewayUsageReport>;
  /**
   * Cheap read-only readiness. It must verify the key-management data path without issuing a
   * provider completion, exposing upstream details, or creating/revoking credentials.
   */
  readiness(): Promise<GatewayReadiness>;
}

export const GATEWAY_ADAPTER = Symbol("GATEWAY_ADAPTER");
