// Ops fallback for the very first-run case: create a SUPERADMIN directly via Prisma.
//   npx tsx cli/create-superadmin.ts --email me@example.com --password '<a long one>'
// Equivalent to POST /auth/bootstrap-superadmin but doesn't need the HTTP listener running.
// Reads DATABASE_URL from process.env (typically the project's ./.env, sourced before running).
import { readFileSync, existsSync } from "node:fs";
import { PrismaClient, AdminRole } from "@prisma/client";
import { hashPassword } from "../src/common/crypto";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Minimal ./.env loader (KEY=VALUE per line, # comments). Lets ops drop a DATABASE_URL line. */
function loadDotEnv(): void {
  if (process.env.DATABASE_URL || !existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main(argv: string[]): Promise<void> {
  loadDotEnv();
  const email = flag(argv, "email");
  const password = flag(argv, "password");
  if (!email || !password) {
    console.error("usage: tsx cli/create-superadmin.ts --email <e> --password <p>");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("✗ password must be ≥12 chars");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("✗ DATABASE_URL not set (export it or put it in ./.env)");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const count = await prisma.adminUser.count();
    if (count > 0) {
      console.error("✗ AdminUser table already has rows — use /admin/users to add more, not this CLI");
      process.exit(1);
    }
    const user = await prisma.adminUser.create({
      data: { email: email.toLowerCase(), passwordHash: hashPassword(password), role: AdminRole.SUPERADMIN },
    });
    console.log(`✓ SUPERADMIN ${user.email}  (id ${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
