# ADR-0001: Run collaboration as an independent NestJS service

- Status: Accepted
- Date: 2026-07-26

## Context

`hara-control` is the open-source, installation-scoped control plane for one
company or group. Chat is a multi-tenant, high-write workload with different
availability, data-retention, release and security boundaries. Putting chat
inside `hara-control` would couple ordinary messaging to model governance and
would blur the boundary between an organization tree and a collaboration
realm.

The team already operates NestJS, Prisma and PostgreSQL. NestJS provides a
consistent module, guard, interceptor and dependency-injection model for
membership, authorization, audit, rate limiting and bridge adapters.

## Decision

Create a separate private service and repository named `hara-collab`.

```text
hara-account-service
  Account / Tenant / TenantMembership / login / SSO
  issues realm-scoped context tokens and publishes membership changes

hara-collab
  Realm / Principal / Community / Channel / Membership
  Event / Message / Task / File / Sync / Notification / Bridge

hara-control
  OrgUnit / Device / ModelConnection / Budget / Agent governance
```

`hara-collab` will use NestJS 11 and PostgreSQL. Prisma handles ordinary
entities and projections; small, reviewed parameterized SQL modules handle
event ordering, outbox claims, RLS and database-native search where Prisma is
not the right abstraction.

Services do not share writable databases. Account is the source of truth for
human identity and tenant membership. Collab validates account tokens locally
with JWKS and updates its authorization projection from durable membership
events; sending a message must not require a synchronous Account request.
Control resources are referenced only by stable external IDs.

PostgreSQL is the M0/M1 source of truth. WebSocket is a wake-up signal;
`/sync(cursor)` is the authoritative recovery path. Kafka, Redis and a separate
search cluster are not M0 dependencies.

## Consequences

- A Control or Agent outage does not take down human chat.
- A Collab outage does not change local Hara sessions, models or Control.
- Schema, backups and scaling can follow the message workload independently.
- Cross-service identity, token and outbox contracts must be explicit.
- Deployment has one additional service and database to operate.

## Rejected alternatives

- Add chat modules to `hara-control`: rejected because it couples fault,
  license, tenancy and storage boundaries.
- Start with microservices per chat subsystem: rejected because it creates
  operational complexity before the message flow is proven.
