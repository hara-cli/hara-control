-- CreateEnum
CREATE TYPE "WorkSessionKind" AS ENUM ('CODING', 'REVIEW', 'AGENT_RUN', 'CHAT');

-- CreateEnum
CREATE TYPE "WorkOutcome" AS ENUM ('COMMITTED', 'ABANDONED', 'BLOCKED', 'ERROR', 'UNKNOWN');

-- CreateTable
CREATE TABLE "WorkSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "personId" TEXT,
    "roleKey" TEXT NOT NULL DEFAULT '',
    "kind" "WorkSessionKind" NOT NULL DEFAULT 'CODING',
    "repoHash" TEXT NOT NULL DEFAULT '',
    "taskTitle" TEXT NOT NULL DEFAULT '',
    "toolCalls" JSONB NOT NULL DEFAULT '{}',
    "tasksCount" INTEGER NOT NULL DEFAULT 0,
    "filesTouched" INTEGER NOT NULL DEFAULT 0,
    "filePathsHashed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalsRequested" INTEGER NOT NULL DEFAULT 0,
    "approvalsGranted" INTEGER NOT NULL DEFAULT 0,
    "outcome" "WorkOutcome" NOT NULL DEFAULT 'UNKNOWN',
    "commitShas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT NOT NULL DEFAULT '',
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" INTEGER NOT NULL,
    "prevHash" TEXT NOT NULL DEFAULT '',
    "rowHash" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkSession_orgId_at_idx" ON "WorkSession"("orgId", "at");

-- CreateIndex
CREATE INDEX "WorkSession_orgId_personId_startedAt_idx" ON "WorkSession"("orgId", "personId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkSession_orgId_repoHash_idx" ON "WorkSession"("orgId", "repoHash");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSession_deviceId_seq_key" ON "WorkSession"("deviceId", "seq");

-- CreateIndex
CREATE INDEX "WorkEvent_orgId_sessionId_idx" ON "WorkEvent"("orgId", "sessionId");

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkEvent" ADD CONSTRAINT "WorkEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkEvent" ADD CONSTRAINT "WorkEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
