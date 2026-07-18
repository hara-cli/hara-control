# hara-control — decision record

## Open-core boundary (2026-07-18, current)

- **hara CLI** = Apache-2.0 OSS, free for C-end individual use. It's the funnel.
- **hara-control** (this repo) = **Apache-2.0 self-hosted control core**. Its public repository and
  historical `LICENSE` have already granted Apache rights; package metadata and product documentation
  must agree with that fact.
- Open here: device enrollment, token revoke, single-organization fleet, three-role RBAC, basic
  policy, local audit, protocol and self-host deployment.
- Private elsewhere: Nanhara-operated hosting, regional account/order/entitlement services,
  marketplace operations, SSO/SCIM, DLP, private catalog, centralized audit retention/export and SLA.
- Rationale: safety and self-host foundations should remain inspectable and useful without an account.
  Commercial value comes from reliable operation, scale governance, integrations and curated content,
  not from contradicting an already-public license.

The 2026-06-22 proposal to keep this implementation proprietary is superseded by this decision. It
was never consistent with the repository's public Apache-2.0 LICENSE and must not be used to claim
that existing Apache grants can be withdrawn.

## Data plane vs control plane

- **Data plane = bought/embedded** (LiteLLM, Python sidecar behind a thin adapter). Protocol
  translation, routing to N upstreams (cloud + customer self-hosted), streaming, retries, upstream-key
  vault. Commodity; zero differentiation; do not fork.
- **Control core = built in the open** (this repo). Enrollment, token lifecycle, fleet view, baseline
  governance and local audit.
- **Hosted/enterprise plane = built privately in separate repositories.** Regional services,
  managed operation, organization-scale governance and commercial content are the paid layer.

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
  open CLI side; this open server depends on the open package. Private services consume released
  public contracts and never copy private implementation back into the public repository.

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
