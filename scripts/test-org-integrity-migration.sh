#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migration_sql="$repo_dir/prisma/migrations/20260823190000_enforce_agent_org_integrity/migration.sql"
postgres_bin="${HARA_TEST_POSTGRES_BIN:-}"
if test -z "$postgres_bin"; then
  for candidate_dir in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql/bin /usr/local/opt/postgresql@17/bin /usr/local/opt/postgresql/bin; do
    if test -x "$candidate_dir/postgres" && "$candidate_dir/postgres" --version >/dev/null 2>&1; then
      postgres_bin="$candidate_dir"
      break
    fi
  done
fi
if test -z "$postgres_bin"; then
  echo "a working PostgreSQL server toolchain is required (or set HARA_TEST_POSTGRES_BIN)" >&2
  exit 1
fi
export PATH="$postgres_bin:$PATH"
test_root="$(mktemp -d /private/tmp/hara-control-migration.XXXXXX)"
data_dir="$test_root/data"
socket_dir="$test_root/socket"
port_number=55439
mkdir -p "$socket_dir"

cleanup() {
  if test -s "$data_dir/postmaster.pid"; then
    pg_ctl -D "$data_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  case "$test_root" in
    /private/tmp/hara-control-migration.*) rm -rf -- "$test_root" ;;
    *) echo "refusing to remove unexpected test directory: $test_root" >&2 ;;
  esac
}
trap cleanup EXIT

initdb -D "$data_dir" -A trust -U postgres >/dev/null
pg_ctl -D "$data_dir" -o "-h '' -k $socket_dir -p $port_number" -w start >/dev/null

psql_cmd=(psql -X -v ON_ERROR_STOP=1 -h "$socket_dir" -p "$port_number" -U postgres)
createdb -h "$socket_dir" -p "$port_number" -U postgres migration_clean
createdb -h "$socket_dir" -p "$port_number" -U postgres migration_dirty

create_legacy_schema() {
  local database_name="$1"
  "${psql_cmd[@]}" -d "$database_name" >/dev/null <<'SQL'
CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);
CREATE TABLE "Person" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE
);
CREATE TABLE "Team" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE
);
CREATE TABLE "Role" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE
);
CREATE TABLE "EnrollCode" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "personId" TEXT,
  CONSTRAINT "EnrollCode_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT
);
CREATE TABLE "Device" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "personId" TEXT,
  CONSTRAINT "Device_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT
);
CREATE TABLE "PersonTeam" (
  "personId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  PRIMARY KEY ("personId", "teamId"),
  CONSTRAINT "PersonTeam_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE,
  CONSTRAINT "PersonTeam_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE
);
CREATE TABLE "DigitalEmployee" (
  "id" TEXT PRIMARY KEY,
  "orgId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE,
  "roleId" TEXT NOT NULL,
  "personId" TEXT,
  "teamId" TEXT,
  CONSTRAINT "DigitalEmployee_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE,
  CONSTRAINT "DigitalEmployee_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE,
  CONSTRAINT "DigitalEmployee_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE
);
INSERT INTO "Organization" ("id") VALUES ('org-a'), ('org-b');
INSERT INTO "Person" ("id", "orgId") VALUES ('person-a', 'org-a'), ('person-b', 'org-b');
INSERT INTO "Team" ("id", "orgId") VALUES ('team-a', 'org-a'), ('team-b', 'org-b');
INSERT INTO "Role" ("id", "orgId") VALUES ('role-a', 'org-a'), ('role-b', 'org-b');
SQL
}

create_legacy_schema migration_clean
"${psql_cmd[@]}" -d migration_clean >/dev/null <<'SQL'
INSERT INTO "EnrollCode" ("id", "orgId", "personId") VALUES ('enroll-ok', 'org-a', 'person-a');
INSERT INTO "Device" ("id", "orgId", "personId") VALUES ('device-ok', 'org-a', 'person-a');
INSERT INTO "PersonTeam" ("personId", "teamId") VALUES ('person-a', 'team-a');
INSERT INTO "DigitalEmployee" ("id", "orgId", "roleId", "personId", "teamId")
VALUES ('agent-ok', 'org-a', 'role-a', 'person-a', 'team-a');
SQL
"${psql_cmd[@]}" -d migration_clean -f "$migration_sql" >/dev/null

constraint_count="$("${psql_cmd[@]}" -At -d migration_clean -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('EnrollCode_personId_orgId_fkey','Device_personId_orgId_fkey','PersonTeam_personId_orgId_fkey','PersonTeam_teamId_orgId_fkey','DigitalEmployee_roleId_orgId_fkey','DigitalEmployee_personId_orgId_fkey','DigitalEmployee_teamId_orgId_fkey')")"
test "$constraint_count" = "7"

if "${psql_cmd[@]}" -d migration_clean -c "INSERT INTO \"EnrollCode\" (\"id\", \"orgId\", \"personId\") VALUES ('enroll-bad', 'org-a', 'person-b')" >/dev/null 2>&1; then
  echo "cross-organization EnrollCode write unexpectedly succeeded" >&2
  exit 1
fi
if "${psql_cmd[@]}" -d migration_clean -c "INSERT INTO \"Device\" (\"id\", \"orgId\", \"personId\") VALUES ('device-bad', 'org-a', 'person-b')" >/dev/null 2>&1; then
  echo "cross-organization Device write unexpectedly succeeded" >&2
  exit 1
fi
if "${psql_cmd[@]}" -d migration_clean -c "INSERT INTO \"PersonTeam\" (\"orgId\", \"personId\", \"teamId\") VALUES ('org-a', 'person-a', 'team-b')" >/dev/null 2>&1; then
  echo "cross-organization PersonTeam write unexpectedly succeeded" >&2
  exit 1
fi
if "${psql_cmd[@]}" -d migration_clean -c "INSERT INTO \"DigitalEmployee\" (\"id\", \"orgId\", \"roleId\") VALUES ('agent-bad', 'org-a', 'role-b')" >/dev/null 2>&1; then
  echo "cross-organization DigitalEmployee write unexpectedly succeeded" >&2
  exit 1
fi

create_legacy_schema migration_dirty
"${psql_cmd[@]}" -d migration_dirty -c "INSERT INTO \"EnrollCode\" (\"id\", \"orgId\", \"personId\") VALUES ('dirty', 'org-a', 'person-b')" >/dev/null
if "${psql_cmd[@]}" -d migration_dirty -f "$migration_sql" >/dev/null 2>&1; then
  echo "dirty cross-organization migration unexpectedly succeeded" >&2
  exit 1
fi

org_column_count="$("${psql_cmd[@]}" -At -d migration_dirty -c "SELECT count(*) FROM information_schema.columns WHERE table_name = 'PersonTeam' AND column_name = 'orgId'")"
old_fk_count="$("${psql_cmd[@]}" -At -d migration_dirty -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('EnrollCode_personId_fkey','Device_personId_fkey','PersonTeam_personId_fkey','PersonTeam_teamId_fkey','DigitalEmployee_roleId_fkey','DigitalEmployee_personId_fkey','DigitalEmployee_teamId_fkey')")"
new_fk_count="$("${psql_cmd[@]}" -At -d migration_dirty -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('EnrollCode_personId_orgId_fkey','Device_personId_orgId_fkey','PersonTeam_personId_orgId_fkey','PersonTeam_teamId_orgId_fkey','DigitalEmployee_roleId_orgId_fkey','DigitalEmployee_personId_orgId_fkey','DigitalEmployee_teamId_orgId_fkey')")"
test "$org_column_count" = "0"
test "$old_fk_count" = "7"
test "$new_fk_count" = "0"

echo "organization integrity migration: clean apply, FK rejection, and dirty rollback passed"
