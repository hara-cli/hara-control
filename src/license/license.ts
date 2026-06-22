// Offline-verifiable license tokens. The hub holds the Ed25519 private key and signs; a self-deployed
// runtime embeds the public key and verifies WITHOUT calling the hub (air-gap friendly). Compact format:
//   base64url(JSON claims) "." base64url(Ed25519 signature over the claims bytes)
// We avoid a JWT dependency on purpose (hara-control keeps a tiny dep surface).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export type LicenseClaims = {
  hubOrgId: string;
  plan: string;
  seatLimit: number; // 0 = unlimited
  features: string[]; // e.g. ["agent-org", "code-assets"]
  notBefore: number; // epoch seconds
  notAfter: number; // epoch seconds
  graceDays: number; // keep serving this long past notAfter if the hub is unreachable
  instanceId?: string;
};

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** Sign claims with an Ed25519 private key (PEM). Used by the hub (and tests). */
export function signLicense(privateKeyPem: string, claims: LicenseClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  const signature = sign(null, payload, createPrivateKey(privateKeyPem));
  return `${b64url(payload)}.${b64url(signature)}`;
}

/** Verify a token against an Ed25519 public key (PEM) and return its claims. Throws on tamper/format. */
export function verifyLicense(publicKeyPem: string, token: string): LicenseClaims {
  const [payloadPart, sigPart] = token.split(".");
  if (!payloadPart || !sigPart) throw new Error("malformed license token");
  const payload = fromB64url(payloadPart);
  if (!verify(null, payload, createPublicKey(publicKeyPem), fromB64url(sigPart))) {
    throw new Error("license signature invalid");
  }
  return JSON.parse(payload.toString("utf8")) as LicenseClaims;
}

export type LicenseStatus = "valid" | "grace" | "expired" | "not_yet_valid";

/** Time validity of already-signature-verified claims, with the grace window past notAfter. */
export function licenseStatus(claims: LicenseClaims, nowSec: number): LicenseStatus {
  if (nowSec < claims.notBefore) return "not_yet_valid";
  if (nowSec <= claims.notAfter) return "valid";
  if (nowSec <= claims.notAfter + claims.graceDays * 86400) return "grace";
  return "expired";
}

/** Generate an Ed25519 keypair (PEM). For tests / hub key provisioning. */
export function generateLicenseKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
