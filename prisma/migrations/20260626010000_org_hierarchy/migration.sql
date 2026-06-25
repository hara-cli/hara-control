-- Org-unit HIERARCHY: make Organization a typed, self-referential tree (集团 GROUP → 公司 COMPANY →
-- 部门 DEPARTMENT → 组 TEAM). ADDITIVE + idempotent (re-runnable). Single-company mode is unaffected:
-- every pre-existing row defaults to type=COMPANY and parentId=NULL (a standalone company root). A
-- group/conglomerate is modelled later by inserting a GROUP node and pointing COMPANY rows at it.
-- Governance (policy) inherits DOWN the tree (a department inherits its company unless it overrides);
-- the resolution logic lives in OrgTreeService, not the DB. This does NOT fold the standalone `Team`
-- model into the tree — that's a deliberate later step (docs/org-hierarchy.md).

-- CreateEnum (guarded: CREATE TYPE has no IF NOT EXISTS, so wrap it so the migration stays re-runnable)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgUnitType') THEN
    CREATE TYPE "OrgUnitType" AS ENUM ('GROUP', 'COMPANY', 'DEPARTMENT', 'TEAM');
  END IF;
END
$$;

-- AlterTable — add the type discriminator + the self-ref parent pointer. DEFAULT 'COMPANY' backfills
-- existing rows as company roots; parentId is nullable so a root has no parent.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "type" "OrgUnitType" NOT NULL DEFAULT 'COMPANY';
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "parentId" TEXT;

-- CreateIndex — parentId is the descendants() / children lookup key.
CREATE INDEX IF NOT EXISTS "Organization_parentId_idx" ON "Organization"("parentId");

-- AddForeignKey — self-referential, nullable. ON DELETE SET NULL: deleting a parent promotes its
-- children to roots rather than cascading away whole subtrees (cycle-safe; app also guards cycles).
-- IF NOT EXISTS on a constraint isn't supported pre-PG15, so guard via the catalog for re-runnability.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Organization_parentId_fkey'
  ) THEN
    ALTER TABLE "Organization"
      ADD CONSTRAINT "Organization_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "Organization"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
