// SSRF allow-list + private-address guard for any OUTBOUND fetch hara-control makes to an
// upstream the operator (or, worse, a user-supplied value) configured. Defense goals:
//   • block link-local 169.254.0.0/16 — incl. the cloud metadata endpoint 169.254.169.254
//   • block RFC1918 private space (10/8, 172.16/12, 192.168/16) and loopback
//   • block IPv6 loopback / ULA / link-local + IPv4-mapped IPv6 forms of the above
//   • allow ONLY hosts on an explicit upstream allow-list (config/env)
//   • re-check on every redirect hop so a permitted host can't 30x us into private space
//
// Self-host posture: the allow-list is opt-in. If unset, we *fail open by default* for the
// configured upstream host (LiteLLM at localhost is the normal single-box deployment) but ALWAYS
// block the metadata/link-local range and, when the allow-list IS set, deny anything outside it.
// Operators harden by setting HARA_SSRF_ALLOW_HOSTS (and optionally HARA_SSRF_BLOCK_PRIVATE=1 to
// also refuse RFC1918/loopback when nothing is configured).

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`SSRF guard blocked request: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

/** Parsed env policy. Read lazily so tests/process-env overrides take effect. */
export interface SsrfPolicy {
  /** explicit host allow-list (hostnames, lowercased, no port). empty = allow-list disabled */
  allowHosts: Set<string>;
  /** when no allow-list is set, also refuse RFC1918/loopback (link-local is ALWAYS refused) */
  blockPrivateWhenOpen: boolean;
  /** max redirect hops to follow while re-validating each Location */
  maxRedirects: number;
}

export function loadSsrfPolicy(env: NodeJS.ProcessEnv = process.env): SsrfPolicy {
  const allowHosts = new Set(
    (env.HARA_SSRF_ALLOW_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    allowHosts,
    blockPrivateWhenOpen: env.HARA_SSRF_BLOCK_PRIVATE === "1",
    maxRedirects: Number(env.HARA_SSRF_MAX_REDIRECTS) || 5,
  };
}

/** True if an IPv4 string is loopback / link-local / RFC1918 private / unspecified / CGNAT. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** IPv6 link-local is fe80::/10, i.e. first hextet fe80 through febf. */
function isIPv6LinkLocal(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const first = Number.parseInt(v.split(":", 1)[0], 16);
  return Number.isFinite(first) && (first & 0xffc0) === 0xfe80;
}

/** True if an IPv6 string is loopback / link-local / ULA / unspecified, incl. IPv4-mapped private. */
export function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::") return true; // loopback / unspecified
  if (isIPv6LinkLocal(v)) return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // ULA fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible — unwrap and re-check
  const mapped = v.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Always-blocked regardless of allow-list — the SSRF crown jewels: link-local 169.254.0.0/16 (incl.
 * the 169.254.169.254 cloud metadata endpoint), the unspecified address, and IPv6 link-local. NOTE:
 * loopback (127/8, ::1) is deliberately NOT here so the normal single-box deployment (LiteLLM on
 * localhost:4000) keeps working by default; loopback is classified as "private" and is blockable via
 * HARA_SSRF_BLOCK_PRIVATE for hardened setups, but an allow-list entry can still permit it on purpose.
 */
export function isAlwaysBlockedIP(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (a === 169 && b === 254) || a === 0; // link-local/metadata + 0.0.0.0/8
  }
  if (fam === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (v === "::" || isIPv6LinkLocal(v)) return true; // unspecified + link-local
    const mapped = v.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      const [a, b] = mapped[1].split(".").map(Number);
      return (a === 169 && b === 254) || a === 0;
    }
  }
  return false;
}

function isPrivateIP(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Validate a single URL against the policy. Resolves the host to IPs (DNS) and rejects if ANY
 * resolved address is in the always-blocked set, or — per policy — private space, or off the
 * allow-list. Throws SsrfBlockedError; returns nothing on success.
 */
export async function assertUrlAllowed(rawUrl: string, policy: SsrfPolicy = loadSsrfPolicy()): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`unparseable url: ${rawUrl.slice(0, 80)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`scheme not allowed: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();

  // allow-list (when configured) is authoritative on the *hostname*
  if (policy.allowHosts.size > 0 && !policy.allowHosts.has(host)) {
    throw new SsrfBlockedError(`host "${host}" not on HARA_SSRF_ALLOW_HOSTS`);
  }

  // collect the addresses we must check: literal IP host, or every DNS answer
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      const records = await lookup(host, { all: true });
      addrs = records.map((r) => r.address);
    } catch (e) {
      throw new SsrfBlockedError(`dns lookup failed for "${host}": ${(e as Error).message}`);
    }
    if (addrs.length === 0) throw new SsrfBlockedError(`no addresses for "${host}"`);
  }

  for (const ip of addrs) {
    if (isAlwaysBlockedIP(ip)) {
      throw new SsrfBlockedError(`resolves to blocked address ${ip} (loopback/link-local/metadata)`);
    }
    // when no allow-list is set, private space is only blocked if the operator opts in;
    // an allow-list (host explicitly trusted) lets a private upstream through on purpose.
    if (policy.allowHosts.size === 0 && policy.blockPrivateWhenOpen && isPrivateIP(ip)) {
      throw new SsrfBlockedError(`resolves to private address ${ip} (set HARA_SSRF_ALLOW_HOSTS to permit)`);
    }
  }
}

/**
 * Drop-in replacement for fetch() that validates the URL (and every redirect hop) against the SSRF
 * policy before letting the request leave the box. Uses manual redirect handling so each Location is
 * re-checked — the redirect-into-private-space bypass is closed.
 */
export async function safeFetch(
  input: string,
  init: RequestInit = {},
  policy: SsrfPolicy = loadSsrfPolicy(),
): Promise<Response> {
  let url = input;
  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    await assertUrlAllowed(url, policy);
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location")!;
      url = new URL(loc, url).toString(); // resolve relative redirects, then re-validate next loop
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError(`too many redirects (> ${policy.maxRedirects})`);
}
