// LocalKeyfileKms — envelope encryption with the root key (CEK) held locally, for self-hosters with
// no cloud KMS. "Envelope, but the root key is still on this box." Uses node:crypto only (ZERO deps).
//
// Per encrypt():
//   1. generate a random 32-byte DEK (per-secret data key).
//   2. AES-256-GCM encrypt the plaintext under the DEK with a fresh random 12-byte IV; bind ctx.orgId
//      as the GCM AAD so the ciphertext is pinned to one tenant (decrypt under another orgId fails).
//      ciphertext layout = iv(12) || authTag(16) || enc.
//   3. AES-256-GCM "wrap" the DEK under the master CEK with its OWN fresh random 12-byte IV.
//      wrappedDek layout = iv(12) || authTag(16) || encDek.
//   4. persist {ciphertext, wrappedDek, keyRef} — never the plaintext, never the bare DEK.
//
// Master key (CEK) source, in order:
//   • HARA_KMS_MASTER_KEY — 32 bytes as base64 / base64url / hex.
//   • HARA_KMS_KEYFILE    — path to a file whose contents decode (same encodings) to 32 bytes.
// Missing/short → KmsConfigError with a clear message (never silently weak crypto, never logs the key).

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KmsAdapter, KmsContext, Envelope, KmsConfigError } from "./kms-adapter";

const ALG = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // GCM auth tag
const DEK_BYTES = 32; // per-secret data key (also AES-256)

/** AAD bound into the secret's GCM so a ciphertext is pinned to its tenant. Empty orgId = global. */
function aadFor(ctx: KmsContext): Buffer {
  return Buffer.from(`org:${ctx.orgId ?? ""}`, "utf8");
}

/** Decode a 32-byte key from base64 / base64url / hex. Returns null if it isn't exactly 32 bytes. */
function decodeKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (!s) return null;
  // hex (64 hex chars, nothing else)
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  // base64 / base64url — try both, Buffer tolerates url-safe under "base64url"
  for (const enc of ["base64", "base64url"] as const) {
    const b = Buffer.from(s, enc);
    if (b.length === KEY_BYTES) return b;
  }
  return null;
}

/**
 * GCM seal: out = iv(12) || tag(16) || ciphertext. Random IV per call (NEVER reused — generated fresh
 * here every time). aad authenticates the tenant binding without being stored.
 */
function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** GCM open: parse iv||tag||ciphertext and verify the tag (+aad). Throws on tamper / wrong tenant. */
function open(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short / corrupt");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  // .final() throws if the GCM tag doesn't verify (tamper, wrong key, or wrong AAD/tenant)
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export class LocalKeyfileKms implements KmsAdapter {
  private readonly cek: Buffer;
  /** stable id of the master key used to wrap DEKs; lets rotation distinguish CEKs. Never the key. */
  private readonly keyRef: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const cek = LocalKeyfileKms.loadMasterKey(env);
    this.cek = cek;
    // keyRef = short, non-reversible fingerprint of the CEK (sha256 prefix). Identifies WHICH key
    // wrapped a DEK without revealing it; rotation produces a new fingerprint → new keyRef.
    this.keyRef = `local:${createHash("sha256").update(cek).digest("hex").slice(0, 16)}`;
  }

  /** Resolve the 32-byte master CEK from env/keyfile, or throw a clear KmsConfigError. */
  static loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
    const inline = env.HARA_KMS_MASTER_KEY;
    if (inline && inline.trim()) {
      const k = decodeKey(inline);
      if (!k) {
        throw new KmsConfigError(
          "HARA_KMS_MASTER_KEY must decode to exactly 32 bytes (base64, base64url, or 64-char hex)",
        );
      }
      return k;
    }
    const file = env.HARA_KMS_KEYFILE;
    if (file && file.trim()) {
      let contents: string;
      try {
        contents = readFileSync(file.trim(), "utf8");
      } catch (e) {
        throw new KmsConfigError(`HARA_KMS_KEYFILE not readable (${file.trim()}): ${(e as Error).message}`);
      }
      const k = decodeKey(contents);
      if (!k) {
        throw new KmsConfigError(
          `HARA_KMS_KEYFILE (${file.trim()}) must contain exactly 32 bytes encoded as base64, base64url, or 64-char hex`,
        );
      }
      return k;
    }
    throw new KmsConfigError(
      "no KMS master key configured — set HARA_KMS_MASTER_KEY (32 bytes base64/hex) or HARA_KMS_KEYFILE (path) for the local KMS provider",
    );
  }

  async encrypt(plaintext: Buffer, ctx: KmsContext): Promise<Envelope> {
    const dek = randomBytes(DEK_BYTES); // fresh per-secret data key
    // tenant binding goes on the SECRET ciphertext (the cross-tenant replay defense). The DEK wrap is
    // an internal key-encryption op (its own random IV); we don't AAD-bind the wrap to keep rotation
    // tenant-agnostic — the tenant check already lives on the ciphertext that the wrapped DEK unlocks.
    const ciphertext = seal(dek, plaintext, aadFor(ctx));
    const wrappedDek = seal(this.cek, dek, Buffer.alloc(0));
    dek.fill(0); // best-effort scrub the plaintext DEK from this buffer
    return { ciphertext, wrappedDek, keyRef: this.keyRef };
  }

  async decrypt(ciphertext: Buffer, wrappedDek: Buffer, keyRef: string, ctx: KmsContext): Promise<Buffer> {
    if (keyRef !== this.keyRef) {
      // keyRef mismatch = the DEK was wrapped under a different CEK (e.g. pre-rotation). The operator
      // must keep/import the prior CEK to read it. Fail clearly rather than throw a confusing GCM error.
      throw new KmsConfigError(
        `secret was wrapped under key "${keyRef}" but the active local CEK is "${this.keyRef}" — configure the matching master key`,
      );
    }
    const dek = open(this.cek, wrappedDek, Buffer.alloc(0)); // unwrap the DEK
    try {
      return open(dek, ciphertext, aadFor(ctx)); // GCM tag verifies tamper + tenant (AAD)
    } finally {
      dek.fill(0); // scrub the unwrapped DEK
    }
  }
}
