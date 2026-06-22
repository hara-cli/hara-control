-- Multi-tenant Row-Level Security (saas mode). Each org-scoped table gets a policy that only exposes
-- rows whose orgId matches the per-request session var `app.current_org` (set by PrismaService.withOrg
-- inside a transaction). NOT FORCEd: the table-owner role the app connects as bypasses RLS, so self
-- mode (single tenant) and the app's existing explicit orgId-in-WHERE scoping keep working. This is
-- the defense-in-depth tenant wall; full FORCE + a non-owner app role is the Phase-2b hardening.
-- DeviceToken (looked up globally by token hash at heartbeat) and PersonTeam (junction) are intentionally
-- not org-scoped here.
--
-- NOTE: Prisma maps `String @id @default(uuid())` to Postgres `text`, not the native `uuid` type, so
-- the policy compares text to text (no ::uuid cast). current_setting(..., true) is NULL/'' when unset
-- → no rows match (fail-closed). DROP POLICY IF EXISTS keeps this migration safely re-runnable.

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Organization";
CREATE POLICY org_isolation ON "Organization" USING ("id" = current_setting('app.current_org', true));

ALTER TABLE "EnrollCode" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "EnrollCode";
CREATE POLICY org_isolation ON "EnrollCode" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Device";
CREATE POLICY org_isolation ON "Device" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "AuditLog";
CREATE POLICY org_isolation ON "AuditLog" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Role";
CREATE POLICY org_isolation ON "Role" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Team";
CREATE POLICY org_isolation ON "Team" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "Person" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "Person";
CREATE POLICY org_isolation ON "Person" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "DigitalEmployee" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "DigitalEmployee";
CREATE POLICY org_isolation ON "DigitalEmployee" USING ("orgId" = current_setting('app.current_org', true));
