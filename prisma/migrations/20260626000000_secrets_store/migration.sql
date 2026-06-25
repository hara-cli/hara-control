-- At-rest secret envelope store (HARDENING.md §B). Additive + re-runnable.
--   ciphertext — secret plaintext encrypted under a per-secret DEK (AES-256-GCM; iv||tag||enc packed)
--   wrappedDek — that DEK encrypted ("wrapped") under the KMS master CEK (iv||tag||enc packed)
--   keyRef     — which CEK wrapped the DEK (drives rotation / multi-provider)
-- We persist ONLY the envelope — never plaintext, never an unwrapped DEK. orgId is also bound as the
-- GCM AAD on the ciphertext so a row can't be replayed across tenants. orgId is nullable: NULL = a
-- control-plane-global secret (e.g. the upstream provider key). Not FK'd to Organization on purpose —
-- the tenant binding is cryptographic (AAD), and global secrets have no org.

CREATE TABLE IF NOT EXISTS "Secret" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "keyRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- Unique per (orgId, name). NOTE: in Postgres NULLs are distinct, so multiple global (orgId IS NULL)
-- secrets with the SAME name would not collide under a plain unique index. Belt-and-suspenders: also a
-- partial unique index keyed on name for the global namespace so global names stay unique too.
CREATE UNIQUE INDEX IF NOT EXISTS "Secret_orgId_name_key" ON "Secret"("orgId", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "Secret_global_name_key" ON "Secret"("name") WHERE "orgId" IS NULL;
CREATE INDEX IF NOT EXISTS "Secret_orgId_idx" ON "Secret"("orgId");
