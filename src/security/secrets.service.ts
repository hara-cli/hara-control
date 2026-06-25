// SecretsService — the at-rest secret store read/write path (HARDENING.md §B). Every value is
// envelope-encrypted through the configured KmsAdapter on the way in and decrypted on the way out;
// plaintext exists only transiently in memory, never in the DB. This is where the upstream provider
// key (and any future per-org BYO key) moves out of .env: put() once, get() at startup, hold in memory.

import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { KMS_ADAPTER, KmsAdapter, KmsContext } from "./kms/kms-adapter";

/**
 * Coerce a Buffer to a plain Uint8Array<ArrayBuffer> for Prisma's `Bytes` column. Prisma's Bytes type
 * is `Uint8Array<ArrayBuffer>`; Node Buffers are `Buffer<ArrayBufferLike>` and don't structurally
 * satisfy it under strict TS, so we copy the bytes into a fresh, exact-length ArrayBuffer-backed
 * Uint8Array. (Round-trips byte-for-byte.)
 */
const toBytes = (b: Buffer): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
};

@Injectable()
export class SecretsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KMS_ADAPTER) private readonly kms: KmsAdapter,
  ) {}

  /** ctx is the encryption context bound as AAD. A global secret (no org) passes orgId: undefined. */
  private ctx(orgId: string | null | undefined): KmsContext {
    return { orgId: orgId ?? undefined };
  }

  /**
   * Encrypt `plaintext` and upsert the {orgId, name} secret. plaintext accepts a string (utf8) or a
   * raw Buffer. Returns nothing — the value is never echoed back. Re-putting the same name rotates the
   * stored ciphertext (fresh DEK + IVs every time; IVs are NEVER reused across encryptions).
   *
   * We do find-then-create/update (not Prisma's compound-unique upsert) because orgId is NULLable: a
   * control-plane-global secret has orgId = NULL, which Prisma's `orgId_name` unique input can't
   * express (it requires a non-null string). findFirst handles both the global and tenant cases.
   */
  async put(orgId: string | null, name: string, plaintext: string | Buffer): Promise<void> {
    const buf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const env = await this.kms.encrypt(buf, this.ctx(orgId));
    const data = { ciphertext: toBytes(env.ciphertext), wrappedDek: toBytes(env.wrappedDek), keyRef: env.keyRef };
    const existing = await this.prisma.secret.findFirst({ where: { orgId, name } });
    if (existing) {
      await this.prisma.secret.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.secret.create({ data: { orgId, name, ...data } });
    }
  }

  /**
   * Load + decrypt the {orgId, name} secret. Returns the plaintext Buffer, or null if no such row.
   * Decrypt verifies the GCM tag (tamper → throws) and the orgId-bound AAD (a row stolen into another
   * tenant won't decrypt). Callers that want a string do `.toString("utf8")`.
   */
  async get(orgId: string | null, name: string): Promise<Buffer | null> {
    const row = await this.prisma.secret.findFirst({ where: { orgId, name } });
    if (!row) return null;
    return this.kms.decrypt(Buffer.from(row.ciphertext), Buffer.from(row.wrappedDek), row.keyRef, this.ctx(orgId));
  }

  /** Convenience: get() decoded as a utf8 string (the common case for API keys). */
  async getString(orgId: string | null, name: string): Promise<string | null> {
    const buf = await this.get(orgId, name);
    return buf === null ? null : buf.toString("utf8");
  }

  /** Delete a secret row. Idempotent (no error if absent). */
  async remove(orgId: string | null, name: string): Promise<void> {
    await this.prisma.secret.deleteMany({ where: { orgId, name } });
  }
}
