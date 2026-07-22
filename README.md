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
- **Token lifecycle** — issue / scope / expiry / rolling budget / rate limit / revoke per device, per user.
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
  metadata) always blocked, RFC1918/loopback blockable or explicitly allow-listed, every redirect re-validated.
  `src/security/ssrf.ts`, wired into the LiteLLM + embeddings calls.
- ✅ **Tamper-evident audit** — per-org hash-chained `AuditLog` + `verify()` (`GET /admin/audit/verify`).
  Signed checkpoints are the deferred enterprise extension.
- ✅ **Token discipline** — short TTL (`expiresAt`, default 7d), server-side revocation checks, and
  LiteLLM-enforced 5-hour / 7-day / 30-day rolling USD budgets plus optional RPM/TPM limits. The
  gateway must expose positive model pricing and confirm every requested limit before enrollment succeeds;
  otherwise the uncertain key is revoked and the exchange fails closed. See
  [`docs/internal-key-policy.md`](docs/internal-key-policy.md).
- 🟡 **Multi-tenant isolation** — Postgres RLS policies exist on all org-scoped tables; finishing it (a
  non-owner app role + `FORCE` + `WITH CHECK`) is documented in `HARDENING.md §A`.
- ✅ **At-rest secrets** via AES-256-GCM envelope encryption / KMS. DeepSeek credential management
  distinguishes the encrypted source-of-truth copy from the currently active LiteLLM runtime value;
  activation is a controlled deploy/restart, never an implicit API-side restart.

Self-hosted and hosted-by-Nanhara are different threat models; defaults target secure-by-default for self-hosters.
Config knobs for the above are in [`.env.example`](./.env.example).

## Architecture (decided)

```
 hara CLI (OSS, Apache)            hara-control (this repo, Apache-2.0)
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
- **Two separate admin concerns**: an internal device key policy controls colleague access, expiry,
  budgets, and rates; an upstream connection pool controls encrypted provider credentials and routing.
  Internal limits are implemented independently so issuing a colleague key never exposes or copies an
  upstream provider key.
- **Shared Postgres, isolated schemas**: hara-control uses `schema=public`; LiteLLM uses
  `schema=litellm`. This keeps migrations/table names from colliding while still permitting an
  explicitly-reviewed usage aggregation path without cross-database ETL.
- **Shared protocol types**: `@nanhara/hara-protocol` (enroll / heartbeat / token DTOs) lives on the
  open CLI side; this open self-hosted control plane depends on it. Hosted operations, account/
  market services, and enterprise extensions stay in physically separate private repositories.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Server | **NestJS** | team already runs Nest; guards/DI/modules fit the RBAC/multi-tenant/SSO roadmap |
| ORM | **Prisma** | clean Postgres support; migrations |
| DB | **PostgreSQL** | LiteLLM is PG-native (direct spend-table joins); JSONB for policy/audit; RLS for multi-tenancy |
| Data plane | **LiteLLM** (sidecar) | mature OSS gateway, MIT core, covers cloud + self-hosted + `/v1/messages` |

## Run with Docker

The published image — [`ghcr.io/hara-cli/hara-control`](https://github.com/hara-cli/hara-control/pkgs/container/hara-control), multi-arch (amd64 + arm64) — is the self-host artifact. It needs a **PostgreSQL** database; on boot the container runs `prisma migrate deploy`, so the **tables are created automatically**. Production also requires independent admin/JWT secrets and an envelope-encryption root. Generate them without printing their values:

```bash
install -d -m 700 secrets
openssl rand -base64 32 > secrets/kms-master.key
chmod 600 secrets/kms-master.key
export HARA_CONTROL_ADMIN_KEY="$(openssl rand -hex 32)"
export HARA_JWT_SECRET="$(openssl rand -hex 32)"
```

### Option A — Docker Compose (brings its own Postgres)

The `postgres` service **creates the `hara_control` database** for you (via `POSTGRES_DB`); the control plane connects to it and migrates on start. Save as `docker-compose.yml` and `docker compose up -d`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16          # Postgres 16 (+pgvector for later semantic search)
    environment:
      POSTGRES_USER: hara
      POSTGRES_PASSWORD: hara
      POSTGRES_DB: hara_control            # ← the database, created on first boot
    volumes:
      - hara-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hara -d hara_control"]
      interval: 5s
      timeout: 3s
      retries: 10

  control:
    image: ghcr.io/hara-cli/hara-control:0.1.11  # pin releases in production
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://hara:hara@postgres:5432/hara_control?schema=public
      HARA_CONTROL_ADMIN_KEY: ${HARA_CONTROL_ADMIN_KEY:?set a random admin key}
      HARA_JWT_SECRET: ${HARA_JWT_SECRET:?set a different random JWT secret}
      HARA_KMS_PROVIDER: local
      HARA_KMS_KEYFILE: /run/hara-secrets/kms-master.key
      GATEWAY_ADAPTER: mock                # control-plane only; no LiteLLM data plane
    volumes:
      - ./secrets/kms-master.key:/run/hara-secrets/kms-master.key:ro
    ports:
      - "4100:4100"

volumes:
  hara-pgdata:
```

Then open the admin console at **http://localhost:4100/console/**, and smoke-test the admin API:

```bash
curl -X POST localhost:4100/admin/orgs \
  -H "x-admin-key: $HARA_CONTROL_ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"acme"}'
```

### Option B — `docker run` against your own Postgres

Already running Postgres? Create an **empty** database, then point the container at it — the schema is created automatically on boot, so there's no manual migration step.

```bash
# 1. create the database once (via psql, or your managed-Postgres console):
createdb hara_control                       # or:  psql -c 'CREATE DATABASE hara_control;'

# 2. run the control plane (tables auto-migrate on start):
docker run -d --name hara-control -p 4100:4100 \
  -e DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/hara_control?schema=public' \
  -e HARA_CONTROL_ADMIN_KEY -e HARA_JWT_SECRET \
  -e HARA_KMS_PROVIDER=local \
  -e HARA_KMS_KEYFILE=/run/hara-secrets/kms-master.key \
  -v "$PWD/secrets/kms-master.key:/run/hara-secrets/kms-master.key:ro" \
  -e GATEWAY_ADAPTER=mock \
  ghcr.io/hara-cli/hara-control:0.1.11
```

Connection-string shape: `postgresql://<user>:<password>@<host>:<port>/<database>?schema=public`.
`HOST` is your Postgres host — a container name on a shared Docker network,
`host.docker.internal` for a DB on the host machine, or a managed endpoint.

> **Env:** the production minimum is `DATABASE_URL`, distinct `HARA_CONTROL_ADMIN_KEY` and
> `HARA_JWT_SECRET`, plus exactly one KMS root source. `GATEWAY_ADAPTER=mock` runs the control plane
> without the LiteLLM data plane. Formal managed AI additionally requires the isolated
> `LITELLM_DATABASE_URL`, master key and encrypted provider-key activation described in
> [`deploy/nanhara-tech/DEPLOY.md`](./deploy/nanhara-tech/DEPLOY.md).

## Status

- **Phase 0 — spike: ✅ done.** LiteLLM proxies Anthropic `/v1/messages` with streaming + tool calls
  end-to-end (see [`phase0/`](./phase0/)).
- **Phase 1 — MVP: ✅ implemented.** NestJS + Prisma + Postgres. Endpoints: `POST /v1/enroll`,
  `POST /v1/heartbeat` (device-facing, matches the CLI contract); `POST /admin/orgs`,
  `POST /admin/enroll-codes`, `GET /admin/fleet`, `POST /admin/devices/:id/revoke` (admin-key gated).
  Device tokens are gateway virtual keys behind the `GatewayAdapter` seam (LiteLLM in prod, an
  in-process mock for dev/test); only token **hashes** are stored. Production includes readiness,
  atomic one-time enrollment, data-plane TTL/model scoping, encrypted DeepSeek source-of-truth and a
  pinned LiteLLM runtime. **Pending hardening:** non-owner/forced RLS, external KMS adapters, signed
  audit checkpoints and live spend-cap wiring.

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
