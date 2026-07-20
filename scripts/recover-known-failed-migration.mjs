#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const KNOWN_MIGRATION = "20260720000000_add_system_audit_log";
export const FAILED_RELEASE_CHECKSUM =
  "5acd6e84d3558ed0287c434b5cd8e120ec467189a4482b74c5926dcd4fe5d16f";

function refuse(reason) {
  throw new Error(`automatic migration recovery refused: ${reason}`);
}

/**
 * This deliberately recognizes one released migration defect only. Any partial application,
 * different checksum, different database error, or unexpected index definition must stop for
 * operator review instead of being waved through.
 */
export function decideKnownMigrationRecovery(state) {
  const failed = state?.failedMigrations;
  if (!Array.isArray(failed)) refuse("invalid inspection result");
  if (failed.length === 0) return "none";
  if (failed.length !== 1) refuse("unexpected number of active failed migrations");

  const row = failed[0];
  if (row.migration_name !== KNOWN_MIGRATION) refuse("failure is not the known migration");
  if (row.checksum !== FAILED_RELEASE_CHECKSUM) refuse("failure checksum does not match the released defect");
  if (!row.started_at || row.finished_at || row.rolled_back_at) {
    refuse("migration state is not an active failed attempt");
  }

  const logs = typeof row.logs === "string" ? row.logs.toLowerCase() : "";
  if (
    !logs.includes("42p07") ||
    !logs.includes("secret_global_name_key") ||
    !logs.includes("already exists")
  ) {
    refuse("failure signature does not match the duplicate-index defect");
  }

  const objects = state.newObjects;
  if (
    !objects ||
    objects.system_audit_log ||
    objects.system_audit_at_idx ||
    objects.system_audit_action_idx ||
    objects.provider_activation ||
    objects.provider_activation_idx ||
    objects.audit_unique_idx ||
    objects.secret_version_column
  ) {
    refuse("the failed transaction may have partially applied");
  }
  if (state.globalSecretIndexMatches !== true) {
    refuse("the pre-existing global secret index is absent or has unexpected semantics");
  }
  return "recover";
}

async function inspect(prisma) {
  const [failedMigrations, relations, versionColumn, globalIndex] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT migration_name, checksum, logs, started_at, finished_at, rolled_back_at
       FROM "_prisma_migrations"
       WHERE migration_name = '${KNOWN_MIGRATION}'
         AND finished_at IS NULL
         AND rolled_back_at IS NULL
       ORDER BY started_at DESC`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT
         to_regclass(format('%I.%I', current_schema(), 'SystemAuditLog')) IS NOT NULL
           AS system_audit_log,
         to_regclass(format('%I.%I', current_schema(), 'SystemAuditLog_at_idx')) IS NOT NULL
           AS system_audit_at_idx,
         to_regclass(format('%I.%I', current_schema(), 'SystemAuditLog_action_at_idx')) IS NOT NULL
           AS system_audit_action_idx,
         to_regclass(format('%I.%I', current_schema(), 'ProviderActivation')) IS NOT NULL
           AS provider_activation,
         to_regclass(format('%I.%I', current_schema(), 'ProviderActivation_activatedAt_idx')) IS NOT NULL
           AS provider_activation_idx,
         to_regclass(format('%I.%I', current_schema(), 'AuditLog_orgId_seq_key')) IS NOT NULL
           AS audit_unique_idx`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'Secret'
         AND column_name = 'version'
         AND data_type = 'integer'`,
    ),
    prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS count,
         COALESCE(BOOL_AND(i.indisunique), FALSE) AS unique_index,
         COALESCE(BOOL_AND(i.indnkeyatts = 1), FALSE) AS one_key,
         COALESCE(BOOL_AND(a.attname = 'name'), FALSE) AS name_key,
         COALESCE(
           BOOL_AND(
             REGEXP_REPLACE(
               LOWER(COALESCE(pg_get_expr(i.indpred, i.indrelid), '')),
               '[[:space:]()]',
               '',
               'g'
             ) = '"orgid"isnull'
           ),
           FALSE
         ) AS null_org_predicate
       FROM pg_class idx
       INNER JOIN pg_namespace idx_ns ON idx_ns.oid = idx.relnamespace
       INNER JOIN pg_index i ON i.indexrelid = idx.oid
       INNER JOIN pg_class tbl ON tbl.oid = i.indrelid
       INNER JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
       LEFT JOIN pg_attribute a
         ON a.attrelid = tbl.oid
        AND a.attnum = (i.indkey::smallint[])[0]
       WHERE idx_ns.nspname = current_schema()
         AND tbl_ns.nspname = current_schema()
         AND idx.relname = 'Secret_global_name_key'
         AND tbl.relname = 'Secret'`,
    ),
  ]);

  const relationState = relations[0] ?? {};
  const indexState = globalIndex[0] ?? {};
  return {
    failedMigrations,
    newObjects: {
      ...relationState,
      secret_version_column: versionColumn[0]?.count === 1,
    },
    globalSecretIndexMatches:
      indexState.count === 1 &&
      indexState.unique_index === true &&
      indexState.one_key === true &&
      indexState.name_key === true &&
      indexState.null_org_predicate === true,
  };
}

async function main() {
  const prismaModule = await import("@prisma/client");
  const PrismaClient = prismaModule.PrismaClient ?? prismaModule.default?.PrismaClient;
  if (!PrismaClient) refuse("Prisma client is unavailable");

  const prisma = new PrismaClient();
  let decision;
  try {
    await prisma.$connect();
    decision = decideKnownMigrationRecovery(await inspect(prisma));
  } finally {
    await prisma.$disconnect();
  }

  if (decision === "none") {
    process.stdout.write("no known failed migration recovery needed\n");
    return;
  }

  const prismaCli = resolve("node_modules/prisma/build/index.js");
  const result = spawnSync(
    process.execPath,
    [prismaCli, "migrate", "resolve", "--rolled-back", KNOWN_MIGRATION],
    { env: process.env, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) refuse("Prisma could not mark the known attempt rolled back");
  process.stdout.write("known failed migration marked rolled back; corrected migration may now run\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "automatic migration recovery failed"}\n`);
    process.exitCode = 1;
  });
}
