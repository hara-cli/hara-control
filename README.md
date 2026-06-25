# hara-control

> **Open source — Apache-2.0.** The **control plane** for the [hara](https://github.com/hara-cli/hara) fleet:
> device enrollment, scoped token issue/revoke, fleet view, and governance. Self-host it freely — your upstream
> provider keys never leave your infrastructure.
>
> We make money from **operating it**, not from withholding it: a **managed/hosted** control plane (zero-ops,
> self-serve), closed **enterprise plugins** (SSO/SCIM, org-scale RBAC, tamper-evident audit/compliance), and a
> curated **governance content** library (role/policy packs). The engine is open; the operation and the curated
> content are the paid layer. Nothing here is obfuscated — every shipped line is readable Apache-2.0 source.

## What this is

`hara-control` is the **control plane** for running hara across an organization's machines:

- **Device enrollment** — `hara enroll <gateway>` pairs a machine, issues it a scoped device token
  (the real upstream provider key **never** lands on the device).
- **Token lifecycle** — issue / scope / budget / revoke per device, per user.
- **Fleet view** — which machines are online, who, version, today's tokens + cost, which models.
- **Governance** — model allow-lists, per-seat budgets, data-residency policy, org RBAC, audit log.
- **Multi-tenant** (later) — many orgs on one managed deployment.

It does **not** reimplement the LLM gateway. The **data plane** (protocol translation, routing to N
upstreams incl. cloud + customer self-hosted vLLM/Ollama, streaming, retries, upstream-key vault) is a
**bought/embedded engine** — **LiteLLM**, run as a black-box sidecar behind a thin adapter. We build the control
plane in the open (Apache-2.0); the moat is the **hosted operation + curated governance content**, not withheld
code. We do not fork the engine.

## Security (v1 hardening — see [`HARDENING.md`](./HARDENING.md))

This control plane issues scoped device tokens and proxies upstream LLM calls. It's designed so the secret is the
**key/config, not the code** (real provider keys live only in the embedded LiteLLM/vault; devices hold a
short-lived, revocable token whose hash is what we store). Because it's now self-hostable by anyone, the
v1 hardening status is:

- ✅ **SSRF allow-list** on outbound fetches — link-local `169.254.0.0/16` (incl. `169.254.169.254`
  metadata) + loopback always blocked, RFC1918 blockable, every redirect re-validated.
  `src/security/ssrf.ts`, wired into the LiteLLM + embeddings calls.
- ✅ **Tamper-evident audit** — per-org hash-chained `AuditLog` + `verify()` (`GET /admin/audit/verify`).
  Signed checkpoints are the deferred enterprise extension.
- ✅ **Token discipline** — short TTL (`expiresAt`, default 7d) + server-side revocation check on every
  validation + a per-device/per-tenant spend-cap enforcement hook. `src/security/token-discipline.ts`.
- 🟡 **Multi-tenant isolation** — Postgres RLS policies exist on all org-scoped tables; finishing it (a
  non-owner app role + `FORCE` + `WITH CHECK`) is documented in `HARDENING.md §A`.
- 📝 **At-rest secrets** via envelope encryption / KMS — design + seam documented in `HARDENING.md §B`
  (not yet implemented; upstream keys currently live in `.env`/LiteLLM).

Self-hosted and hosted-by-Nanhara are different threat models; defaults target secure-by-default for self-hosters.
Config knobs for the above are in [`.env.example`](./.env.example).

## Architecture (decided)

```
 hara CLI (OSS, Apache)            hara-control (this repo, closed)
 provider = "hara-gateway"   ┌──────────────────────────────────────────┐
 device token, no real key   │  NestJS control plane  ──────┐           │
        │                    │   enroll · tokens · fleet ·   │  Postgres │
        ▼                    │   governance · audit          │  (shared) │
   private net (Tailscale)   │            │                  │     ▲     │
        └───────────────────▶│            ▼                  │     │     │
                             │  LiteLLM (Python sidecar) ────┴─────┘     │
                             │   /v1/messages · routing · upstream keys  │
                             └───────────────┬──────────────────────────┘
                                             ▼
                               cloud relay  /  internal self-hosted models
```

- **Two token layers**: device↔gateway = hara-issued token; gateway↔upstream = real provider key
  (only at the gateway, in a vault/env). **Real key never on the device** = core invariant.
- **Shared DB**: hara-control and LiteLLM share **one Postgres** so the fleet usage view can `JOIN`
  the device registry against LiteLLM's spend tables directly (no cross-DB ETL).
- **Shared protocol types**: `@nanhara/hara-protocol` (enroll / heartbeat / token DTOs) lives on the
  open CLI side; this closed server depends on it.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server | **NestJS** | team already runs Nest; guards/DI/modules fit the RBAC/multi-tenant/SSO roadmap |
| ORM | **Prisma** | clean Postgres support; migrations |
| DB | **PostgreSQL** | LiteLLM is PG-native (direct spend-table joins); JSONB for policy/audit; RLS for multi-tenancy |
| Data plane | **LiteLLM** (sidecar) | mature OSS gateway, MIT core, covers cloud + self-hosted + `/v1/messages` |

## Status

- **Phase 0 — spike: ✅ done.** LiteLLM proxies Anthropic `/v1/messages` with streaming + tool calls
  end-to-end (see [`phase0/`](./phase0/)).
- **Phase 1 — MVP: 🟡 scaffolded.** NestJS + Prisma + Postgres. Endpoints: `POST /v1/enroll`,
  `POST /v1/heartbeat` (device-facing, matches the CLI contract); `POST /admin/orgs`,
  `POST /admin/enroll-codes`, `GET /admin/fleet`, `POST /admin/devices/:id/revoke` (admin-key gated).
  Device tokens are gateway virtual keys behind the `GatewayAdapter` seam (LiteLLM in prod, an
  in-process mock for dev/test); only token **hashes** are stored. Enroll-flow logic is unit-tested
  offline (`npm test`, 3/3). **Pending:** `prisma migrate` + live e2e against Postgres, LiteLLM
  adapter live test.

### Run Phase 1 locally

```bash
cp .env.example .env                 # set HARA_CONTROL_ADMIN_KEY etc.
docker compose up -d postgres        # needs Docker running
npx prisma migrate dev --name init   # create tables
npm run start:dev                    # control plane on :4100
# smoke:
curl -X POST localhost:4100/admin/orgs -H 'x-admin-key: admin-dev-change-me' \
  -H 'content-type: application/json' -d '{"name":"acme"}'
```

Roadmap: ~~Phase 0 spike~~ → **Phase 1 MVP** (here) → Phase 2 hardening (OIDC/SSO, audit, RBAC) →
~~Phase 3 multi-tenant SaaS~~ → **single-company mode with a flexible org-unit hierarchy**
(集团 → 公司 → 部门 → 组; see [`docs/org-hierarchy.md`](docs/org-hierarchy.md)). We are **not** building a
multi-tenant SaaS; instead `Organization` is a self-referential tree that scales from one company (a
COMPANY root + DEPARTMENT children) up to a group/conglomerate later, with **no** schema change.
