CREATE TYPE "DesktopCrashAlertState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

ALTER TABLE "DesktopCrashReport"
  ADD COLUMN "alertState" "DesktopCrashAlertState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "alertGeneration" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "alertAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "alertNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "alertClaimedAt" TIMESTAMP(3),
  ADD COLUMN "alertDeliveredAt" TIMESTAMP(3),
  ADD COLUMN "alertLastError" VARCHAR(300) NOT NULL DEFAULT '';

ALTER TABLE "DesktopCrashReport"
  ADD CONSTRAINT "DesktopCrashReport_alertGeneration_check" CHECK ("alertGeneration" > 0),
  ADD CONSTRAINT "DesktopCrashReport_alertAttempts_check" CHECK ("alertAttempts" >= 0);

CREATE INDEX "DesktopCrashReport_alertState_alertNextAttemptAt_idx"
  ON "DesktopCrashReport"("alertState", "alertNextAttemptAt");
