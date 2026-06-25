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

- **Append is atomic:** `log()` reads the chain head and inserts inside a `$transaction`, so concurrent
  writes can't fork the chain.
- **Verification:** `AuditService.verify(orgId)` recomputes the chain and returns
  `{ ok, count, brokenAt? }`, pinpointing the first row whose `rowHash` or `prevHash` linkage breaks —
  i.e. any after-the-fact edit/delete/reorder. Exposed at `GET /admin/audit/verify?orgId=…`
  (admin-key gated).
- **Backward-compatible:** new columns default to `''`/`0`; pre-existing rows have empty hashes and are
  treated as the genesis prefix.

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

### B. At-rest secret envelope encryption / KMS adapter

**Status: not implemented — design + seam documented.**

**What needs protecting at rest:** the **real upstream provider key** and the **LiteLLM master key**.
Today these live in `.env` / process env and inside LiteLLM's own store. Device tokens are already
hash-only at rest (good); the gap is the *upstream* credentials and any future per-org BYO-key.

**Design (envelope encryption):**
- A **KMS adapter interface** mirroring the existing `GatewayAdapter` seam pattern:
  ```ts
  // src/security/kms/kms-adapter.ts  (the seam)
  interface KmsAdapter {
    encrypt(plaintext: Buffer, ctx: { orgId?: string }): Promise<{ ciphertext: Buffer; wrappedDek: Buffer; keyRef: string }>;
    decrypt(ciphertext: Buffer, wrappedDek: Buffer, keyRef: string, ctx: { orgId?: string }): Promise<Buffer>;
  }
  ```
- **Envelope scheme:** generate a per-secret **DEK** (AES-256-GCM) locally, encrypt the secret with it,
  then **wrap the DEK** with the KMS **CEK**. Store `{ciphertext, wrappedDek, keyRef, iv, tag}` — never
  the plaintext, never an unwrapped DEK at rest. Use `orgId` as the encryption **context/AAD** so a
  ciphertext can't be replayed across tenants.
- **Adapters:** `LocalKeyfileKms` (AES-256-GCM with a master key from a file / `HARA_KMS_MASTER_KEY`,
  for self-hosters with no cloud KMS — *envelope, but root key still local*), `AwsKmsAdapter`,
  `GcpKmsAdapter`, `VaultTransitAdapter`. Selected via `HARA_KMS_PROVIDER`.
- **Where the seam goes:** a new `Secret` store (or columns on a future `OrgUpstreamKey` model) read
  through a `SecretsService` that calls the `KmsAdapter` on read/write. The upstream key would move
  from `.env` into this store; LiteLLM is configured from decrypted-at-startup values held in memory
  only. Rotation = re-wrap DEKs against a new CEK without touching ciphertexts of the secrets.
- **Migration:** additive `Secret` table; a one-shot importer reads existing `.env` upstream keys,
  encrypts, and writes them — then the `.env` plaintext can be removed.

**Non-goals for v1:** HSM-backed signing, per-request key derivation. Start with envelope + a cloud-KMS
adapter; the `LocalKeyfileKms` keeps self-hosters secure-by-default without a cloud dependency.

---

## Follow-ups (smaller)

- **SSRF connect-pinning:** custom `undici` dispatcher that connects to the validated IP to fully close
  the DNS-rebinding TOCTOU window (current guard validates resolved IPs + every redirect, which covers
  the realistic vectors).
- **Admin auth:** `x-admin-key` shared secret → OIDC/SSO + RBAC (Phase 2, already on the roadmap).
- **Audit signed checkpoints:** see §2 deferred extension.
- **Spend cap wiring:** connect `token-discipline`'s `SpendChecker` to the LiteLLM `listSpend` join so
  the cap is live, not just a hook.
