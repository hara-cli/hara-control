-- Extend the org_isolation RLS policy (see 20260622040000_rls_policies) to the work-behavior tables.
-- Same model: ENABLE + a policy keyed on app.current_org; NOT FORCEd (owner bypasses → self mode +
-- app-level orgId scoping keep working; this is the saas multi-tenant defense-in-depth net).

ALTER TABLE "WorkSession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "WorkSession";
CREATE POLICY org_isolation ON "WorkSession" USING ("orgId" = current_setting('app.current_org', true));

ALTER TABLE "WorkEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON "WorkEvent";
CREATE POLICY org_isolation ON "WorkEvent" USING ("orgId" = current_setting('app.current_org', true));
