#!/usr/bin/env bash
# Proves the RLS policies isolate rows by org. Runs entirely inside a transaction that is ROLLBACKed —
# side-effect-free. Requires the rls_policies migration applied.
#
# IMPORTANT: the app's `hara` role is a Postgres SUPERUSER, and superusers bypass RLS unconditionally
# (even FORCE). So real saas enforcement requires hara-control to connect as a NON-superuser, non-owner
# role + set app.current_org per request (Phase-2b hardening). This proof demonstrates the policy is
# correct by running the SELECTs under exactly such a role.  Run from repo root: bash scripts/rls-proof.sh
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/hc-rls-proof.txt
docker compose exec -T postgres psql -U hara -d hara_control -v ON_ERROR_STOP=1 -At >"$OUT" 2>&1 <<'SQL'
BEGIN;
-- seed as the superuser (bypasses RLS)
INSERT INTO "Organization"(id,name,policy,"createdAt") VALUES
 ('11111111-1111-1111-1111-111111111111','rls-A','{}',now()),
 ('22222222-2222-2222-2222-222222222222','rls-B','{}',now());
INSERT INTO "Device"(id,"orgId",name,os,"haraVersion","enrolledAt","lastSeenAt","roleVersion") VALUES
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','rlsdev-A','','',now(),now(),0),
 ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222','rlsdev-B','','',now(),now(),0);
-- a non-superuser, non-owner role IS subject to RLS once it's ENABLED (no FORCE needed for non-owners)
CREATE ROLE rls_test NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO rls_test;
GRANT SELECT ON "Device" TO rls_test;
SET LOCAL ROLE rls_test;
SELECT set_config('app.current_org','11111111-1111-1111-1111-111111111111',true);
SELECT 'A='||COALESCE(string_agg(name,','),'<none>') FROM "Device" WHERE name LIKE 'rlsdev-%';
SELECT set_config('app.current_org','22222222-2222-2222-2222-222222222222',true);
SELECT 'B='||COALESCE(string_agg(name,','),'<none>') FROM "Device" WHERE name LIKE 'rlsdev-%';
SELECT set_config('app.current_org','',true);
SELECT 'NONE='||COALESCE(string_agg(name,','),'<none>') FROM "Device" WHERE name LIKE 'rlsdev-%';
RESET ROLE;
ROLLBACK;
SQL
cat "$OUT"
if grep -qx 'A=rlsdev-A' "$OUT" && grep -qx 'B=rlsdev-B' "$OUT" && grep -qx 'NONE=<none>' "$OUT"; then
  echo "RLS PROOF PASS: org context isolates rows under a non-superuser role; no context = no rows"
else
  echo "RLS PROOF FAIL"; exit 1
fi
