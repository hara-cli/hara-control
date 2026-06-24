// hara-control admin CLI — manage a control plane from the terminal (replaces curl for the dogfooding phase).
//   HARA_CONTROL_URL=http://localhost:4100 HARA_CONTROL_ADMIN_KEY=… npx tsx cli/admin.ts <cmd> …
// The admin key is also read from ./.env if the env var is unset. The enroll hint's gateway URL is
// HARA_GATEWAY_URL (the device-facing URL) or falls back to HARA_CONTROL_URL.
import { readFileSync, existsSync } from "node:fs";

const BASE = (process.env.HARA_CONTROL_URL || "http://localhost:4100").replace(/\/$/, "");

function adminKey(): string {
  if (process.env.HARA_CONTROL_ADMIN_KEY) return process.env.HARA_CONTROL_ADMIN_KEY;
  if (existsSync(".env")) {
    const m = /^HARA_CONTROL_ADMIN_KEY=(.+)$/m.exec(readFileSync(".env", "utf8"));
    if (m) return m[1].trim();
  }
  return "";
}

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-admin-key": adminKey(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Format the device fleet as a compact table. */
export function fmtFleet(rows: any[]): string {
  if (!rows?.length) return "(no devices)";
  return rows
    .map((d) => {
      const dot = d.online ? "●" : "○";
      const revoked = d.token_active ? "" : " [revoked]";
      return `${dot} ${String(d.name || d.device_id).padEnd(22)} ${String(d.os || "").padEnd(7)} ${String(d.model || "-").padEnd(14)} $${Number(d.spend ?? 0).toFixed(2)}  ${d.device_id}${revoked}`;
    })
    .join("\n");
}

/** The copy-paste `hara enroll` command for a freshly minted code. */
export function enrollHint(gatewayUrl: string, code: string): string {
  return `hara enroll ${gatewayUrl.replace(/\/$/, "")} --code ${code}`;
}

const USAGE = `hara-control admin
  org create <name>                                       create an org (prints its id)
  fleet <orgId>                                           list devices (online · model · spend)
  enroll <orgId> [--model m] [--person id] [--ttl min]    mint an enroll code + print the hara command
  revoke <deviceId>                                       revoke a device's token
  bundle <deviceId>                                       show the device's resolved role bundle
env: HARA_CONTROL_URL (default http://localhost:4100) · HARA_CONTROL_ADMIN_KEY (or ./.env) · HARA_GATEWAY_URL`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd && cmd !== "help" && !adminKey()) {
    console.error("✗ no admin key — set HARA_CONTROL_ADMIN_KEY (or run where ./.env has it)");
    process.exit(1);
  }
  switch (cmd) {
    case "org":
      if (rest[0] === "create" && rest[1]) {
        const org = await req("POST", "/admin/orgs", { name: rest[1] });
        console.log(`✓ org ${org.id}  (${org.name})`);
      } else console.log("usage: org create <name>");
      break;
    case "fleet": {
      if (!rest[0]) return void console.error("usage: fleet <orgId>");
      console.log(fmtFleet(await req("GET", `/admin/fleet?orgId=${encodeURIComponent(rest[0])}`)));
      break;
    }
    case "enroll": {
      if (!rest[0]) return void console.error("usage: enroll <orgId> [--model m] [--person id] [--ttl min]");
      const body: any = { orgId: rest[0] };
      const model = flag(rest, "model");
      if (model) body.model = model;
      const person = flag(rest, "person");
      if (person) body.personId = person;
      const ttl = flag(rest, "ttl");
      if (ttl) body.ttlMinutes = Number(ttl);
      const { code, expiresAt } = await req("POST", "/admin/enroll-codes", body);
      console.log(`✓ code ${code}  (expires ${expiresAt})`);
      console.log(`  ${enrollHint(process.env.HARA_GATEWAY_URL || BASE, code)}`);
      break;
    }
    case "revoke":
      if (!rest[0]) return void console.error("usage: revoke <deviceId>");
      console.log(`✓ revoked ${(await req("POST", `/admin/devices/${encodeURIComponent(rest[0])}/revoke`)).revoked ?? 0} token(s) for ${rest[0]}`);
      break;
    case "bundle":
      if (!rest[0]) return void console.error("usage: bundle <deviceId>");
      console.log(JSON.stringify(await req("GET", `/admin/devices/${encodeURIComponent(rest[0])}/bundle`), null, 2));
      break;
    default:
      console.log(USAGE);
  }
}

// Run only when invoked directly (not when imported by a test) — filename check is CJS/ESM-agnostic.
if (process.argv[1] && /(^|[/\\])admin\.(ts|js|cjs)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
