-- Company Agent governance depends on every Person, Team, Role, enrollment and assignment sharing
-- one organization boundary. Refuse to paper over historical cross-organization rows: an operator
-- must investigate and repair them before this migration can proceed.
-- Prisma intentionally does not wrap PostgreSQL migrations in a transaction. This migration removes
-- old foreign keys before installing their tenant-safe replacements, so partial DDL would be unsafe.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "EnrollCode" ec
    JOIN "Person" p ON p."id" = ec."personId"
    WHERE ec."personId" IS NOT NULL AND p."orgId" <> ec."orgId"
  ) THEN
    RAISE EXCEPTION 'cross-organization EnrollCode/Person rows must be repaired before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Device" d
    JOIN "Person" p ON p."id" = d."personId"
    WHERE d."personId" IS NOT NULL AND p."orgId" <> d."orgId"
  ) THEN
    RAISE EXCEPTION 'cross-organization Device/Person rows must be repaired before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "PersonTeam" pt
    JOIN "Person" p ON p."id" = pt."personId"
    JOIN "Team" t ON t."id" = pt."teamId"
    WHERE p."orgId" <> t."orgId"
  ) THEN
    RAISE EXCEPTION 'cross-organization PersonTeam rows must be repaired before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "DigitalEmployee" de
    JOIN "Role" r ON r."id" = de."roleId"
    LEFT JOIN "Person" p ON p."id" = de."personId"
    LEFT JOIN "Team" t ON t."id" = de."teamId"
    WHERE r."orgId" <> de."orgId"
       OR (de."personId" IS NOT NULL AND p."orgId" <> de."orgId")
       OR (de."teamId" IS NOT NULL AND t."orgId" <> de."orgId")
  ) THEN
    RAISE EXCEPTION 'cross-organization DigitalEmployee relations must be repaired before migration';
  END IF;
END $$;

ALTER TABLE "Role" ADD CONSTRAINT "Role_id_orgId_key" UNIQUE ("id", "orgId");
ALTER TABLE "Team" ADD CONSTRAINT "Team_id_orgId_key" UNIQUE ("id", "orgId");
ALTER TABLE "Person" ADD CONSTRAINT "Person_id_orgId_key" UNIQUE ("id", "orgId");

ALTER TABLE "PersonTeam" ADD COLUMN "orgId" TEXT;
UPDATE "PersonTeam" pt
SET "orgId" = p."orgId"
FROM "Person" p
WHERE p."id" = pt."personId";
ALTER TABLE "PersonTeam" ALTER COLUMN "orgId" SET NOT NULL;

ALTER TABLE "EnrollCode" DROP CONSTRAINT "EnrollCode_personId_fkey";
ALTER TABLE "Device" DROP CONSTRAINT "Device_personId_fkey";
ALTER TABLE "PersonTeam" DROP CONSTRAINT "PersonTeam_personId_fkey";
ALTER TABLE "PersonTeam" DROP CONSTRAINT "PersonTeam_teamId_fkey";
ALTER TABLE "DigitalEmployee" DROP CONSTRAINT "DigitalEmployee_roleId_fkey";
ALTER TABLE "DigitalEmployee" DROP CONSTRAINT "DigitalEmployee_personId_fkey";
ALTER TABLE "DigitalEmployee" DROP CONSTRAINT "DigitalEmployee_teamId_fkey";

ALTER TABLE "EnrollCode" ADD CONSTRAINT "EnrollCode_personId_orgId_fkey"
  FOREIGN KEY ("personId", "orgId") REFERENCES "Person"("id", "orgId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_personId_orgId_fkey"
  FOREIGN KEY ("personId", "orgId") REFERENCES "Person"("id", "orgId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PersonTeam" ADD CONSTRAINT "PersonTeam_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonTeam" ADD CONSTRAINT "PersonTeam_personId_orgId_fkey"
  FOREIGN KEY ("personId", "orgId") REFERENCES "Person"("id", "orgId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonTeam" ADD CONSTRAINT "PersonTeam_teamId_orgId_fkey"
  FOREIGN KEY ("teamId", "orgId") REFERENCES "Team"("id", "orgId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_roleId_orgId_fkey"
  FOREIGN KEY ("roleId", "orgId") REFERENCES "Role"("id", "orgId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_personId_orgId_fkey"
  FOREIGN KEY ("personId", "orgId") REFERENCES "Person"("id", "orgId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DigitalEmployee" ADD CONSTRAINT "DigitalEmployee_teamId_orgId_fkey"
  FOREIGN KEY ("teamId", "orgId") REFERENCES "Team"("id", "orgId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PersonTeam_orgId_idx" ON "PersonTeam"("orgId");
ALTER TABLE "PersonTeam" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "PersonTeam";
CREATE POLICY org_isolation ON "PersonTeam"
  USING ("orgId" = current_setting('app.current_org', true))
  WITH CHECK ("orgId" = current_setting('app.current_org', true));

COMMIT;
