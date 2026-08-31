CREATE TYPE "FeedbackTicketSource" AS ENUM ('FEISHU', 'CONTROL', 'INTERNAL');
CREATE TYPE "FeedbackTicketKind" AS ENUM ('BUG', 'SUGGESTION', 'CRASH', 'OTHER');
CREATE TYPE "FeedbackTicketPriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL', 'LOW');
CREATE TYPE "FeedbackTicketStatus" AS ENUM (
  'RECEIVED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'WAITING_RELEASE',
  'WAITING_VERIFICATION',
  'CLOSED',
  'BLOCKED',
  'REJECTED'
);
CREATE TYPE "FeedbackTicketEventKind" AS ENUM (
  'CREATED',
  'ACKNOWLEDGED',
  'STATUS_CHANGED',
  'NOTE',
  'RELEASED',
  'CLOSED'
);

CREATE TABLE "FeedbackTicket" (
  "id" TEXT NOT NULL,
  "number" SERIAL NOT NULL,
  "source" "FeedbackTicketSource" NOT NULL,
  "sourceRef" VARCHAR(200) NOT NULL,
  "sourceChatRef" VARCHAR(200) NOT NULL DEFAULT '',
  "kind" "FeedbackTicketKind" NOT NULL DEFAULT 'OTHER',
  "priority" "FeedbackTicketPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "FeedbackTicketStatus" NOT NULL DEFAULT 'RECEIVED',
  "title" VARCHAR(240) NOT NULL,
  "summary" VARCHAR(2000) NOT NULL DEFAULT '',
  "reporterRef" VARCHAR(200) NOT NULL DEFAULT '',
  "assignee" VARCHAR(160) NOT NULL DEFAULT '',
  "fixVersion" VARCHAR(64) NOT NULL DEFAULT '',
  "verificationSteps" VARCHAR(1200) NOT NULL DEFAULT '',
  "claimOwner" VARCHAR(160) NOT NULL DEFAULT '',
  "claimTokenHash" VARCHAR(64) NOT NULL DEFAULT '',
  "claimExpiresAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FeedbackTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FeedbackTicket_number_positive" CHECK ("number" > 0)
);

CREATE TABLE "FeedbackTicketEvent" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "kind" "FeedbackTicketEventKind" NOT NULL,
  "fromStatus" "FeedbackTicketStatus",
  "toStatus" "FeedbackTicketStatus",
  "note" VARCHAR(1200) NOT NULL DEFAULT '',
  "actor" VARCHAR(160) NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FeedbackTicketEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeedbackTicket_number_key" ON "FeedbackTicket"("number");
CREATE UNIQUE INDEX "FeedbackTicket_source_sourceRef_key" ON "FeedbackTicket"("source", "sourceRef");
CREATE INDEX "FeedbackTicket_status_priority_updatedAt_idx" ON "FeedbackTicket"("status", "priority", "updatedAt");
CREATE INDEX "FeedbackTicket_kind_updatedAt_idx" ON "FeedbackTicket"("kind", "updatedAt");
CREATE INDEX "FeedbackTicket_claimExpiresAt_idx" ON "FeedbackTicket"("claimExpiresAt");
CREATE INDEX "FeedbackTicketEvent_ticketId_createdAt_idx" ON "FeedbackTicketEvent"("ticketId", "createdAt");

ALTER TABLE "FeedbackTicketEvent"
  ADD CONSTRAINT "FeedbackTicketEvent_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "FeedbackTicket"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
