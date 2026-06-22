// License crypto unit tests — Ed25519 sign/verify (offline) + validity windows.
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLicenseKeypair, licenseStatus, signLicense, verifyLicense, type LicenseClaims } from "../src/license/license";

const now = 1_800_000_000; // fixed epoch seconds
const baseClaims: LicenseClaims = {
  hubOrgId: "o1", plan: "enterprise", seatLimit: 10,
  features: ["agent-org", "code-assets"], notBefore: now - 100, notAfter: now + 1000, graceDays: 30,
};

test("license: sign + verify round-trips claims", () => {
  const { publicKey, privateKey } = generateLicenseKeypair();
  const claims = verifyLicense(publicKey, signLicense(privateKey, baseClaims));
  assert.equal(claims.plan, "enterprise");
  assert.equal(claims.seatLimit, 10);
  assert.deepEqual(claims.features, ["agent-org", "code-assets"]);
});

test("license: tampered claims fail verification (can't bump seats)", () => {
  const { publicKey, privateKey } = generateLicenseKeypair();
  const sig = signLicense(privateKey, baseClaims).split(".")[1];
  const forged = Buffer.from(JSON.stringify({ ...baseClaims, seatLimit: 9999 })).toString("base64url");
  assert.throws(() => verifyLicense(publicKey, `${forged}.${sig}`), /signature invalid/);
});

test("license: a different key fails verification", () => {
  const a = generateLicenseKeypair();
  const b = generateLicenseKeypair();
  assert.throws(() => verifyLicense(b.publicKey, signLicense(a.privateKey, baseClaims)), /signature invalid/);
});

test("license: malformed token rejected", () => {
  const { publicKey } = generateLicenseKeypair();
  assert.throws(() => verifyLicense(publicKey, "not-a-token"), /malformed/);
});

test("licenseStatus: valid / not-yet / grace / expired", () => {
  assert.equal(licenseStatus(baseClaims, now), "valid");
  assert.equal(licenseStatus(baseClaims, now - 200), "not_yet_valid");
  assert.equal(licenseStatus(baseClaims, now + 1000 + 86400 * 10), "grace"); // within 30d grace
  assert.equal(licenseStatus(baseClaims, now + 1000 + 86400 * 40), "expired"); // past grace
});
