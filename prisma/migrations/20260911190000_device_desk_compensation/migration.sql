-- Persist only the non-secret information required to compensate or revoke a separately
-- provisioned Hara Desk installation. Desk Agent/Session bearers remain outside Control.
ALTER TABLE "Device"
  ADD COLUMN "deskProvisionedAt" TIMESTAMP(3),
  ADD COLUMN "deskCleanupPendingAt" TIMESTAMP(3),
  ADD COLUMN "deskOwner" TEXT,
  ADD COLUMN "deskOrigin" TEXT;

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_desk_compensation_complete"
  CHECK (
    ("deskProvisionedAt" IS NULL AND "deskCleanupPendingAt" IS NULL AND "deskOwner" IS NULL AND "deskOrigin" IS NULL)
    OR
    ("deskProvisionedAt" IS NOT NULL AND "deskCleanupPendingAt" IS NULL AND "deskOwner" IS NOT NULL AND "deskOrigin" IS NOT NULL)
    OR
    ("deskProvisionedAt" IS NULL AND "deskCleanupPendingAt" IS NOT NULL AND "deskOwner" IS NOT NULL AND "deskOrigin" IS NOT NULL)
  );

-- Codes created before accountable Person enrollment became mandatory must never fall back to a
-- client-controlled device name for Desk ownership. Consume any still-unused legacy code during
-- rollout; administrators can issue a fresh Person-bound code afterward.
UPDATE "EnrollCode"
SET "usedAt" = CURRENT_TIMESTAMP
WHERE "personId" IS NULL AND "usedAt" IS NULL;
