# hara-control — Security Hardening

`hara-control` issues scoped, revocable device tokens and proxies upstream LLM calls. The secret is the
**key/config, not the code**: real provider keys live only in the embedded LiteLLM/vault; devices hold a
short-lived, revocable token whose **sha256 hash** is all we store. This document tracks the v1
hardening: what is **implemented**, how it is **wired**, and what is **designed-but-deferred** with a
concrete plan.

Self-hosted and Nanhara-hosted are different threat models; defaults target **secure-by-default for
self-hosters** while keeping the normal single-box deployment (LiteLLM on localhost) working out of the
box.

---

## Implemented

### 1. SSRF allow-list on outbound fetches ✅

**Where:** `src/security/ssrf.ts` (reusable guard) wired into every outbound fetch:
- `src/gateway/litellm.adapter.ts` — calls to the LiteLLM admin API (`LITELLM_URL`)
- `src/embed/embedding.service.ts` — calls to the embeddings endpoint (`HARA_EMBED_BASE_URL`)

**What it blocks:**
- Link-local `169.254.0.0/16` **including the cloud metadata endpoint `169.254.169.254`** — *always*,
  regardless of allow-list. Unspecified (`0.0.0.0`, `::`) and IPv6 link-local (`fe80::/10`) — always;
  and IPv4-mapped forms (`::ffff:169.254.169.254`).
- Loopback (`127.0.0.0/8`, `::1`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`),
  IPv6 ULA (`fc00::/7`) — classified as **private** and blocked when the operator opts in
  (`HARA_SSRF_BLOCK_PRIVATE=1`) and no explicit allow-list is set. Loopback is intentionally *not* in
  the always-blocked set so the normal single-box deployment (LiteLLM on `localhost:4000`) works out of
  the box; an allow-list entry can permit a private upstream on purpose.
- Non-`http(s)` schemes (`file:`, `gopher:`, …).
- **Redirects into private space:** `safeFetch()` follows redirects *manually* and re-validates every
  `Location` hop, so a permitted host cannot 30x the request into the metadata IP.

**How it decides (`safeFetch` / `assertUrlAllowed`):**
1. Parse + scheme check.
2. If `HARA_SSRF_ALLOW_HOSTS` is set, the request host must be on it (authoritative).
3. Resolve the host via DNS (defends against DNS-rebinding-to-private) and check **every** answer:
   always-blocked set → reject; private space → reject per policy.

**Config:** `HARA_SSRF_ALLOW_HOSTS` (csv hostnames), `HARA_SSRF_BLOCK_PRIVATE` (`1`/`0`),
`HARA_SSRF_MAX_REDIRECTS`. See `.env.example`.

**Tests:** `test/ssrf.test.ts` (IP classification, metadata block, allow-list, scheme reject, redirect
re-validation contract).

> Note: TOCTOU between the DNS check and the kernel connect is not fully closed by a userland check.
> The complete fix is a custom dispatcher/agent that pins the connect to the validated IP (documented
> below as a follow-up); the current guard covers the realistic SSRF vectors (literal IPs, hostnames
> resolving to private space, redirect chains).

### 2. Tamper-evident audit log (hash chain) ✅

**Where:** `src/audit/audit.service.ts`, schema `AuditLog` (migration
`prisma/migrations/20260625000000_audit_hash_chain`).

**Model:** Each `AuditLog` row carries `seq` (per-org monotonic position), `prevHash` (the previous
row's `rowHash`), and `rowHash = sha256(canonicalJson(identity) + prevHash)` where `identity` =
`{orgId, action, actorType, actorId, payload, seq, at}`. The chain is **per-org** (matches the
`@@index([orgId, seq])` and the tenant model). `canonicalJson` (in `src/common/crypto.ts`) sorts keys
recursively so the hash is insertion-order independent and nested-payload tamper is detected.

- **Append is atomic:** `log()` reads the chain head and inserts in a serializable transaction with
  bounded conflict retries; a database uniqueness constraint on `(orgId, seq)` is the final
  fail-closed guard against concurrent forks.
- **Verification:** `AuditService.verify(orgId)` recomputes the chain and returns
  `{ ok, count, brokenAt? }`, pinpointing the first row whose `rowHash` or `prevHash` linkage breaks —
  i.e. any after-the-fact edit/delete/reorder. Exposed at `GET /admin/audit/verify?orgId=…`
  (admin-key gated).
- **Backward-compatible and honest:** pre-chain rows are retained as a stable, re-sequenced legacy
  prefix. Verification reports `legacyPrefix` and does not claim those rows were cryptographically
  anchored; the first new hashed row starts the verifiable suffix. Migration fails closed if a
  duplicate sequence group contains any already-hashed row.

**Tests:** `test/audit-chain.test.ts` (links rows, detects payload tamper, per-org isolation).

**Deferred extension (paid/enterprise):** periodic **signed checkpoints** — anchor the chain head with
an Ed25519 signature (the `license.ts` Ed25519 plumbing already exists) so an attacker who controls the
DB can't silently rebuild the whole chain. The seam: a `checkpoint(orgId)` that signs
`{orgId, headSeq, headRowHash, at}` and stores/exports it; verify cross-checks the latest checkpoint.

### 3. Token discipline (TTL + revocation + spend-cap hook) ✅

**Where:** `src/security/token-discipline.ts`, used by **every** device-token validation site:
`enroll.heartbeat`, `work.deviceFromBearer`, `roles.bundleForBearer`, `assets.deviceFromBearer`.

- **Short TTL:** `DeviceToken.expiresAt` (migration `20260625000100_device_token_ttl`). Set on issue in
  `enroll.service.ts` via `deviceTokenExpiry()` = `now + HARA_DEVICE_TOKEN_TTL_MINUTES` (default 7d).
  Legacy tokens without `expiresAt` are treated as non-expiring (backward-compatible) until re-issued.
- **Explicit revocation check:** `assertTokenUsable()` rejects `revokedAt != null` (and null/unknown)
  on every validation — one chokepoint, no per-site drift.
- **Per-device / per-tenant spend (rate) cap hook:** `HARA_DEVICE_SPEND_CAP_USD` (0 = uncapped) plus a
  pluggable `SpendChecker`. The **enforcement point exists and is exercised**, but is inert until a
  live-spend lookup is supplied (the LiteLLM `listSpend` join is the intended source). This is the
  structure + seam, not a behavior change by default.

**Tests:** `test/token-discipline.test.ts`; `test/enroll.test.ts` (existing) still green — issue stores
the hash + expiry, heartbeat enforces revocation/expiry.

### 4. At-rest secret envelope encryption / KMS adapter ✅

**Status: implemented (envelope + `LocalKeyfileKms` + `SecretsService` + one-time provider import +
supervised activation). Cloud-KMS adapters and root-key rotation remain deferred.**

**What needs protecting at rest:** the **real upstream provider key** and the **LiteLLM master key**.
The DeepSeek key is now envelope-encrypted in `Secret`; a supervised launcher decrypts the selected
revision only into the LiteLLM child environment and records a non-secret activation revision. Its
one-time bootstrap value is atomically blanked from the owner-only `.env`. Device tokens are hash-only
in the control database and expire in both control and data planes. The LiteLLM master key remains an
owner-only deployment secret and should move to an external secret manager in hosted production.
The dockerless deploy starts only owner-only env-loader wrappers through PM2, then rejects any process
definition or dump that serializes database, auth, KMS, LiteLLM, or provider credentials.

**Where:**
- `src/security/kms/kms-adapter.ts` — the seam (`KmsAdapter` interface + `Envelope`/`KmsContext` types +
  `KmsConfigError` + `KMS_ADAPTER` DI token), mirroring `GatewayAdapter`.
- `src/security/kms/local-keyfile.ts` — `LocalKeyfileKms`, AES-256-GCM envelope, `node:crypto` only.
- `src/security/kms/index.ts` — `createKms()` factory selecting by `HARA_KMS_PROVIDER`.
- `src/security/secrets.service.ts` + `secrets.module.ts` — `SecretsService.put/get/getString/remove`,
  wired `@Global` into `app.module.ts` (KMS adapter built **lazily** on first use so dev/test/CI boot
  without a master key, like `GATEWAY_ADAPTER` defaulting to the mock).
- `src/ops/provider-secret.ts` — one-time DeepSeek import, plaintext `.env` scrubbing, and supervised
  runtime activation without exposing values through the console/API.
- `scripts/assert-pm2-env-safe.mjs` — fail-closed verification that PM2 persisted no protected runtime
  values in either serialized environment snapshot.
- `src/providers/provider-credentials.service.ts` — SUPERADMIN status/rotation/probes; responses
  contain only lifecycle metadata, never values or credential-derived fingerprints.
- Prisma `Secret` model + migration `prisma/migrations/20260626000000_secrets_store` (additive,
  `CREATE TABLE IF NOT EXISTS`, Postgres `BYTEA`).

**Envelope scheme (as implemented — for crypto review):**
- Per `encrypt()`: generate a fresh random **32-byte DEK**; AES-256-GCM-encrypt the plaintext under the
  DEK with a fresh random **12-byte IV**, binding `ctx.orgId` as the GCM **AAD**. The stored
  `ciphertext` packs `iv(12) ‖ authTag(16) ‖ enc` (so the spec's `{iv, tag}` live *with* the
  ciphertext rather than as separate columns).
- The DEK is then **wrapped** with the master **CEK** (also AES-256-GCM, its own fresh 12-byte IV);
  `wrappedDek` packs `iv(12) ‖ authTag(16) ‖ encDek`.
- Persist only `{ciphertext, wrappedDek, keyRef}` — **never** the plaintext, **never** an unwrapped DEK.
  `keyRef = "local:<sha256(CEK)[:16]>"` identifies *which* CEK wrapped the DEK (a non-reversible
  fingerprint, never the key itself), so rotation = re-wrap DEKs against a new CEK without re-encrypting
  any ciphertext. The master key is never logged.
- **Tenant isolation:** `orgId` AAD means a ciphertext copied into another tenant's row fails to decrypt
  (GCM tag check). A `null` orgId = a control-plane-global secret (its own namespace).
- **Master key (CEK) source:** `HARA_KMS_MASTER_KEY` (32 bytes as base64 / base64url / 64-char hex) or
  `HARA_KMS_KEYFILE` (a path whose contents decode to 32 bytes). Missing/short → clear `KmsConfigError`
  (never silently weak crypto).

**Provider selection (`HARA_KMS_PROVIDER`):** `local` (default) → `LocalKeyfileKms`; `aws` / `gcp` /
`vault` → clearly-labeled "not implemented, configure X" stubs that **throw** (the seam exists for the
swap, but never silently falls back to weaker crypto). Unknown provider → fail fast.

**Tests:** `test/kms.test.ts` (offline, no live DB) — envelope round-trip (string + binary), fresh-IV
(same plaintext → different ciphertext), AAD/tenant isolation, ciphertext + wrapped-DEK tamper
detection, wrong-CEK + master-key-missing/bad-length errors, factory selection + cloud-stub throws, and
`SecretsService` put→get over a fake Prisma (never stores plaintext; rotates on re-put; cross-tenant
DB-theft fails to decrypt).

**Still deferred (designed, not built):**
- **Cloud-KMS adapters** (`AwsKmsAdapter`, `GcpKmsAdapter`, `VaultTransitAdapter`) — seams throw with a
  configure hint; implement against the cloud root key when needed (HSM-backed root, no local CEK).
- **DEK rotation tooling** — re-wrap stored `wrappedDek`s against a new CEK (the `keyRef` field is the
  hook; cross-CEK reads already fail clearly).
- **External custody for the LiteLLM master/admin/JWT secrets** — today the formal dockerless path
  keeps them distinct in an owner-only env file parsed as data, never sourced as shell.

**Non-goals for v1:** HSM-backed signing, per-request key derivation. `LocalKeyfileKms` keeps
self-hosters secure-by-default without a cloud dependency; the cloud adapter is the next increment.

---

## Documented as TODO (designed, not fully implemented)

### A. Multi-tenant Postgres Row-Level Security (RLS)

**Status: partially implemented — needs FORCE + a non-owner app role to be a true wall.**

Already present (`prisma/migrations/20260622040000_rls_policies` + `20260622180000_rls_work_sessions`):
every org-scoped table (`Organization`, `EnrollCode`, `Device`, `AuditLog`, `Role`, `Team`, `Person`,
`DigitalEmployee`, `WorkSession`, `WorkEvent`) has `ENABLE ROW LEVEL SECURITY` + a policy
`USING ("orgId" = current_setting('app.current_org', true))`. `PrismaService.withOrg(orgId, fn)` sets
that session var, LOCAL to a transaction, so reads/writes on that connection are org-scoped. Prisma
maps `@id` to `text`, so policies compare text-to-text; an unset session var → no rows (fail-closed).

**Why it isn't yet a hard wall:** the policies are **not `FORCE`d**, and the app connects as the table
**owner**, which bypasses RLS. Today's isolation therefore still relies on the app's explicit
`where: { orgId }` scoping; RLS is defense-in-depth, not the primary boundary.

**Plan to finish (Phase-2b):**
1. **Create a dedicated app role** (e.g. `hara_app`) that is **not** the table owner; grant it
   `SELECT/INSERT/UPDATE/DELETE` on the app tables. Point `DATABASE_URL` at it in `saas` mode.
2. **`ALTER TABLE … FORCE ROW LEVEL SECURITY`** on every org-scoped table so even the owner is subject
   to policies (or simply never connect as owner at runtime).
3. **Add WITH CHECK** clauses to the policies (currently `USING` only) so a tenant cannot *write* a row
   with someone else's `orgId`: `CREATE POLICY org_isolation … USING (…) WITH CHECK (…)`.
4. **Route all tenant-scoped queries through `withOrg`** in `saas` mode (today many services pass
   `orgId` in `where` directly on the base client). Add a lint/CI check that the raw client isn't used
   for tenant tables in saas mode.
5. **Intentionally-global tables** stay outside RLS by design: `DeviceToken` (looked up by token hash
   before org is known) and `PersonTeam` (junction) — document and keep their access paths narrow.
6. **Migration tables:** never apply RLS to `_prisma_migrations`.

**Tables in scope:** all listed above; explicitly **excluded:** `DeviceToken`, `PersonTeam`,
`_prisma_migrations`, and the LiteLLM-owned spend tables (separate ownership in the shared DB).

> §B (at-rest secret envelope encryption / KMS) graduated from this TODO section to **Implemented #4**
> above.

---

## Follow-ups (smaller)

- **SSRF connect-pinning:** custom `undici` dispatcher that connects to the validated IP to fully close
  the DNS-rebinding TOCTOU window (current guard validates resolved IPs + every redirect, which covers
  the realistic vectors).
- **Admin auth:** `x-admin-key` shared secret → OIDC/SSO + RBAC (Phase 2, already on the roadmap).
- **Audit signed checkpoints:** see §2 deferred extension.
- **Spend cap wiring:** connect `token-discipline`'s `SpendChecker` to the LiteLLM `listSpend` join so
  the cap is live, not just a hook.
