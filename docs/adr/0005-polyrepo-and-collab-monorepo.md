# ADR-0005: Keep product repositories separate

- Status: Accepted
- Date: 2026-07-26

## Context

CLI, Desktop, Control, Account and Collaboration have different licenses,
release cadences, deployment targets and secret boundaries. Moving all of them
into one repository would weaken those boundaries without solving protocol
compatibility.

Collaboration itself has several tightly coupled deployables and domain
packages that should be changed atomically during its early development.

## Decision

Keep the Hara product as a polyrepo. Create a private `hara-collab` repository
with a small internal workspace:

```text
hara-collab/
├── apps/
│   ├── api/
│   ├── worker/
│   └── migration-cli/
├── packages/
│   ├── domain/
│   ├── authorization/
│   ├── persistence/
│   ├── bridge-core/
│   ├── observability/
│   └── testkit/
└── prisma/
```

M0 may scaffold only the API and domain packages; empty directories are not a
requirement. Add Worker and migration code when a walking slice needs them.

Publish the protocol separately once its first vertical slice stabilizes:

```text
hara-protocol/                  # Apache-2.0
├── openapi/collab-v1.yaml
├── schema/events/
├── packages/typescript-client/
└── packages/conformance/
```

All consumers depend on released public protocol artifacts:

```text
private hara-collab ──┐
hara-control ─────────┼──> public hara-protocol
hara-cli/Desktop ─────┘

public repository ─X─> private server package
```

## Consequences

- License, signing and secrets remain isolated.
- API compatibility is enforced by conformance tests instead of source-level
  imports.
- Cross-repository protocol changes require versioned releases and rollout
  planning.
- The private service can use a workspace without forcing the whole Hara
  product into a super-monorepo.
