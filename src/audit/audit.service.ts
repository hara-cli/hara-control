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

  private async append(
    tx: Prisma.TransactionClient,
    orgId: string,
    action: string,
    actorType: string,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
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
  }

  /**
   * Commit a governance mutation and its audit-chain append in one SERIALIZABLE transaction. The
   * callback must contain database work only: it can be retried after a serialization conflict.
   */
  async transact<T>(
    action: string,
    actorType: string,
    actorId: string,
    mutation: (tx: Prisma.TransactionClient) => Promise<{
      result: T;
      orgId: string;
      payload?: Record<string, unknown>;
    }>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const audited = await mutation(tx);
          await this.append(tx, audited.orgId, action, actorType, actorId, audited.payload ?? {});
          return audited.result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const conflict = code === "P2034" || code === "P2002";
        if (!conflict || attempt === 3) throw error;
      }
    }
    throw new Error("unreachable audited transaction state");
  }

  async log(orgId: string, action: string, actorType: string, actorId = "", payload: Record<string, unknown> = {}) {
    await this.transact(action, actorType, actorId, async () => ({ result: undefined, orgId, payload }));
  }

  /**
   * Persist a control-plane-wide security event. Callers MUST pass status-only metadata: no secret
   * values, authorization headers, hashes/fingerprints of credentials, or request bodies.
   */
  async logSystem(action: string, actorType: string, actorId = "", payload: Record<string, unknown> = {}) {
    await this.prisma.systemAuditLog.create({
      data: {
        action,
        actorType,
        actorId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Recompute the per-org hash chain and report the first row (if any) where the stored rowHash
   * doesn't match, or where the prevHash linkage is broken. ok=true means the chain is intact.
   * Intended for an admin/compliance endpoint or a cron integrity check.
   */
  async verify(orgId: string): Promise<{
    ok: boolean;
    count: number;
    /** Rows created before hash chaining existed. Preserved for history, but not claimed as anchored. */
    legacyPrefix: number;
    brokenAt?: { seq: number; id: string; reason: string };
  }> {
    const rows = await this.prisma.auditLog.findMany({ where: { orgId }, orderBy: { seq: "asc" } });
    let prevHash = "";
    let legacyPrefix = 0;
    let anchored = false;
    for (const r of rows) {
      if (!anchored && r.prevHash === "" && r.rowHash === "") {
        legacyPrefix += 1;
        continue;
      }
      anchored = true;
      if (r.prevHash !== prevHash) {
        return {
          ok: false,
          count: rows.length,
          legacyPrefix,
          brokenAt: { seq: r.seq, id: r.id, reason: "prevHash linkage mismatch" },
        };
      }
      const expected = chainHash(
        this.identity({ orgId: r.orgId, action: r.action, actorType: r.actorType, actorId: r.actorId, payload: r.payload, seq: r.seq, at: r.at }),
        prevHash,
      );
      if (expected !== r.rowHash) {
        return {
          ok: false,
          count: rows.length,
          legacyPrefix,
          brokenAt: { seq: r.seq, id: r.id, reason: "rowHash mismatch (row tampered)" },
        };
      }
      prevHash = r.rowHash;
    }
    return { ok: true, count: rows.length, legacyPrefix };
  }
}
