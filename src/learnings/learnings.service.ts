import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  LearningKind,
  LearningStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { sha256 } from "../common/crypto";
import { EntitlementService } from "../license/license.service";
import { assertTokenUsable } from "../security/token-discipline";
import {
  type LearningKindWire,
  type ReviewLearningCandidateDto,
  type SubmitLearningCandidateDto,
} from "./dto";

const KIND_FROM_WIRE: Record<LearningKindWire, LearningKind> = {
  business_rule: LearningKind.BUSINESS_RULE,
  user_preference: LearningKind.USER_PREFERENCE,
  workflow: LearningKind.WORKFLOW,
  correction: LearningKind.CORRECTION,
  failure_pattern: LearningKind.FAILURE_PATTERN,
  action_ownership: LearningKind.ACTION_OWNERSHIP,
};
const KIND_TO_WIRE: Record<LearningKind, LearningKindWire> = Object.fromEntries(
  Object.entries(KIND_FROM_WIRE).map(([wire, stored]) => [stored, wire]),
) as Record<LearningKind, LearningKindWire>;
const STATUS_VALUES = new Set(Object.values(LearningStatus));
const MAX_OBSERVATIONS_PER_CANDIDATE = 5_000;
const RECURRENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const UNSAFE_TEXT: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/u, "API credential"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/iu, "authorization credential"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "private key"],
  [/(?:api[_ -]?key|token|password|secret)\s*[:=]\s*["']?(?!\*\*\*|<redacted>)[A-Za-z0-9._~+/=-]{8,}/iu, "inline credential"],
  [/\/Users\/[^/\s]+/u, "local user path"],
  [/\/home\/[^/\s]+/u, "local user path"],
  [/\b[A-Za-z]:\\Users\\[^\\\s]+/u, "local user path"],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/u, "personal contact data"],
  [/ignore (?:all |your )?(?:previous|prior|above) (?:instructions|prompts?)/iu, "prompt injection"],
  [/disregard (?:your |the )?(?:system prompt|instructions|rules|guidelines)/iu, "prompt injection"],
  [/\bfile:\/\/\/?\S+/iu, "local file URL"],
  [/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u, "control character"],
];

type DeviceIdentity = { deviceId: string; orgId: string };

function safeText(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return undefined;
  for (const [pattern, finding] of UNSAFE_TEXT) {
    if (pattern.test(normalized)) throw new BadRequestException(`${label} contains ${finding}; redact it before submission`);
  }
  return normalized;
}

function requiredSafeText(value: string, label: string): string {
  const safe = safeText(value, label);
  if (!safe) throw new BadRequestException(`${label} is required`);
  return safe;
}

function publicCandidate(candidate: any) {
  return {
    id: candidate.id,
    pattern_key: candidate.patternKey,
    kind: KIND_TO_WIRE[candidate.kind as LearningKind],
    summary: candidate.summary,
    rationale: candidate.rationale ?? undefined,
    pending_summary: candidate.pendingSummary ?? undefined,
    pending_rationale: candidate.pendingRationale ?? undefined,
    status: String(candidate.status).toLowerCase(),
    occurrence_count: candidate.occurrenceCount,
    distinct_task_count: candidate.distinctTaskCount,
    promotion_ready:
      candidate.occurrenceCount >= 3
      && candidate.distinctTaskCount >= 2,
    revision: candidate.revision,
    source_version: candidate.sourceVersion,
    reviewed_at: candidate.reviewedAt?.toISOString?.() ?? undefined,
    reviewed_by: candidate.reviewedBy ?? undefined,
    review_note: candidate.reviewNote ?? undefined,
    created_at: candidate.createdAt.toISOString(),
    updated_at: candidate.updatedAt.toISOString(),
  };
}

@Injectable()
export class LearningsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlement: EntitlementService,
  ) {}

  private async deviceIdentity(bearer: string | undefined): Promise<DeviceIdentity> {
    if (!bearer) throw new UnauthorizedException("missing token");
    const token = await this.prisma.deviceToken.findUnique({
      where: { tokenHash: sha256(bearer) },
      include: { device: { select: { id: true, orgId: true } } },
    });
    await assertTokenUsable(token);
    if (!token?.device) throw new UnauthorizedException("device identity is unavailable");
    return { deviceId: token.device.id, orgId: token.device.orgId };
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: any) {
        if (error?.code !== "P2034" || attempt === 2) throw error;
      }
    }
    throw new ConflictException("learning update conflicted; retry");
  }

  async submit(bearer: string | undefined, input: SubmitLearningCandidateDto) {
    const identity = await this.deviceIdentity(bearer);
    this.entitlement.assert("agent-org");
    const summary = requiredSafeText(input.summary, "summary");
    const rationale = safeText(input.rationale, "rationale");
    const now = Date.now();
    const observations = input.evidence.map((item) => ({
      ...item,
      summary: requiredSafeText(item.summary, "evidence summary"),
      observedAt: new Date(item.observed_at),
    }));
    if (observations.some((item) => item.observedAt.getTime() > now + FUTURE_CLOCK_SKEW_MS)) {
      throw new BadRequestException("evidence timestamp is too far in the future");
    }
    const kind = KIND_FROM_WIRE[input.kind];
    const candidate = await this.serializable(async (tx) => {
      let current = await tx.learningCandidate.upsert({
        where: {
          orgId_patternKey_kind: {
            orgId: identity.orgId,
            patternKey: input.pattern_key,
            kind,
          },
        },
        create: {
          orgId: identity.orgId,
          patternKey: input.pattern_key,
          kind,
          summary,
          rationale,
          sourceVersion: input.source_version,
        },
        update: {},
      });

      const changedProposal = current.summary !== summary || (current.rationale ?? undefined) !== rationale;
      if (changedProposal) {
        if (current.status === LearningStatus.PENDING) {
          current = await tx.learningCandidate.update({
            where: { id: current.id },
            data: { summary, rationale: rationale ?? null, sourceVersion: input.source_version },
          });
        } else {
          current = await tx.learningCandidate.update({
            where: { id: current.id },
            data: {
              pendingSummary: summary,
              pendingRationale: rationale ?? null,
              pendingAt: new Date(),
              sourceVersion: input.source_version,
            },
          });
        }
      }

      const existingCount = await tx.learningObservation.count({ where: { candidateId: current.id } });
      if (existingCount >= MAX_OBSERVATIONS_PER_CANDIDATE) {
        throw new BadRequestException("learning candidate reached its bounded evidence capacity");
      }
      await tx.learningObservation.createMany({
        data: observations.slice(0, MAX_OBSERVATIONS_PER_CANDIDATE - existingCount).map((item) => ({
          candidateId: current.id,
          orgId: identity.orgId,
          deviceId: identity.deviceId,
          clientId: input.client_id,
          taskHash: item.task_hash,
          fingerprint: item.fingerprint,
          summary: item.summary,
          source: item.source,
          sourceVersion: item.source_version,
          observedAt: item.observedAt,
        })),
        skipDuplicates: true,
      });
      const recurrenceSince = new Date(Date.now() - RECURRENCE_WINDOW_MS);
      const [occurrenceCount, tasks] = await Promise.all([
        tx.learningObservation.count({
          where: { candidateId: current.id, observedAt: { gte: recurrenceSince } },
        }),
        tx.learningObservation.findMany({
          where: { candidateId: current.id, observedAt: { gte: recurrenceSince } },
          select: { taskHash: true },
          distinct: ["taskHash"],
        }),
      ]);
      return tx.learningCandidate.update({
        where: { id: current.id },
        data: {
          occurrenceCount,
          distinctTaskCount: tasks.length,
          sourceVersion: input.source_version,
        },
      });
    });
    await this.audit.log(identity.orgId, "learning.candidate.submit", "device", identity.deviceId, {
      candidateId: candidate.id,
      occurrenceCount: candidate.occurrenceCount,
      distinctTaskCount: candidate.distinctTaskCount,
      hasPendingUpdate: Boolean(candidate.pendingSummary),
    });
    return publicCandidate(candidate);
  }

  async bundle(bearer: string | undefined) {
    const identity = await this.deviceIdentity(bearer);
    this.entitlement.assert("agent-org");
    const [organization, candidates] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: identity.orgId }, select: { learningVersion: true } }),
      this.prisma.learningCandidate.findMany({
        where: { orgId: identity.orgId, status: LearningStatus.APPROVED },
        orderBy: [{ kind: "asc" }, { patternKey: "asc" }],
      }),
    ]);
    if (!organization) throw new NotFoundException("organization not found");
    return {
      version: organization.learningVersion,
      learnings: candidates.map((candidate) => ({
        id: candidate.id,
        pattern_key: candidate.patternKey,
        kind: KIND_TO_WIRE[candidate.kind],
        summary: candidate.summary,
        rationale: candidate.rationale ?? undefined,
        occurrence_count: candidate.occurrenceCount,
        distinct_task_count: candidate.distinctTaskCount,
        revision: candidate.revision,
        updated_at: candidate.updatedAt.toISOString(),
      })),
    };
  }

  async list(orgId: string, status?: string) {
    this.entitlement.assert("agent-org");
    const normalizedStatus = status?.toUpperCase();
    if (normalizedStatus && !STATUS_VALUES.has(normalizedStatus as LearningStatus)) {
      throw new BadRequestException("invalid learning status");
    }
    const candidates = await this.prisma.learningCandidate.findMany({
      where: {
        orgId,
        ...(normalizedStatus ? { status: normalizedStatus as LearningStatus } : {}),
      },
      include: {
        observations: {
          orderBy: { observedAt: "desc" },
          take: 8,
          select: {
            id: true,
            summary: true,
            source: true,
            sourceVersion: true,
            observedAt: true,
          },
        },
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 1_000,
    });
    return candidates.map((candidate) => ({
      ...publicCandidate(candidate),
      observations: candidate.observations.map((item) => ({
        id: item.id,
        summary: item.summary,
        source: item.source,
        source_version: item.sourceVersion,
        observed_at: item.observedAt.toISOString(),
      })),
    }));
  }

  async review(
    id: string,
    input: ReviewLearningCandidateDto,
    actor: { id: string; email: string },
  ) {
    this.entitlement.assert("agent-org");
    const now = new Date();
    const result = await this.serializable(async (tx) => {
      const current = await tx.learningCandidate.findUnique({ where: { id } });
      if (!current) throw new NotFoundException("learning candidate not found");
      if (current.revision !== input.expected_revision) {
        throw new ConflictException(`learning candidate changed (current revision ${current.revision})`);
      }
      let activeChanged = false;
      let data: Prisma.LearningCandidateUpdateInput;
      if (input.decision === "approve") {
        const summary = current.pendingSummary ?? current.summary;
        const rationale = current.pendingSummary ? current.pendingRationale : current.rationale;
        activeChanged = current.status !== LearningStatus.APPROVED
          || summary !== current.summary
          || rationale !== current.rationale;
        data = {
          status: LearningStatus.APPROVED,
          summary,
          rationale,
          pendingSummary: null,
          pendingRationale: null,
          pendingAt: null,
        };
      } else if (input.decision === "reject") {
        if (current.status === LearningStatus.APPROVED) {
          if (!current.pendingSummary) throw new BadRequestException("approved learning has no pending update to reject; revoke it instead");
          data = { pendingSummary: null, pendingRationale: null, pendingAt: null };
        } else {
          data = {
            status: LearningStatus.REJECTED,
            pendingSummary: null,
            pendingRationale: null,
            pendingAt: null,
          };
        }
      } else {
        if (current.status !== LearningStatus.APPROVED) throw new BadRequestException("only approved learning can be revoked");
        activeChanged = true;
        data = {
          status: LearningStatus.REVOKED,
          pendingSummary: null,
          pendingRationale: null,
          pendingAt: null,
        };
      }
      const updated = await tx.learningCandidate.update({
        where: { id },
        data: {
          ...data,
          revision: { increment: 1 },
          reviewedAt: now,
          reviewedBy: actor.email,
          reviewNote: input.note?.trim() || null,
        },
      });
      const organization = activeChanged
        ? await tx.organization.update({
            where: { id: current.orgId },
            data: { learningVersion: { increment: 1 } },
            select: { learningVersion: true },
          })
        : await tx.organization.findUnique({
            where: { id: current.orgId },
            select: { learningVersion: true },
          });
      return { updated, orgId: current.orgId, learningVersion: organization?.learningVersion ?? 0, activeChanged };
    });
    await this.audit.log(result.orgId, `learning.candidate.${input.decision}`, "admin", actor.id, {
      candidateId: result.updated.id,
      revision: result.updated.revision,
      activeChanged: result.activeChanged,
      learningVersion: result.learningVersion,
    });
    return { ...publicCandidate(result.updated), learning_version: result.learningVersion };
  }

  async candidateOrgId(id: string): Promise<string> {
    this.entitlement.assert("agent-org");
    const candidate = await this.prisma.learningCandidate.findUnique({
      where: { id },
      select: { orgId: true },
    });
    if (!candidate) throw new NotFoundException("learning candidate not found");
    return candidate.orgId;
  }
}
