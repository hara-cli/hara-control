import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BadRequestException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import {
  AdminRole,
  FeedbackTicketKind,
  FeedbackTicketPriority,
  FeedbackTicketSource,
  FeedbackTicketStatus,
  Prisma,
} from "@prisma/client";
import type { PrismaService } from "../src/prisma/prisma.service";
import { FeedbackIntakeGuard } from "../src/feedback-tickets/feedback-intake.guard";
import {
  FeedbackTicketsService,
  formatTicketNumber,
} from "../src/feedback-tickets/feedback-tickets.service";

function fakePrisma() {
  const rows: Record<string, Record<string, unknown>> = {};
  const events: Array<Record<string, unknown>> = [];
  let nextNumber = 1;
  const findByWhere = (where: Record<string, unknown>) => {
    if (where.id) return rows[String(where.id)] ?? null;
    const composite = where.source_sourceRef as { source: string; sourceRef: string } | undefined;
    if (!composite) return null;
    return Object.values(rows).find((row) => (
      row.source === composite.source && row.sourceRef === composite.sourceRef
    )) ?? null;
  };
  const pick = (row: Record<string, unknown> | null, select?: Record<string, unknown>) => {
    if (!row || !select) return row ? { ...row } : null;
    const output: Record<string, unknown> = {};
    for (const [key, enabled] of Object.entries(select)) {
      if (enabled === true) output[key] = row[key];
      if (key === "events" && typeof enabled === "object") {
        output.events = events.filter((event) => event.ticketId === row.id).map((event) => ({ ...event }));
      }
    }
    return output;
  };
  const feedbackTicket = {
    create: async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, unknown> }) => {
      if (Object.values(rows).some((row) => row.source === data.source && row.sourceRef === data.sourceRef)) {
        throw new Prisma.PrismaClientKnownRequestError("duplicate feedback source", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const now = new Date();
      const row: Record<string, unknown> = {
        id: `ticket_${nextNumber}`,
        number: nextNumber,
        status: FeedbackTicketStatus.RECEIVED,
        priority: FeedbackTicketPriority.NORMAL,
        assignee: "",
        fixVersion: "",
        verificationSteps: "",
        acknowledgedAt: null,
        startedAt: null,
        releasedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      delete row.events;
      rows[String(row.id)] = row;
      const nested = data.events as { create?: Record<string, unknown> } | undefined;
      if (nested?.create) events.push({ id: `event_${events.length + 1}`, ticketId: row.id, createdAt: now, ...nested.create });
      nextNumber += 1;
      return pick(row, select);
    },
    findUnique: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
      pick(findByWhere(where), select),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows[String(where.id)];
      if (!row) return { count: 0 };
      const allowed = ![FeedbackTicketStatus.CLOSED, FeedbackTicketStatus.REJECTED].includes(row.status as FeedbackTicketStatus);
      const canClaim = !row.claimExpiresAt
        || (row.claimExpiresAt as Date).getTime() <= Date.now()
        || row.claimOwner === (data.claimOwner as string);
      if (!allowed || !canClaim) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    },
    findMany: async ({ where, take, select }: {
      where: Record<string, unknown>;
      take: number;
      select?: Record<string, unknown>;
    }) => Object.values(rows)
      .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
      .slice(0, take)
      .map((row) => pick(row, select)),
    update: async ({ where, data, select }: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const row = rows[where.id];
      Object.assign(row, data, { updatedAt: new Date() });
      return pick(row, select);
    },
  };
  const feedbackTicketEvent = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const event = { id: `event_${events.length + 1}`, createdAt: new Date(), ...data };
      events.push(event);
      return event;
    },
  };
  const prisma = {
    feedbackTicket,
    feedbackTicketEvent,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ feedbackTicket, feedbackTicketEvent }),
  } as unknown as PrismaService;
  return { prisma, rows, events };
}

function intake(sourceRef = "om_feedback_1", consumerId = "monitor-a") {
  return {
    source: FeedbackTicketSource.FEISHU,
    sourceRef,
    sourceChatRef: "oc_hara_feedback",
    kind: FeedbackTicketKind.BUG,
    priority: FeedbackTicketPriority.HIGH,
    title: "Desktop cannot open",
    summary: "token=forbidden /Users/alice/customer/project",
    reporterRef: "ou_tester",
    consumerId,
  };
}

test("ticket intake assigns a stable number, redacts text, and grants one processing lease", async () => {
  const fake = fakePrisma();
  const service = new FeedbackTicketsService(fake.prisma);

  const first = await service.intake(intake());
  assert.equal(first.created, true);
  assert.equal(first.claimGranted, true);
  assert.equal(first.ticket.ticketNumber, "HARA-000001");
  assert.ok(first.claimToken);
  assert.doesNotMatch(JSON.stringify(first), /forbidden|alice/i);
  assert.doesNotMatch(JSON.stringify(first), /claimTokenHash/i);

  const competing = await service.intake(intake("om_feedback_1", "monitor-b"));
  assert.equal(competing.created, false);
  assert.equal(competing.claimGranted, false);
  assert.equal(competing.ticket.ticketNumber, "HARA-000001");
  assert.equal("claimToken" in competing, false);

  const sameConsumer = await service.intake(intake("om_feedback_1", "monitor-a"));
  assert.equal(sameConsumer.created, false);
  assert.equal(sameConsumer.claimGranted, true);
  assert.equal(Object.keys(fake.rows).length, 1);
  assert.equal(fake.events.length, 1, "idempotent retries do not duplicate the CREATED timeline event");
});

test("ticket state machine requires release evidence and records an append-only timeline", async () => {
  const fake = fakePrisma();
  const service = new FeedbackTicketsService(fake.prisma);
  const receipt = await service.intake(intake());
  const id = receipt.ticket.id;
  const actor = { id: "admin_1", email: "operator@example.test", role: AdminRole.SUPERADMIN };

  await service.update(id, { status: FeedbackTicketStatus.ACKNOWLEDGED }, actor);
  await service.update(id, { status: FeedbackTicketStatus.IN_PROGRESS, assignee: "Codex" }, actor);
  await service.update(id, { status: FeedbackTicketStatus.WAITING_RELEASE, note: "tests green" }, actor);
  await assert.rejects(
    () => service.update(id, { status: FeedbackTicketStatus.WAITING_VERIFICATION }, actor),
    BadRequestException,
  );
  await service.update(id, {
    status: FeedbackTicketStatus.WAITING_VERIFICATION,
    fixVersion: "0.1.127",
    verificationSteps: "Upgrade and open the same project twice.",
    note: "public release verified",
  }, actor);
  const closed = await service.update(id, {
    status: FeedbackTicketStatus.CLOSED,
    note: "reporter verified",
  }, actor);
  assert.equal(closed.status, FeedbackTicketStatus.CLOSED);
  assert.equal(closed.fixVersion, "0.1.127");
  assert.ok(closed.closedAt);
  assert.equal(fake.events.length, 6);
  assert.deepEqual(fake.events.map((event) => event.kind), [
    "CREATED",
    "ACKNOWLEDGED",
    "STATUS_CHANGED",
    "STATUS_CHANGED",
    "RELEASED",
    "CLOSED",
  ]);
});

test("ticket state machine rejects skips and requires a blocked reason", async () => {
  const fake = fakePrisma();
  const service = new FeedbackTicketsService(fake.prisma);
  const receipt = await service.intake(intake());
  const actor = { id: "admin_1", email: "operator@example.test", role: AdminRole.SUPERADMIN };

  await assert.rejects(
    () => service.update(receipt.ticket.id, { status: FeedbackTicketStatus.CLOSED }, actor),
    BadRequestException,
  );
  await assert.rejects(
    () => service.update(receipt.ticket.id, { status: FeedbackTicketStatus.BLOCKED }, actor),
    BadRequestException,
  );
});

test("claimed transition rejects an invalid lease token", async () => {
  const fake = fakePrisma();
  const service = new FeedbackTicketsService(fake.prisma);
  const receipt = await service.intake(intake());
  await assert.rejects(
    () => service.updateClaimed(receipt.ticket.id, {
      status: FeedbackTicketStatus.ACKNOWLEDGED,
      claimToken: "x".repeat(43),
    }),
    UnauthorizedException,
  );
});

test("feedback intake guard is purpose-scoped and timing-safe", () => {
  const previous = process.env.HARA_FEEDBACK_INTAKE_KEY;
  process.env.HARA_FEEDBACK_INTAKE_KEY = "a".repeat(40);
  const context = (value: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { "x-hara-feedback-key": value } }) }),
  }) as unknown as ExecutionContext;
  try {
    const guard = new FeedbackIntakeGuard();
    assert.equal(guard.canActivate(context("a".repeat(40))), true);
    assert.throws(() => guard.canActivate(context("wrong")), UnauthorizedException);
  } finally {
    if (previous === undefined) delete process.env.HARA_FEEDBACK_INTAKE_KEY;
    else process.env.HARA_FEEDBACK_INTAKE_KEY = previous;
  }
});

test("ticket numbers remain readable beyond six digits", () => {
  assert.equal(formatTicketNumber(7), "HARA-000007");
  assert.equal(formatTicketNumber(1_000_000), "HARA-1000000");
});
