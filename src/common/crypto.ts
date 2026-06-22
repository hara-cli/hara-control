import { createHash, randomBytes } from "node:crypto";

/** Hex sha256 — device tokens are stored hashed (only the hash is at rest). */
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Opaque random id with a readable prefix, e.g. randomId("hara-"). */
export const randomId = (prefix: string, bytes = 18): string => `${prefix}${randomBytes(bytes).toString("base64url")}`;
