-- Device revocation is deliberately two phase. The request timestamp is persisted in the same
-- transaction that locally revokes every DeviceToken, before any fallible remote gateway call.
-- Completion is recorded only after all remote keys and the exact Desk installation are gone.
ALTER TABLE "Device"
  ADD COLUMN "revocationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "revocationCompletedAt" TIMESTAMP(3);

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_revocation_order"
  CHECK (
    "revocationCompletedAt" IS NULL
    OR (
      "revocationRequestedAt" IS NOT NULL
      AND "revocationCompletedAt" >= "revocationRequestedAt"
    )
  );

CREATE INDEX "Device_revocationRequestedAt_revocationCompletedAt_idx"
  ON "Device"("revocationRequestedAt", "revocationCompletedAt");
