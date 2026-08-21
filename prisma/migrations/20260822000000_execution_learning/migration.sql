-- Reviewable organization learning: devices submit only redacted evidence candidates; administrators
-- approve/reject/revoke, and devices pull one versioned approved bundle.
CREATE TYPE "LearningKind" AS ENUM (
  'BUSINESS_RULE',
  'USER_PREFERENCE',
  'WORKFLOW',
  'CORRECTION',
  'FAILURE_PATTERN',
  'ACTION_OWNERSHIP'
);

CREATE TYPE "LearningStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REVOKED'
);

ALTER TABLE "Organization"
  ADD COLUMN "learningVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "learning_candidates" (
  "id" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "patternKey" VARCHAR(120) NOT NULL,
  "kind" "LearningKind" NOT NULL,
  "summary" VARCHAR(1200) NOT NULL,
  "rationale" VARCHAR(1000),
  "pendingSummary" VARCHAR(1200),
  "pendingRationale" VARCHAR(1000),
  "pendingAt" TIMESTAMPTZ(6),
  "status" "LearningStatus" NOT NULL DEFAULT 'PENDING',
  "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
  "distinctTaskCount" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "sourceVersion" VARCHAR(64) NOT NULL DEFAULT '',
  "reviewedAt" TIMESTAMPTZ(6),
  "reviewedBy" VARCHAR(160),
  "reviewNote" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "learning_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "learning_observations" (
  "id" UUID NOT NULL,
  "candidateId" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "taskHash" CHAR(32) NOT NULL,
  "fingerprint" CHAR(32) NOT NULL,
  "summary" VARCHAR(1000) NOT NULL,
  "source" VARCHAR(40) NOT NULL,
  "sourceVersion" VARCHAR(64) NOT NULL,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "learning_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "learning_candidates_orgId_patternKey_kind_key"
  ON "learning_candidates"("orgId", "patternKey", "kind");
CREATE INDEX "learning_candidates_orgId_status_updatedAt_idx"
  ON "learning_candidates"("orgId", "status", "updatedAt");
CREATE UNIQUE INDEX "learning_observations_deviceId_clientId_fingerprint_key"
  ON "learning_observations"("deviceId", "clientId", "fingerprint");
CREATE INDEX "learning_observations_candidateId_observedAt_idx"
  ON "learning_observations"("candidateId", "observedAt");
CREATE INDEX "learning_observations_orgId_taskHash_idx"
  ON "learning_observations"("orgId", "taskHash");

ALTER TABLE "learning_candidates"
  ADD CONSTRAINT "learning_candidates_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "learning_observations"
  ADD CONSTRAINT "learning_observations_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "learning_candidates"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_observations"
  ADD CONSTRAINT "learning_observations_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_observations"
  ADD CONSTRAINT "learning_observations_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
