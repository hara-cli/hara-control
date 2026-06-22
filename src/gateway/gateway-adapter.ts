// The narrow seam between the control plane (this product) and the data plane (a bought/embedded
// engine — LiteLLM in Phase 1). Keep it small: only what hara-control genuinely needs. Swapping
// LiteLLM for Bifrost / a direct provider / a custom core later means writing one new adapter,
// never touching the control plane or clients.

export interface IssuedKey {
  /** the gateway virtual key — returned to the device as its device token, never stored raw */
  key: string;
  /** stable id we use to revoke later (we key off an alias we set, not the raw key) */
  keyId: string;
}

export interface SpendRecord {
  keyId: string;
  spend: number;
}

export interface GatewayAdapter {
  issueKey(opts: { model: string; alias: string; metadata?: Record<string, unknown> }): Promise<IssuedKey>;
  revokeKey(keyId: string): Promise<void>;
  listSpend(keyIds: string[]): Promise<SpendRecord[]>;
}

export const GATEWAY_ADAPTER = Symbol("GATEWAY_ADAPTER");
