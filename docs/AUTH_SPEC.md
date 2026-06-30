# hara-control Auth — Spec (v1: simple + secure)

> Handoff spec for whoever builds the hara-control auth module. **Design goal: the
> simplest thing that is secure for a self-hosted control plane.** No 2FA built in
> (MFA is delegated to SSO). Open-core: built-in accounts + login + RBAC live in
> **open** hara-control; OIDC/SAML/SCIM are a **thin enterprise gate**.
>
> Status: Phase 1 = build now (it's hara-control's usability floor — nobody runs an
> admin plane on a shared key in prod). Phase 2 (`hara login` device flow) = specced,
> deferred to first real self-deploying customer. Phase 3 (SSO) = enterprise.

---

## Guiding principles

1. **No new dependencies** — passwords + JWT via `node:crypto` only (scrypt + HMAC).
2. **Stateless** — JWT, no session store. Revocation via a `disabledAt` check, not a denylist.
3. **Back-compatible** — the existing `x-admin-key` keeps working (= SUPERADMIN) so nothing breaks mid-migration.
4. **Network-locked first** — `/admin/*` and `/auth/*` stay bound to localhost / VPN / IP-allowlist (see self-host deploy). Auth is defense-in-depth *on top of* the network boundary, not instead of it.
5. **Keep it small** — see "What NOT to build" at the end. Resist scope creep.

---

## Phase 1 — built-in accounts + login + RBAC  (BUILD NOW)

### Data model (minimal)
```
User {
  id          String   @id @default(cuid())
  email       String   @unique
  passwordHash String           // scrypt, format "scrypt$N$r$p$salt$hash"
  role        Role               // enum below
  orgId       String             // scopes what this user can see/do
  personId    String?  @unique   // optional link to the existing Person directory entry
  disabledAt  DateTime?          // revoke = set this; checked on every request
  totpSecret  String?            // SEAM — unused in v1; enables optional TOTP later w/o migration
  createdAt   DateTime @default(now())
}
enum Role { SUPERADMIN  ADMIN  MEMBER }
```
> If `Person` is being reworked anyway, merging creds onto `Person` (nullable
> `passwordHash`/`role`) is acceptable — `Person` already carries `email + orgId`.
> Either way the *behavior* below is what matters.

### Crypto (`src/common/crypto.ts`, node:crypto — already partly drafted)
- `hashPassword(pw)` / `verifyPassword(pw, hash)` → **scrypt** (`crypto.scryptSync`, random 16-byte salt, timing-safe compare).
- `signJwt(payload, ttl)` / `verifyJwt(token)` → **HS256** via `crypto.createHmac`. Secret = env `HARA_JWT_SECRET` (required; fail fast if absent in prod). Access token TTL **1h**. No refresh token in v1 — re-login.

### Endpoints
| Method | Path | Guard | Purpose |
|---|---|---|---|
| POST | `/auth/bootstrap-superadmin` | `x-admin-key` **and** only if `User` count == 0 | first-run: create the one SUPERADMIN |
| POST | `/auth/login` | none (rate-limited) | `{email,password}` → `{access_token, expires_in}` |
| GET  | `/auth/me` | Bearer JWT | `{id,email,role,orgId}` (whoami) |
| POST | `/admin/users` | SUPERADMIN | create/invite a user (sets a temp password or returns a set-password link) |
| PATCH| `/admin/users/:id` | SUPERADMIN | change role / disable (`disabledAt`) / reset password |

CLI: `npm run create-superadmin -- --email a@b.c` (server-side seed; prompts for password). Equivalent to the bootstrap endpoint for ops who'd rather not curl.

### Guard (`AdminAuthGuard`, replaces `AdminKeyGuard`)
Accept **either**:
- `Authorization: Bearer <jwt>` → decode, load user, reject if `disabledAt`, enforce the route's required role; **or**
- `x-admin-key: <HARA_CONTROL_ADMIN_KEY>` → treated as SUPERADMIN (back-compat; keep until SSO lands).

### RBAC (3 roles, a guard — NOT a policy engine)
| Role | Can do |
|---|---|
| **SUPERADMIN** | everything + user management |
| **ADMIN** | fleet view, enroll-codes, roles/persons/teams, org policy, device revoke, audit |
| **MEMBER** | self only — own devices, own enrollment, `/auth/me` |

Existing `/admin/*` endpoints get a required-role annotation (most = ADMIN; `/admin/users*` = SUPERADMIN).

### Security hygiene = "secure enough" without 2FA
- scrypt passwords (never plaintext / never reversible).
- Short JWT (1h) + `disabledAt` revocation checked per request.
- **Login rate-limit** (e.g. 10 attempts / IP / minute, 5 / email / minute) — in-memory counter is fine for single-node.
- Min password length (12) + reject the 100 worst passwords (small built-in list, no external service).
- `/auth/*` + `/admin/*` network-locked (deploy concern, already specced).
- HTTPS only (gateway nginx already terminates TLS).
- Audit-log every auth event (login success/fail, user create/disable, role change) into the existing hash-chained `AuditLog`.

---

## Phase 2 — `hara login` device flow  (SPECCED, deferred)

> Trigger to build: first company self-deploys hara-control with ≥~10 users, or admin
> says "issuing enroll-codes is a pain", or we go hosted-SaaS. Until then, `hara enroll
> --code` is enough. Reuses the Phase-1 user/JWT — it's a thin add-on.

### Why a device flow (RFC 8628), like `gh auth login` / codex
Headless/SSH/container-friendly (no loopback browser). The CLI shows a short code + URL;
the user approves in any browser; the CLI polls. Standard, and the same plumbing SSO rides on later.

### Endpoints (RFC 8628)
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/device/code` | → `{device_code, user_code, verification_uri, interval, expires_in}` |
| GET/POST | `/activate` | web page: user logs in (Phase-1 login, later SSO) + approves `user_code` |
| POST | `/auth/device/token` | CLI polls → user JWT, or `authorization_pending` / `slow_down` |
| POST | `/devices/self-enroll` | Bearer user JWT → mints the device token (LiteLLM virtual key), binds user_id+device_id → `{deviceId, deviceToken, model, base_url}` |

### CLI (hara-cli)
- `hara login <gateway-url> [--no-browser]` → device flow → writes `~/.hara/org.json` (**same shape as `hara enroll`** — provider auto = `hara-gateway`, chat path unchanged).
- `hara logout` (clear org.json + best-effort revoke), `hara whoami`.
- **The gateway URL is required input** (each company self-hosts at its own domain/IP — unavoidable, same as `gh auth login --hostname`): positional arg, else interactive prompt; **saved in org.json** so re-login doesn't re-ask; accept bare `host:port`.

### Implementation seam (grounded in `src/enroll/enroll.service.ts`)
The device flow is a *thin add-on* — it reuses the existing enroll machinery, so the new surface is small:
- **Factor out token issuance.** `EnrollService.enroll()` already does the tail `seatCheck → Device.create → gateway.issueKey → DeviceToken.create (sha256 hash, TTL) → return {device_token, device_id, model, base_url}`. Extract that tail into `issueDeviceToken({ orgId, personId, model, baseUrl, device })`. Then **both** `POST /v1/enroll` (code path, unchanged) and `POST /devices/self-enroll` (JWT path, new) call the same function → identical token shape, one code path, one place for token discipline.
- **`/devices/self-enroll`** = `issueDeviceToken({ orgId: user.orgId, personId: user.personId, model: <org default model>, device })`, gated by the Phase-1 Bearer **user** JWT. No `enrollCode` row is created — the *user JWT itself* is the proof of identity (the device flow already authenticated the person); it replaces the admin-minted code.
- **Binding step** (`/auth/device/code` → approve): persist a `DeviceAuth { deviceCode, userCode, status: pending|approved, userId?, expiresAt }`. The `verification_uri` page **reuses the Phase-1 `/auth/login`** session; once logged in, the user confirms the `userCode` → set `status=approved, userId`. `/auth/device/token` polls that row and returns the user JWT once approved (RFC 8628 `authorization_pending` / `slow_down` until then, single-use, short `expires_in`).
- **Reuse unchanged:** `entitlement.seatCheck(orgId)`, `security/token-discipline` (TTL + revocation + spend-cap), `AuditService.log(orgId, "self-enroll", "device", …)`, `sha256(key)` at-rest hashing. `hara enroll --code` stays as the headless/CI fallback (it shares `issueDeviceToken`).

> **Prerequisite ordering:** Phase 1 (`User`+`Role`, `/auth/login`, JWT, `AdminAuthGuard`) must land first — the device flow's whole point is to swap a *person login* for a device token, so person logins must exist. Until Phase 1 **and** 2 ship, `hara enroll --code` (admin mints in console → user pastes) remains the only working path — which is exactly what hara does today.

---

## Phase 3 — SSO / MFA  (enterprise, thin gate)

- hara-enterprise intercepts `/auth` → company IdP via **OIDC** (and SAML for legacy). **MFA is enforced at the IdP** (Okta/Google/Azure) — this is the answer to "do we need 2FA".
- SCIM for user auto-provisioning/deprovisioning.
- Open core stays fully usable standalone; enterprise only adds "which IdP, what quota, where audit goes".

---

## 2FA decision (explicit)

- **No built-in 2FA in v1.** TOTP enrollment + recovery codes + backup flows are disproportionate complexity for a network-locked, small-team, self-hosted plane.
- **MFA = the IdP's job** via SSO (Phase 3). Don't reimplement what Okta/Google/Azure already do well.
- **Seam kept:** `User.totpSecret` nullable column exists from day one → optional built-in TOTP can be added later with zero migration if a customer without an IdP demands it.

---

## What NOT to build (keep it simple)

- ❌ No refresh-token rotation (short access JWT + re-login is fine at this scale).
- ❌ No email-based password reset flow in v1 (SUPERADMIN resets via `/admin/users/:id`).
- ❌ No session store / token denylist (stateless JWT + `disabledAt`).
- ❌ No OAuth *server* beyond the device flow (we're not an IdP).
- ❌ No built-in 2FA (see above).
- ❌ No per-resource ACLs / policy DSL (3 roles + a guard covers it).

---

## Open-core split

| Capability | Open (hara-control) | Closed (hara-enterprise) |
|---|---|---|
| Built-in accounts + password login | ✅ | |
| RBAC (3 roles) | ✅ | |
| `hara login` device flow | ✅ | |
| Login rate-limit / audit of auth events | ✅ | |
| OIDC / SAML → IdP (MFA delegation) | | ✅ |
| SCIM provisioning | | ✅ |
| SIEM audit export | | ✅ |

---

## Already-drafted starting point
Per MEMORY `reference_hara_repos_structure`: an `AdminUser` Prisma model + `node:crypto`
scrypt + HS256 JWT + `/auth/login` + `/auth/bootstrap-superadmin` (shared-key gated) +
`AdminAuthGuard` (accepts shared-key **or** JWT) + a `create-superadmin` CLI were already
drafted (unapplied, no new deps). This spec generalizes that to the `User`+Role shape above
and adds the Phase-2 device flow + the 2FA decision.
