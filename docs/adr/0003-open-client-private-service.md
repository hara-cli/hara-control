# ADR-0003: Keep the client open and the hosted collaboration service private

- Status: Accepted
- Date: 2026-07-26

## Context

Hara CLI, Hara Desktop and `hara-control` are already distributed under
Apache-2.0. Existing license grants cannot be withdrawn from versions already
released. A private cloud service does not make an open client incoherent:
the service contains hosted identity, multi-tenant storage, moderation,
operations and commercial entitlements that are not required to run local
Hara.

Maintaining separate open Free and closed Pro desktop forks would duplicate
update, signing, security and regression work and would encourage the two
clients to drift.

## Decision

Use this boundary:

```text
Apache-2.0
├── Hara CLI
├── Hara Desktop free shell
├── hara-control
├── public collaboration protocol/schema
└── public client and conformance packages

Proprietary / commercial
├── hara-account-service
├── hara-collab server and managed operations
├── private Desktop capability plugins
└── enterprise self-hosted collaboration package
```

Keep one public Desktop shell. Pro capabilities are loaded through explicit
capability and entitlement boundaries; public packages must never import a
private server package. The UI must explain unavailable capabilities and
continue to work locally without a Pro account.

Use named grants such as:

```text
collab.hosted.basic
collab.bridge.feishu
collab.enterprise.sso
collab.retention.custom
collab.audit.export
collab.selfhost
```

Commercial capabilities may include hosted capacity/SLA, SSO/SCIM, managed
enterprise bridges, custom retention/legal hold, advanced audit export, DLP
and enterprise self-hosting.

The following are baseline security and user rights, not paywalls:

- tenant isolation and basic roles;
- transport security and security fixes;
- data export and deletion;
- prevention of cross-realm disclosure;
- approval for high-risk Agent actions.

## Consequences

- Local Hara remains useful with no Hara cloud dependency.
- One Desktop updater and security path serves Free and Pro users.
- Private code and secrets stay in private repositories and build inputs.
- Public releases require license notices, dependency allowlists, SBOM and
  provenance.
- A commercial EULA and trademark policy are separate legal deliverables.

This ADR records a product and engineering boundary, not legal advice.
