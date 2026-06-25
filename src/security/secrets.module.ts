// SecretsModule — wires the configured KmsAdapter (chosen by HARA_KMS_PROVIDER, factory in ./kms) and
// the SecretsService into DI. Global so any service can inject SecretsService to read the upstream key
// (or future per-org BYO keys) without importing this module everywhere. Mirrors GatewayModule's
// "factory-selected adapter behind a Symbol token" shape.

import { Global, Module } from "@nestjs/common";
import { KMS_ADAPTER, KmsAdapter, KmsContext, Envelope } from "./kms/kms-adapter";
import { createKms } from "./kms";
import { SecretsService } from "./secrets.service";

/**
 * A KmsAdapter that builds the real adapter on FIRST use, then memoizes it. Why lazy: app boot must
 * stay green in dev/test/CI that don't configure a master key (parallels GATEWAY_ADAPTER defaulting to
 * the mock). A misconfiguration (no master key, unknown provider) then surfaces as a clear
 * KmsConfigError the first time a secret is actually read/written — not at unrelated module init.
 */
class LazyKms implements KmsAdapter {
  private inner?: KmsAdapter;
  private get adapter(): KmsAdapter {
    return (this.inner ??= createKms(process.env));
  }
  encrypt(plaintext: Buffer, ctx: KmsContext): Promise<Envelope> {
    return this.adapter.encrypt(plaintext, ctx);
  }
  decrypt(ciphertext: Buffer, wrappedDek: Buffer, keyRef: string, ctx: KmsContext): Promise<Buffer> {
    return this.adapter.decrypt(ciphertext, wrappedDek, keyRef, ctx);
  }
}

@Global()
@Module({
  providers: [
    { provide: KMS_ADAPTER, useFactory: () => new LazyKms() },
    SecretsService,
  ],
  exports: [KMS_ADAPTER, SecretsService],
})
export class SecretsModule {}
