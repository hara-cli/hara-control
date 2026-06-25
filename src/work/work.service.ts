import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { Prisma, WorkOutcome, WorkSessionKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementService } from "../license/license.service";
import { sha256 } from "../common/crypto";
import { assertTokenUsable } from "../security/token-discipline";
import { redactSecrets } from "../assets/guard";

export type WorkSessionInput = {
  seq: number;
  startedAt: string;
  endedAt?: string;
  kind?: WorkSessionKind;
  roleKey?: string;
  repoHash?: string;
  taskTitle?: string;
  toolCalls?: Record<string, number>;
  tasksCount?: number;
  filesTouched?: number;
  filePathsHashed?: string[];
  approvalsRequested?: number;
  approvalsGranted?: number;
  outcome?: WorkOutcome;
  commitShas?: string[];
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
};

/** Per-device tamper-evidence chain: rowHash = sha256(canonical-identity + prevHash). Pure + testable. */
export function chainHash(fields: Record<string, unknown>, prevHash: string): string {
  return sha256(JSON.stringify(fields) + prevHash);
}

@Injectable()
export class WorkService {
  private readonly log = new Logger(WorkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
  ) {}

  private async deviceFromBearer(bearer?: string) {
    if (!bearer) throw new UnauthorizedException("missing token");
    const dt = await this.prisma.deviceToken.findUnique({ where: { tokenHash: sha256(bearer) }, include: { device: true } });
    await assertTokenUsable(dt); // revocation + short-TTL expiry + spend-cap hook
    return dt!.device;
  }

  /** Batched, idempotent ingest of completed work sessions. Append-only; metadata-only (T0). */
  async ingest(bearer: string | undefined, sessions: WorkSessionInput[]) {
    this.entitlement.assert("work-audit");
    const device = await this.deviceFromBearer(bearer);
    let ingested = 0;
    let skipped = 0;

    // process in seq order so the per-device hash chain links correctly
    for (const s of [...sessions].sort((a, b) => a.seq - b.seq)) {
      const exists = await this.prisma.workSession.findUnique({ where: { deviceId_seq: { deviceId: device.id, seq: s.seq } } });
      if (exists) {
        skipped++;
        continue;
      }
      const taskTitle = redactSecrets(s.taskTitle ?? "").text; // never trust the client — re-redact
      const prev = await this.prisma.workSession.findFirst({ where: { deviceId: device.id }, orderBy: { seq: "desc" } });
      const prevHash = prev?.rowHash ?? "";
      const identity = {
        deviceId: device.id, seq: s.seq, kind: s.kind ?? "CODING", repoHash: s.repoHash ?? "",
        outcome: s.outcome ?? "UNKNOWN", startedAt: s.startedAt, tasksCount: s.tasksCount ?? 0, taskTitle,
      };
      await this.prisma.workSession.create({
        data: {
          orgId: device.orgId,
          deviceId: device.id,
          personId: device.personId,
          roleKey: s.roleKey ?? "",
          kind: s.kind ?? "CODING",
          repoHash: s.repoHash ?? "",
          taskTitle,
          toolCalls: (s.toolCalls ?? {}) as Prisma.InputJsonValue,
          tasksCount: s.tasksCount ?? 0,
          filesTouched: s.filesTouched ?? 0,
          filePathsHashed: s.filePathsHashed ?? [],
          approvalsRequested: s.approvalsRequested ?? 0,
          approvalsGranted: s.approvalsGranted ?? 0,
          outcome: s.outcome ?? "UNKNOWN",
          commitShas: s.commitShas ?? [],
          model: s.model ?? "",
          tokensIn: s.tokensIn ?? 0,
          tokensOut: s.tokensOut ?? 0,
          latencyMs: s.latencyMs ?? 0,
          startedAt: new Date(s.startedAt),
          endedAt: s.endedAt ? new Date(s.endedAt) : null,
          seq: s.seq,
          prevHash,
          rowHash: chainHash(identity, prevHash),
        },
      });
      ingested++;
    }
    // the *fact that* sessions were ingested is itself a governance event
    await this.audit.log(device.orgId, "work.session.ingest", "device", device.id, { ingested, skipped });
    return { ingested, skipped };
  }

  /** Admin compliance view: "who did what, when" (metadata only). */
  list(orgId: string, opts: { personId?: string; limit?: number }) {
    return this.prisma.workSession.findMany({
      where: { orgId, ...(opts.personId ? { personId: opts.personId } : {}) },
      orderBy: { at: "desc" },
      take: opts.limit ?? 100,
    });
  }
}
