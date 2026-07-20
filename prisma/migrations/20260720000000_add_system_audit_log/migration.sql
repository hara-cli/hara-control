-- Control-plane-wide security events which cannot be attached to a customer org.
-- Credential values and credential-derived fingerprints are forbidden from payload.
CREATE TABLE "SystemAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SystemAuditLog_at_idx" ON "SystemAuditLog"("at");
CREATE INDEX "SystemAuditLog_action_at_idx" ON "SystemAuditLog"("action", "at");

-- PostgreSQL considers NULLs distinct in a compound unique constraint. Without this partial
-- index, concurrent/global credential writes can create multiple rows for the same logical secret.
CREATE UNIQUE INDEX "Secret_global_name_key"
ON "Secret"("name")
WHERE "orgId" IS NULL;

-- A credential revision is metadata only (not derived from the credential). Provider runtimes use
-- it to prove which encrypted revision they loaded without storing or exposing a fingerprint.
ALTER TABLE "Secret" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "ProviderActivation" (
    "provider" TEXT NOT NULL,
    "secretName" TEXT NOT NULL,
    "secretVersion" INTEGER NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderActivation_pkey" PRIMARY KEY ("provider")
);

CREATE INDEX "ProviderActivation_activatedAt_idx" ON "ProviderActivation"("activatedAt");

-- The hash-chain append code runs SERIALIZABLE with bounded conflict retries. The database
-- uniqueness constraint is the final fail-closed guard against a concurrent fork.
-- Versions before this constraint assigned every pre-chain row seq=0 with empty hashes. Re-sequence
-- only organizations whose entire duplicate history is still that unauthenticated legacy prefix.
-- If any duplicate organization already contains a hash, abort instead of silently rewriting an
-- anchored identity (seq is part of rowHash).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AuditLog" a
    WHERE a."orgId" IN (
      SELECT "orgId"
      FROM "AuditLog"
      GROUP BY "orgId", "seq"
      HAVING COUNT(*) > 1
    )
      AND (a."rowHash" <> '' OR a."prevHash" <> '')
  ) THEN
    RAISE EXCEPTION 'AuditLog has duplicate sequence values inside a hashed chain; manual integrity review required';
  END IF;
END
$$;

WITH duplicate_orgs AS (
  SELECT DISTINCT "orgId"
  FROM "AuditLog"
  GROUP BY "orgId", "seq"
  HAVING COUNT(*) > 1
),
ranked_legacy AS (
  SELECT a."id",
         (ROW_NUMBER() OVER (
           PARTITION BY a."orgId"
           ORDER BY a."at" ASC, a."id" ASC
         ) - 1)::INTEGER AS "newSeq"
  FROM "AuditLog" a
  INNER JOIN duplicate_orgs d ON d."orgId" = a."orgId"
)
UPDATE "AuditLog" a
SET "seq" = r."newSeq"
FROM ranked_legacy r
WHERE a."id" = r."id";

DROP INDEX IF EXISTS "AuditLog_orgId_seq_idx";
CREATE UNIQUE INDEX "AuditLog_orgId_seq_key" ON "AuditLog"("orgId", "seq");
