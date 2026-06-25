-- Tamper-evident audit log: add the per-org hash-chain columns to AuditLog.
--   seq      — per-org monotonic position in the chain (default 0 for any pre-existing rows)
--   prevHash — rowHash of the previous audit row in this org's chain
--   rowHash  — sha256(canonical(this) + prevHash); breaking any historical row breaks the chain
-- Backward-compatible: NULLable-safe via DEFAULT '' / 0, so existing rows keep working. Pre-existing
-- rows have empty hashes (chain "starts" once new rows arrive); verify() treats an all-empty prefix
-- as the genesis. Re-runnable via IF NOT EXISTS.

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "prevHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "rowHash" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_orgId_seq_idx" ON "AuditLog"("orgId", "seq");
