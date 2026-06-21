# hara-control — decision record

## Open-core boundary (2026-06-22)

- **hara CLI** = Apache-2.0 OSS, free for C-end individual use. It's the funnel.
- **hara-control** (this repo) = **closed-source, proprietary, Nanhara-owned**. Only organizations
  (B-end) need a fleet control plane. Delivered as on-prem license or managed SaaS.
- Rationale: the open part (the whole CLI) is already a complete product for an individual, so the
  control plane doesn't need to be open. Self-deployment ≠ open source — closed software is routinely
  self-hosted under license; a customer demanding a source audit can get it under NDA without changing
  the license. No BSL/source-available gymnastics needed.

## Data plane vs control plane

- **Data plane = bought/embedded** (LiteLLM, Python sidecar behind a thin adapter). Protocol
  translation, routing to N upstreams (cloud + customer self-hosted), streaming, retries, upstream-key
  vault. Commodity; zero differentiation; do not fork.
- **Control plane = built + 100% owned** (this repo). Enrollment, token lifecycle, fleet view,
  governance, audit, multi-tenancy. The product / moat / paid layer.

## Stack

- **Server: NestJS** — team already runs Nest (yimatrix-server); guards/DI/modules fit the
  RBAC/multi-tenant/SSO/audit roadmap, which gets messy in a micro-framework.
- **ORM: Prisma.**
- **DB: PostgreSQL, directly (no SQLite tier).** Decisive reason: **LiteLLM is Postgres-native**
  (virtual keys / spend / budgets) — sharing one Postgres lets the fleet usage view `JOIN` the device
  registry against LiteLLM's spend tables, no cross-DB ETL. Plus JSONB (policy / routing config /
  audit payloads), RLS (first-class multi-tenant isolation — MySQL has no equivalent), and extensions
  (TimescaleDB for usage time-series, pgvector for future asset search). SQLite is skipped because we
  rely on JSONB + RLS, which a SQLite dev tier can't emulate — it would diverge from prod.
- Company's existing **MySQL** production DBs are unrelated and untouched; hara-control's Postgres is
  its own.
- **Shared protocol types: `@nanhara/hara-protocol`** (enroll / heartbeat / token DTOs) live on the
  open CLI side; this closed server depends on the open package. Open contract, closed implementation.

## Phase 0 spike — ✅ PASS (2026-06-22)

Validated the #1 risk: LiteLLM proxies Anthropic `/v1/messages` with **streaming + tool calls**
end-to-end against an OpenAI-compatible upstream. See [`phase0/`](../phase0/).

**Mandatory config finding:** `litellm_settings.use_chat_completions_url_for_anthropic_messages: true`
— LiteLLM defaults `/v1/messages` for `openai/` providers to the Responses API (`/v1/responses`),
which DashScope/Qwen/GLM compatible-mode don't expose. Without this flag, `/v1/messages` 404s.

## Roadmap

- **Phase 0** — spike (done).
- **Phase 1** — MVP: device enroll → token issue/revoke, device registry, heartbeat ingest,
  read-only fleet view. NestJS + Prisma + Postgres; LiteLLM via docker-compose.
- **Phase 2** — hardening: OIDC/SSO enrollment, short-lived JWT + refresh, RBAC, immutable audit,
  one-click revoke, alerts, data-residency policy.
- **Phase 3** — multi-tenant SaaS: many orgs (Postgres RLS), managed gateway, policy push-down,
  usage analytics / chargeback.
