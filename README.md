# hara-control

> **Proprietary — © 无锡南荒科技 (Nanhara). All rights reserved.** Not open source.
> This is the closed-source **control plane** for the [hara](https://github.com/hara-cli/hara) fleet.
> The hara **CLI** is Apache-2.0 OSS and free for individual (C-end) use; `hara-control` is the
> commercial B-end product that organizations license to run a managed fleet.

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
**bought/embedded engine** — **LiteLLM**, run as a black-box sidecar behind a thin adapter. We build and
100%-own the control plane (the product / moat / paid layer); we do not fork the engine.

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
Phase 3 multi-tenant SaaS.
