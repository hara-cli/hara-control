# ADR-0006: Issue company device access through authenticated approval

- Status: Proposed
- Date: 2026-09-03

## Context

The current company enrollment flow starts with an administrator-created one-time code. It can safely
mint a person-bound device credential, but the administrator still has to coordinate delivery outside
Hara. That is awkward for ordinary employee onboarding, makes identity mistakes easier, and encourages
people to talk about a reusable "company API key" even though the intended object is revocable access for
one accountable person and device.

Hara Desktop already separates Personal/BYOK model connections from company-managed connections. A user
who already has a company account should be able to enter the company's Control URL, authenticate, request
model access, and wait for an administrator's policy decision without receiving a provider key in Feishu,
email, the clipboard, or a support conversation.

## Decision

Add an opt-in, approval-based company connection flow:

1. The user enters an HTTPS Hara Control origin in Desktop. Desktop performs a non-secret discovery request
   and opens the system browser for the deployment's configured sign-in method. Desktop must not collect the
   user's company password.
2. Authentication uses Authorization Code with PKCE or an equivalently phishing-resistant device flow.
   The callback establishes the existing account, organization membership, and stable `Person` identity.
   Short-lived session material is stored only in the operating-system credential store.
3. Desktop submits an idempotent access request for the current person and device. The user-facing action is
   **Request company model access**, not **Show/create API key**. A request may include a purpose, requested
   model set, and desired duration, but cannot choose a provider credential or bypass organization policy.
4. Control records the request as `PENDING`, `APPROVED`, `DENIED`, `CANCELLED`, `EXPIRED`, or `REVOKED` and
   exposes it to authorized administrators. Approval fixes the server-owned model allow-list, expiry,
   rolling budgets, RPM/TPM limits, and any required team or role assignment.
5. After approval, Control mints one person- and device-bound gateway credential. The raw credential is
   returned exactly once over the authenticated device session and is written directly to the operating-
   system credential store. It must never enter renderer state, analytics, logs, audit payloads, Feishu,
   email, or the clipboard. Control stores only the one-way token hash, non-secret key ID, policy, and
   lifecycle metadata.
6. Desktop shows approval state, authorized models, quota usage, expiry, and last activity. Control can
   revoke access immediately, and both active and deleted/expired credentials remain visible as historical
   records with their usage. Revocation never restores or displays the raw credential.

Every request must resolve to a `Person` in the same organization before approval. Device names are
diagnostic labels, not identity. Approval and issuance are separate, audited transitions with replay and
double-issuance protection. A company may require manual approval, configure policy-based auto-approval,
or disable self-service entirely.

This flow issues only Hara's internal gateway device credential. It never creates, returns, or delegates
the upstream DeepSeek, Ark, Anthropic, or other provider credential. Personal/BYOK connections remain local
and independent of company approval.

The existing administrator-created enrollment-code flow remains available initially for migration and
break-glass recovery, but it is not the preferred employee onboarding path once authenticated requests are
available.

## Security and protocol requirements

- Require TLS and reject credentials, query strings, fragments, redirects to untrusted origins, and private-
  origin changes after discovery.
- Bind authorization callbacks to PKCE, `state`, the exact Control origin, and an expiring Desktop request.
- Keep account sessions and issued device credentials in separate scopes and storage entries.
- Require fresh authorization for issuance and make the approval-to-credential exchange single-use and
  idempotent.
- Never expose a raw provider key or a previously issued device credential through list, history, support,
  or recovery APIs.
- Audit request creation, approval/denial, issuance, policy changes, expiration, and revocation without
  logging tokens, authorization headers, prompts, responses, or private user content.
- Preserve tenant boundaries: organization administrators can review only requests in their organization;
  global operators do not silently impersonate applicants.

## Consequences

- Employees onboard from Desktop with their own identity instead of receiving a plaintext secret from an
  administrator.
- Company usage, revocation, and historical records are attributable to a person and device from the first
  request.
- Control needs new request-state APIs, approval UI, browser authentication, Desktop secure-storage work,
  and end-to-end tests for denial, expiry, replay, revocation, and organization isolation.
- The current key-rotation incident remains an operations task: authenticated self-service cannot issue a
  usable device credential while the company's upstream provider credential is invalid.

## Delivery boundary

This ADR records the target design only. It does not authorize issuing new company credentials and is not
part of Hara CLI 0.164.2 or Desktop 0.1.141. Implementation requires a separately reviewed schema/API
change and a later Desktop release.
