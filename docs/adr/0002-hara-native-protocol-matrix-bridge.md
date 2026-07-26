# ADR-0002: Use a Hara-native centralized protocol

- Status: Accepted
- Date: 2026-07-26

## Context

Matrix and Synapse provide strong reference designs for rooms, membership,
events, incremental sync and local echo. They also solve federation, room
versioning, state resolution and device-key concerns that are not part of the
first Hara collaboration product.

Hara additionally needs hard tenant isolation, company switching, Agent runs,
tasks, approvals, model connections and Control integration. Mapping these
onto Matrix rooms would not remove the need for a Hara domain and projections.
It would instead add another primary data model and a larger failure surface.

The pinned Synapse and Element Web sources are AGPL/commercially licensed.
They are valid research material but are not a safe source to copy into a
closed hosted implementation without a separate license decision.

## Decision

Implement a centralized Hara protocol around `Realm`, `Community`, `Channel`,
`Event` and cursor-based sync. Reuse concepts proven by Matrix, but write an
independent implementation based on Hara requirements and documented
interfaces.

Matrix is an optional future bridge:

- `matrix-js-sdk` may be evaluated in the bridge repository under its
  Apache-2.0 terms.
- Synapse may be deployed separately when a customer explicitly requires
  federation and the selected AGPL or commercial-license obligations are met.
- Matrix events never become the primary Hara storage model.

M0 and M1 do not include federation, state-resolution DAGs or end-to-end
encryption. Encryption in transit, tenant isolation, authorization and audit
remain mandatory.

## Consequences

- The initial service is materially smaller and aligned with Hara agents and
  tasks.
- Hara owns protocol compatibility and migration.
- Federation is not available until an explicit bridge/product phase.
- Source-study documents must distinguish specification, upstream
  implementation and Hara recommendation; copying upstream implementation is
  prohibited without license review.
