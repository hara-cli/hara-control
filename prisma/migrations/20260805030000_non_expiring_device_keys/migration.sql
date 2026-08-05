-- A non-expiring managed key is an explicit, auditable policy choice. It remains model-scoped,
-- budgeted, observable, and revocable; false preserves every existing enrollment's finite TTL.
ALTER TABLE "EnrollCode"
  ADD COLUMN "tokenNeverExpires" BOOLEAN NOT NULL DEFAULT false;
