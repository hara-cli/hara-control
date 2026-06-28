import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hex sha256 — device tokens are stored hashed (only the hash is at rest). */
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Opaque random id with a readable prefix, e.g. randomId("hara-"). */
export const randomId = (prefix: string, bytes = 18): string => `${prefix}${randomBytes(bytes).toString("base64url")}`;

/**
 * Stable JSON: object keys sorted recursively so the serialization is canonical (insertion-order
 * independent) at every nesting level. Arrays keep order. Used to hash nested payloads reproducibly.
 */
const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",");
  return `{${body}}`;
};

/**
 * Tamper-evidence chain link: rowHash = sha256(canonical(fields) + prevHash). Pure + deterministic
 * so it's unit-testable and reproducible during verification. Used by the audit log and the
 * work-behavior trail. Canonical form is stable regardless of key insertion order (incl. nested).
 */
export const chainHash = (fields: Record<string, unknown>, prevHash: string): string => sha256(canonicalJson(fields) + prevHash);

// ── Password hashing (scrypt) ──────────────────────────────────────────────────────────────────
// Stored format: "scrypt$<saltB64>$<hashB64>" — algorithm prefix lets us migrate later without
// re-coding the table. 16-byte random salt, 64-byte derived key, default scrypt cost (N=16384).
// Verify uses timingSafeEqual after a length guard (timingSafeEqual throws on length mismatch).

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

export function hashPassword(pw: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(pw, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], "base64");
    expected = Buffer.from(parts[2], "base64");
  } catch {
    return false;
  }
  const actual = scryptSync(pw, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ── JWT (HS256) ────────────────────────────────────────────────────────────────────────────────
// Minimal HS256 implementation via createHmac. base64url-encoded segments. signJwt sets iat+exp;
// verifyJwt checks signature (length-guarded timingSafeEqual) + exp. Date.now() is fine in app
// code — JWT is short-lived (8h) and we re-issue on login.

const b64uEncode = (buf: Buffer | string): string => {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const b64uDecode = (s: string): Buffer => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
};

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  [k: string]: unknown;
}

/** Sign payload with HS256. TTL defaults to 8h. Adds iat + exp; preserves any extra claims. */
export function signJwt(payload: JwtPayload, secret: string, ttlSec = 28800): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const h = b64uEncode(JSON.stringify(header));
  const p = b64uEncode(JSON.stringify(body));
  const signing = `${h}.${p}`;
  const sig = b64uEncode(createHmac("sha256", secret).update(signing).digest());
  return `${signing}.${sig}`;
}

/** Verify signature + exp. Returns the decoded payload, or null if anything is off. */
export function verifyJwt(token: string, secret: string): (JwtPayload & { iat: number; exp: number }) | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  let provided: Buffer;
  try {
    provided = b64uDecode(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let payload: (JwtPayload & { iat: number; exp: number }) | null = null;
  try {
    payload = JSON.parse(b64uDecode(p).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

// ── TOTP (RFC 6238) ────────────────────────────────────────────────────────────────────────────
// SHA1 / 30s step / 6 digits, ±1 step verification window. Stored secret is base32 (RFC4648, no
// padding) so authenticator apps (Google/Authy/1Password/etc.) can ingest it via otpauth URI or
// manual entry. Pure node:crypto — no external lib. The "seam" column AdminUser.totpSecret
// already exists in the Prisma schema (null = 2FA off, set = on).

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 encode (RFC4648, no padding). Used to serialize the TOTP secret for authenticator apps. */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

/** Base32 decode (RFC4648, no padding, case-insensitive, ignores spaces). Throws on bad chars. */
function base32Decode(s: string): Buffer {
  const cleaned = s.replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a fresh TOTP secret — 20 random bytes (RFC 6238 recommended size), base32-encoded. */
export function genTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Build the otpauth:// URI an authenticator app QR-scans (also valid for manual paste). */
export function totpUri(secret: string, accountEmail: string, issuer = "hara-control"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** RFC 6238 HOTP step: HMAC-SHA1(key, counter) → dynamic-truncate → 6-digit string. */
function hotp6(key: Buffer, counter: number): string {
  const ctr = Buffer.alloc(8);
  // counter fits in 53 bits in practice (year ~2255+ at 30s); write high 32 / low 32 separately
  // to avoid BigInt and keep the impl boring.
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter >>> 0;
  ctr.writeUInt32BE(high, 0);
  ctr.writeUInt32BE(low, 4);
  const mac = createHmac("sha1", key).update(ctr).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return (truncated % 1_000_000).toString().padStart(6, "0");
}

/**
 * Verify a 6-digit TOTP code against a base32 secret. Window=1 → accepts the current step ±1
 * (i.e. ±30s) to absorb clock drift between the server and the authenticator. Timing-safe compare.
 * Returns false on any decode/format error rather than throwing — the caller treats it as bad code.
 */
export function verifyTotp(secret: string, code: string, window = 1): boolean {
  if (!secret || typeof code !== "string") return false;
  const trimmed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  const step = Math.floor(Date.now() / 1000 / 30);
  const inputBuf = Buffer.from(trimmed, "utf8");
  for (let w = -window; w <= window; w++) {
    const candidate = hotp6(key, step + w);
    const candBuf = Buffer.from(candidate, "utf8");
    if (candBuf.length === inputBuf.length && timingSafeEqual(candBuf, inputBuf)) return true;
  }
  return false;
}
