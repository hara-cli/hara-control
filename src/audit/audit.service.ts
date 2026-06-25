import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { chainHash } from "../common/crypto";

/**
 * Append-only, tamper-evident audit trail. payload is JSONB — queryable in Postgres.
 *
 * Each row is linked into a per-org hash chain: rowHash = sha256(canonical(identity) + prevHash),
 * where prevHash is the previous row's rowHash. Any after-the-fact edit/delete/reorder of a
 * historical row breaks the chain at that point, which verify() detects. This is the OSS-tier
 * tamper-evidence; periodic *signed* checkpoints (anchoring a chain head with an Ed25519 sig) are the
 * paid/enterprise extension and are documented in HARDENING.md, not implemented here.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Canonical identity hashed into the chain — the fields a tamperer would want to rewrite. */
  private identity(row: {
    orgId: string;
    action: string;
    actorType: string;
    actorId: string;
    payload: unknown;
    seq: number;
    at: Date;
  }): Record<string, unknown> {
    return {
      orgId: row.orgId,
      action: row.action,
      actorType: row.actorType,
      actorId: row.actorId,
      payload: row.payload ?? {},
      seq: row.seq,
      at: row.at.toISOString(),
    };
  }

  async log(orgId: string, action: string, actorType: string, actorId = "", payload: Record<string, unknown> = {}) {
    // Read the chain head + append atomically so concurrent writes can't fork the per-org chain.
    await this.prisma.$transaction(async (tx) => {
      const prev = await tx.auditLog.findFirst({ where: { orgId }, orderBy: { seq: "desc" } });
      const seq = (prev?.seq ?? -1) + 1;
      const prevHash = prev?.rowHash ?? "";
      const at = new Date();
      const rowHash = chainHash(this.identity({ orgId, action, actorType, actorId, payload, seq, at }), prevHash);
      await tx.auditLog.create({
        data: {
          orgId,
          action,
          actorType,
          actorId,
          payload: payload as Prisma.InputJsonValue,
          at,
          seq,
          prevHash,
          rowHash,
        },
      });
    });
  }

  /**
   * Recompute the per-org hash chain and report the first row (if any) where the stored rowHash
   * doesn't match, or where the prevHash linkage is broken. ok=true means the chain is intact.
   * Intended for an admin/compliance endpoint or a cron integrity check.
   */
  async verify(orgId: string): Promise<{ ok: boolean; count: number; brokenAt?: { seq: number; id: string; reason: string } }> {
    const rows = await this.prisma.auditLog.findMany({ where: { orgId }, orderBy: { seq: "asc" } });
    let prevHash = "";
    for (const r of rows) {
      if (r.prevHash !== prevHash) {
        return { ok: false, count: rows.length, brokenAt: { seq: r.seq, id: r.id, reason: "prevHash linkage mismatch" } };
      }
      const expected = chainHash(
        this.identity({ orgId: r.orgId, action: r.action, actorType: r.actorType, actorId: r.actorId, payload: r.payload, seq: r.seq, at: r.at }),
        prevHash,
      );
      if (expected !== r.rowHash) {
        return { ok: false, count: rows.length, brokenAt: { seq: r.seq, id: r.id, reason: "rowHash mismatch (row tampered)" } };
      }
      prevHash = r.rowHash;
    }
    return { ok: true, count: rows.length };
  }
}
