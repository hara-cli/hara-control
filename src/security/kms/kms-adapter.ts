// The KMS adapter seam — mirrors the GatewayAdapter pattern (src/gateway/gateway-adapter.ts): a
// narrow interface so the *envelope-encryption* strategy and the *root-key custodian* are swappable.
// Self-hosters get LocalKeyfileKms (root key on disk / env); cloud deployments swap in an AWS/GCP/
// Vault adapter by setting HARA_KMS_PROVIDER, without touching SecretsService or any caller.
//
// Envelope scheme (every adapter honors the same on-disk shape so a Secret row is portable):
//   • a fresh per-secret DEK (AES-256-GCM, 32 bytes) encrypts the plaintext;
//   • the DEK is then *wrapped* (encrypted) with the adapter's CEK (the root/master key);
//   • only {ciphertext, wrappedDek, keyRef} are persisted — NEVER plaintext, NEVER an unwrapped DEK.
//   • ctx.orgId is bound as the GCM AAD on the secret so a ciphertext can't be replayed across tenants
//     (decrypt under a different orgId fails the auth tag). keyRef identifies which CEK wrapped the DEK,
//     so rotation = re-wrap DEKs against a new CEK without re-encrypting any ciphertext.

/** Encryption context bound into the envelope (AAD). orgId scopes a ciphertext to one tenant. */
export interface KmsContext {
  /** tenant the secret belongs to; bound as GCM AAD so cross-tenant replay fails to decrypt */
  orgId?: string;
}

/** The persisted envelope — exactly what a Secret row stores (besides identity/timestamps). */
export interface Envelope {
  /** the secret plaintext encrypted under the per-secret DEK (incl. its iv+tag, see scheme) */
  ciphertext: Buffer;
  /** the per-secret DEK encrypted ("wrapped") under the CEK (incl. its own iv+tag) */
  wrappedDek: Buffer;
  /** which CEK / master key wrapped the DEK — lets rotation + multi-provider coexist */
  keyRef: string;
}

/**
 * The seam. encrypt() produces an Envelope; decrypt() reverses it. Both take a KmsContext whose orgId
 * is bound as AAD — pass the SAME ctx on decrypt as on encrypt or the GCM auth check fails (by design).
 */
export interface KmsAdapter {
  encrypt(plaintext: Buffer, ctx: KmsContext): Promise<Envelope>;
  decrypt(ciphertext: Buffer, wrappedDek: Buffer, keyRef: string, ctx: KmsContext): Promise<Buffer>;
}

/** Thrown for any KMS misconfiguration (no master key, unknown provider, bad key length, …). */
export class KmsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsConfigError";
  }
}

/** DI token for the configured KmsAdapter (parallels GATEWAY_ADAPTER). */
export const KMS_ADAPTER = Symbol("KMS_ADAPTER");
