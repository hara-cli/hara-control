// SecretsService — the at-rest secret store read/write path (HARDENING.md §B). Every value is
// envelope-encrypted through the configured KmsAdapter on the way in and decrypted on the way out;
// plaintext exists only transiently in memory, never in the DB. This is where the upstream provider
// key (and any future per-org BYO key) moves out of .env: put() once, get() at startup, hold in memory.

import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
    const ownsBuffer = typeof plaintext === "string";
    const buf = ownsBuffer ? Buffer.from(plaintext, "utf8") : plaintext;
    try {
      const env = await this.kms.encrypt(buf, this.ctx(orgId));
      const data = { ciphertext: toBytes(env.ciphertext), wrappedDek: toBytes(env.wrappedDek), keyRef: env.keyRef };
      const existing = await this.prisma.secret.findFirst({ where: { orgId, name } });
      if (existing) {
        await this.prisma.secret.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        });
      } else {
        await this.prisma.secret.create({ data: { orgId, name, ...data } });
      }
    } finally {
      if (ownsBuffer) buf.fill(0);
    }
  }

  /**
   * Atomic credential rotation + global security audit. This prevents the dangerous half-state where
   * a new encrypted key is committed but its rotation event is missing (or vice versa).
   */
  async putWithSystemAudit(
    orgId: string | null,
    name: string,
    plaintext: string | Buffer,
    audit: {
      action: string;
      actorType: string;
      actorId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const ownsBuffer = typeof plaintext === "string";
    const buf = ownsBuffer ? Buffer.from(plaintext, "utf8") : plaintext;
    try {
      const env = await this.kms.encrypt(buf, this.ctx(orgId));
      const data = {
        ciphertext: toBytes(env.ciphertext),
        wrappedDek: toBytes(env.wrappedDek),
        keyRef: env.keyRef,
      };
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.secret.findFirst({ where: { orgId, name } });
        if (existing) {
          await tx.secret.update({
            where: { id: existing.id },
            data: { ...data, version: { increment: 1 } },
          });
        } else {
          await tx.secret.create({ data: { orgId, name, ...data } });
        }
        await tx.systemAuditLog.create({
          data: {
            action: audit.action,
            actorType: audit.actorType,
            actorId: audit.actorId,
            payload: audit.payload as Prisma.InputJsonValue,
          },
        });
      });
    } finally {
      if (ownsBuffer) buf.fill(0);
    }
  }

  /**
   * Load + decrypt the {orgId, name} secret. Returns the plaintext Buffer, or null if no such row.
   * Decrypt verifies the GCM tag (tamper → throws) and the orgId-bound AAD (a row stolen into another
   * tenant won't decrypt). Callers that want a string do `.toString("utf8")`.
   */
  async get(orgId: string | null, name: string): Promise<Buffer | null> {
    return (await this.getVersioned(orgId, name))?.value ?? null;
  }

  /** Return plaintext plus its non-secret lifecycle revision from one row snapshot. */
  async getVersioned(
    orgId: string | null,
    name: string,
  ): Promise<{ value: Buffer; version: number; updatedAt: Date } | null> {
    const row = await this.prisma.secret.findFirst({ where: { orgId, name } });
    if (!row) return null;
    const value = await this.kms.decrypt(
      Buffer.from(row.ciphertext),
      Buffer.from(row.wrappedDek),
      row.keyRef,
      this.ctx(orgId),
    );
    return { value, version: row.version, updatedAt: row.updatedAt };
  }

  /** Convenience: get() decoded as a utf8 string (the common case for API keys). */
  async getString(orgId: string | null, name: string): Promise<string | null> {
    const buf = await this.get(orgId, name);
    if (buf === null) return null;
    try {
      return buf.toString("utf8");
    } finally {
      buf.fill(0);
    }
  }

  /** Metadata-only lookup for admin status pages. Never decrypts or exposes a keyRef/fingerprint. */
  async describe(
    orgId: string | null,
    name: string,
  ): Promise<{ exists: boolean; version: number | null; createdAt: Date | null; updatedAt: Date | null }> {
    const row = await this.prisma.secret.findFirst({
      where: { orgId, name },
      select: { version: true, createdAt: true, updatedAt: true },
    });
    return row
      ? { exists: true, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt }
      : { exists: false, version: null, createdAt: null, updatedAt: null };
  }

  /** Delete a secret row. Idempotent (no error if absent). */
  async remove(orgId: string | null, name: string): Promise<void> {
    await this.prisma.secret.deleteMany({ where: { orgId, name } });
  }
}
