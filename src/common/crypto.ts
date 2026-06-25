import { createHash, randomBytes } from "node:crypto";

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
