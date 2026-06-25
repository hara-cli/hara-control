// KMS provider factory — selects the at-rest envelope-encryption adapter by HARA_KMS_PROVIDER, the
// same way GatewayModule selects the data-plane adapter. "local" (default) keeps self-hosters
// secure-by-default with no cloud dependency; aws/gcp/vault are documented seams that throw until an
// operator wires the cloud root key (so the swap point exists and is discoverable, not silently
// missing). See HARDENING.md §B.

import { KmsAdapter, KmsContext, Envelope, KmsConfigError } from "./kms-adapter";
import { LocalKeyfileKms } from "./local-keyfile";

export { KmsAdapter, KmsContext, Envelope, KmsConfigError, KMS_ADAPTER } from "./kms-adapter";
export { LocalKeyfileKms } from "./local-keyfile";

/** Provider id from env; defaults to the local keyfile KMS. */
export function kmsProvider(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HARA_KMS_PROVIDER || "local").trim().toLowerCase();
}

/** A clearly-labeled cloud-KMS stub: the seam exists; every op throws until the operator configures it. */
class NotImplementedKms implements KmsAdapter {
  constructor(
    private readonly provider: string,
    private readonly configureHint: string,
  ) {}
  private fail(): never {
    throw new KmsConfigError(
      `KMS provider "${this.provider}" is not implemented yet — ${this.configureHint}, or set HARA_KMS_PROVIDER=local with HARA_KMS_MASTER_KEY/HARA_KMS_KEYFILE`,
    );
  }
  async encrypt(_plaintext: Buffer, _ctx: KmsContext): Promise<Envelope> {
    void _plaintext;
    void _ctx;
    return this.fail();
  }
  async decrypt(_ciphertext: Buffer, _wrappedDek: Buffer, _keyRef: string, _ctx: KmsContext): Promise<Buffer> {
    void _ciphertext;
    void _wrappedDek;
    void _keyRef;
    void _ctx;
    return this.fail();
  }
}

/**
 * Build the configured KmsAdapter. Pure factory (no Nest) so it's unit-testable and reusable by the
 * one-shot .env→Secret importer. Throws KmsConfigError on an unknown provider or a misconfigured local
 * key — fail loud, never fall back to weaker crypto.
 */
export function createKms(env: NodeJS.ProcessEnv = process.env): KmsAdapter {
  const provider = kmsProvider(env);
  switch (provider) {
    case "local":
      return new LocalKeyfileKms(env);
    case "aws":
      return new NotImplementedKms("aws", "configure an AWS KMS CMK (HARA_KMS_AWS_KEY_ID + AWS creds) and implement AwsKmsAdapter");
    case "gcp":
      return new NotImplementedKms("gcp", "configure a GCP KMS key (HARA_KMS_GCP_KEY_NAME + ADC) and implement GcpKmsAdapter");
    case "vault":
      return new NotImplementedKms("vault", "configure HashiCorp Vault Transit (HARA_KMS_VAULT_ADDR/HARA_KMS_VAULT_KEY/token) and implement VaultTransitAdapter");
    default:
      throw new KmsConfigError(`unknown HARA_KMS_PROVIDER "${provider}" (expected: local | aws | gcp | vault)`);
  }
}
