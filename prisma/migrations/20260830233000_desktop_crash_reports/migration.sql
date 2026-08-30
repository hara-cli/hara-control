CREATE TYPE "DesktopCrashReportStatus" AS ENUM ('NEW', 'REVIEWING', 'RESOLVED', 'IGNORED');

CREATE TABLE "DesktopCrashReport" (
  "id" TEXT NOT NULL,
  "status" "DesktopCrashReportStatus" NOT NULL DEFAULT 'NEW',
  "reportVersion" INTEGER NOT NULL,
  "consentVersion" INTEGER NOT NULL,
  "appVersion" VARCHAR(48) NOT NULL,
  "engineVersion" VARCHAR(48) NOT NULL DEFAULT '',
  "platform" VARCHAR(24) NOT NULL,
  "arch" VARCHAR(24) NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "userDescription" VARCHAR(1200) NOT NULL DEFAULT '',
  "context" JSONB NOT NULL DEFAULT '[]',
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "lastOccurredAt" TIMESTAMP(3) NOT NULL,
  "reviewNote" VARCHAR(1000) NOT NULL DEFAULT '',
  "reviewedBy" VARCHAR(160) NOT NULL DEFAULT '',
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DesktopCrashReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DesktopCrashReport_reportVersion_check" CHECK ("reportVersion" = 1),
  CONSTRAINT "DesktopCrashReport_consentVersion_check" CHECK ("consentVersion" = 1),
  CONSTRAINT "DesktopCrashReport_occurrenceCount_check" CHECK ("occurrenceCount" > 0)
);

CREATE UNIQUE INDEX "DesktopCrashReport_dedupe_key"
  ON "DesktopCrashReport"("fingerprint", "appVersion", "platform", "arch", "kind");
CREATE INDEX "DesktopCrashReport_status_lastOccurredAt_idx"
  ON "DesktopCrashReport"("status", "lastOccurredAt");
CREATE INDEX "DesktopCrashReport_lastOccurredAt_idx" ON "DesktopCrashReport"("lastOccurredAt");
