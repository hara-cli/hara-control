import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  FeedbackTicketEventKind,
  FeedbackTicketKind,
  FeedbackTicketPriority,
  FeedbackTicketSource,
  FeedbackTicketStatus,
  Prisma,
} from "@prisma/client";
import type { AuthedUser } from "../common/admin-auth.guard";
import { sanitizeControlText } from "../common/redact";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ClaimedFeedbackTicketUpdateDto,
  IntakeFeedbackTicketDto,
  UpdateFeedbackTicketDto,
} from "./dto";

const CLAIM_LEASE_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = new Set<FeedbackTicketStatus>([
  FeedbackTicketStatus.CLOSED,
  FeedbackTicketStatus.REJECTED,
]);

const ALLOWED_TRANSITIONS: Record<FeedbackTicketStatus, ReadonlySet<FeedbackTicketStatus>> = {
  RECEIVED: new Set(["ACKNOWLEDGED", "IN_PROGRESS", "BLOCKED", "REJECTED"]),
  ACKNOWLEDGED: new Set(["IN_PROGRESS", "BLOCKED", "REJECTED"]),
  IN_PROGRESS: new Set(["WAITING_RELEASE", "BLOCKED", "REJECTED"]),
  WAITING_RELEASE: new Set(["IN_PROGRESS", "WAITING_VERIFICATION", "BLOCKED"]),
  WAITING_VERIFICATION: new Set(["IN_PROGRESS", "CLOSED", "BLOCKED"]),
  CLOSED: new Set(["IN_PROGRESS"]),
  BLOCKED: new Set(["IN_PROGRESS", "REJECTED"]),
  REJECTED: new Set(["IN_PROGRESS"]),
};

const SAFE_TICKET_SELECT = {
  id: true,
  number: true,
  source: true,
  sourceRef: true,
  sourceChatRef: true,
  kind: true,
  priority: true,
  status: true,
  title: true,
  summary: true,
  reporterRef: true,
  assignee: true,
  fixVersion: true,
  verificationSteps: true,
  claimOwner: true,
  claimExpiresAt: true,
  acknowledgedAt: true,
  startedAt: true,
  releasedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FeedbackTicketSelect;

type SafeTicket = Prisma.FeedbackTicketGetPayload<{ select: typeof SAFE_TICKET_SELECT }>;
function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length > 0
    && actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function formatTicketNumber(number: number): string {
  return `HARA-${String(number).padStart(6, "0")}`;
}

function withDisplayNumber<T extends { number: number }>(ticket: T): T & { ticketNumber: string } {
  return { ...ticket, ticketNumber: formatTicketNumber(ticket.number) };
}

@Injectable()
export class FeedbackTicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async intake(dto: IntakeFeedbackTicketDto) {
    const now = new Date();
    const claimToken = randomBytes(32).toString("base64url");
    const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    const sourceRef = sanitizeControlText(dto.sourceRef, 200);
    const sourceChatRef = sanitizeControlText(dto.sourceChatRef ?? "", 200);
    const reporterRef = sanitizeControlText(dto.reporterRef ?? "", 200);
    const title = sanitizeControlText(dto.title, 240) || "Hara feedback";
    const summary = sanitizeControlText(dto.summary ?? "", 2000);
    const consumerId = sanitizeControlText(dto.consumerId, 160);
    if (!sourceRef || !consumerId) {
      throw new BadRequestException("feedback source and consumer identifiers must contain visible text");
    }
    let ticket: SafeTicket;
    let created = false;
    let claimGranted = false;

    try {
      ticket = await this.prisma.feedbackTicket.create({
        data: {
          source: dto.source,
          sourceRef,
          sourceChatRef,
          kind: dto.kind,
          priority: dto.priority ?? FeedbackTicketPriority.NORMAL,
          title,
          summary,
          reporterRef,
          claimOwner: consumerId,
          claimTokenHash: tokenHash(claimToken),
          claimExpiresAt,
          events: {
            create: {
              kind: FeedbackTicketEventKind.CREATED,
              toStatus: FeedbackTicketStatus.RECEIVED,
              note: summary,
              actor: consumerId,
            },
          },
        },
        select: SAFE_TICKET_SELECT,
      });
      created = true;
      claimGranted = true;
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.prisma.feedbackTicket.findUnique({
        where: { source_sourceRef: { source: dto.source, sourceRef } },
        select: SAFE_TICKET_SELECT,
      });
      if (!existing) throw error;
      ticket = existing;
      if (!TERMINAL_STATUSES.has(existing.status)) {
        const claim = await this.prisma.feedbackTicket.updateMany({
          where: {
            id: existing.id,
            status: { notIn: [...TERMINAL_STATUSES] },
            OR: [
              { claimExpiresAt: null },
              { claimExpiresAt: { lte: now } },
              { claimOwner: consumerId },
            ],
          },
          data: {
            claimOwner: consumerId,
            claimTokenHash: tokenHash(claimToken),
            claimExpiresAt,
          },
        });
        claimGranted = claim.count === 1;
        if (claimGranted) {
          ticket = (await this.prisma.feedbackTicket.findUnique({
            where: { id: existing.id },
            select: SAFE_TICKET_SELECT,
          })) ?? existing;
        }
      }
    }

    return {
      ticket: withDisplayNumber(ticket),
      created,
      claimGranted,
      ...(claimGranted ? { claimToken } : {}),
    };
  }

  async list(filters: {
    status?: string;
    kind?: string;
    priority?: string;
    limit?: number;
  }) {
    const status = this.parseOptionalEnum(filters.status, FeedbackTicketStatus, "ticket status");
    const kind = this.parseOptionalEnum(filters.kind, FeedbackTicketKind, "ticket kind");
    const priority = this.parseOptionalEnum(filters.priority, FeedbackTicketPriority, "ticket priority");
    const limit = Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(200, Math.trunc(filters.limit!)))
      : 100;
    const rows = await this.prisma.feedbackTicket.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(priority ? { priority } : {}),
      },
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
      take: limit,
      select: SAFE_TICKET_SELECT,
    });
    return rows.map(withDisplayNumber);
  }

  async get(id: string) {
    const ticket = await this.prisma.feedbackTicket.findUnique({
      where: { id },
      select: {
        ...SAFE_TICKET_SELECT,
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!ticket) throw new NotFoundException("feedback ticket not found");
    return withDisplayNumber(ticket);
  }

  async update(id: string, dto: UpdateFeedbackTicketDto, actor: AuthedUser) {
    return this.transition(id, dto, actor.email || actor.id);
  }

  async updateClaimed(id: string, dto: ClaimedFeedbackTicketUpdateDto) {
    const ticket = await this.prisma.feedbackTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException("feedback ticket not found");
    const claimed = Boolean(
      ticket.claimTokenHash
      && hashMatches(tokenHash(dto.claimToken), ticket.claimTokenHash),
    );
    if (!claimed) throw new UnauthorizedException("feedback ticket claim is invalid or superseded");
    const { claimToken: _claimToken, ...update } = dto;
    return this.transition(id, update, ticket.claimOwner || "feedback-monitor");
  }

  private async transition(id: string, dto: UpdateFeedbackTicketDto, actor: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.feedbackTicket.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("feedback ticket not found");
      if (
        dto.status !== existing.status
        && !ALLOWED_TRANSITIONS[existing.status].has(dto.status)
      ) {
        throw new BadRequestException(`invalid ticket transition ${existing.status} -> ${dto.status}`);
      }

      const note = sanitizeControlText(dto.note ?? "", 1200);
      const assignee = dto.assignee === undefined
        ? existing.assignee
        : sanitizeControlText(dto.assignee, 160);
      const fixVersion = dto.fixVersion === undefined
        ? existing.fixVersion
        : sanitizeControlText(dto.fixVersion, 64);
      const verificationSteps = dto.verificationSteps === undefined
        ? existing.verificationSteps
        : sanitizeControlText(dto.verificationSteps, 1200);

      if (dto.status === FeedbackTicketStatus.BLOCKED && !note) {
        throw new BadRequestException("a blocked ticket requires a reason");
      }
      const releaseRequiredStatuses: FeedbackTicketStatus[] = [
        FeedbackTicketStatus.WAITING_VERIFICATION,
        FeedbackTicketStatus.CLOSED,
      ];
      if (
        releaseRequiredStatuses.includes(dto.status)
        && (!fixVersion || !verificationSteps)
      ) {
        throw new BadRequestException("released and closed tickets require a version and verification steps");
      }

      const changedStatus = dto.status !== existing.status;
      const now = new Date();
      let eventKind: FeedbackTicketEventKind = FeedbackTicketEventKind.NOTE;
      if (changedStatus) eventKind = FeedbackTicketEventKind.STATUS_CHANGED;
      if (dto.status === FeedbackTicketStatus.ACKNOWLEDGED) eventKind = FeedbackTicketEventKind.ACKNOWLEDGED;
      if (dto.status === FeedbackTicketStatus.WAITING_VERIFICATION) eventKind = FeedbackTicketEventKind.RELEASED;
      if (dto.status === FeedbackTicketStatus.CLOSED) eventKind = FeedbackTicketEventKind.CLOSED;

      const data: Prisma.FeedbackTicketUpdateInput = {
        status: dto.status,
        priority: dto.priority ?? existing.priority,
        assignee,
        fixVersion,
        verificationSteps,
      };
      if (!existing.acknowledgedAt && dto.status !== FeedbackTicketStatus.RECEIVED) {
        data.acknowledgedAt = now;
      }
      const startedStatuses: FeedbackTicketStatus[] = [
        FeedbackTicketStatus.IN_PROGRESS,
        FeedbackTicketStatus.WAITING_RELEASE,
        FeedbackTicketStatus.WAITING_VERIFICATION,
        FeedbackTicketStatus.CLOSED,
      ];
      if (!existing.startedAt && startedStatuses.includes(dto.status)) {
        data.startedAt = now;
      }
      if (dto.status === FeedbackTicketStatus.WAITING_VERIFICATION) data.releasedAt = now;
      if (dto.status === FeedbackTicketStatus.CLOSED) data.closedAt = now;
      if (existing.status === FeedbackTicketStatus.CLOSED && dto.status !== FeedbackTicketStatus.CLOSED) {
        data.closedAt = null;
      }
      if ([FeedbackTicketStatus.WAITING_RELEASE, ...TERMINAL_STATUSES].includes(dto.status)) {
        data.claimOwner = "";
        data.claimTokenHash = "";
        data.claimExpiresAt = null;
      }

      const ticket = await tx.feedbackTicket.update({
        where: { id },
        data,
        select: SAFE_TICKET_SELECT,
      });
      await tx.feedbackTicketEvent.create({
        data: {
          ticketId: id,
          kind: eventKind,
          fromStatus: existing.status,
          toStatus: dto.status,
          note,
          actor: sanitizeControlText(actor, 160),
        },
      });
      return withDisplayNumber(ticket);
    });
  }

  private parseOptionalEnum<T extends Record<string, string>>(
    value: string | undefined,
    options: T,
    label: string,
  ): T[keyof T] | undefined {
    if (!value) return undefined;
    if (!Object.values(options).includes(value)) throw new BadRequestException(`invalid ${label}`);
    return value as T[keyof T];
  }
}
