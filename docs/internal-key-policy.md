# Internal key access policy

Hara Control issues a short-lived, revocable LiteLLM virtual key when a colleague exchanges a one-time
enrollment code. An administrator can attach an immutable access policy to that code before handing it
out. The raw virtual key is returned once to the device; Hara Control stores only its SHA-256 hash and
the non-secret gateway key identifier.

## Supported limits

| Control field | Meaning | Data-plane value |
|---|---|---|
| `tokenTtlMinutes` | Key lifetime; 5 minutes through 365 days | LiteLLM key `duration` |
| `budgetLimits[].window = "5h"` | Maximum USD spend in each rolling 5-hour window | `5h` |
| `budgetLimits[].window = "week"` | Maximum USD spend in each rolling 7-day window | `7d` |
| `budgetLimits[].window = "month"` | Maximum USD spend in each rolling 30-day window | `30d` |
| `rpmLimit` | Optional requests per minute | `rpm_limit` |
| `tpmLimit` | Optional tokens per minute | `tpm_limit` |

The week and month labels are rolling durations measured from the key's issue/reset lifecycle. They are
not calendar-week or calendar-month accounting. Up to one limit per window can be active at the same
time. Omitting a budget or rate field leaves that dimension unlimited; the default key lifetime remains
seven days. Every limit applies to the device key as a whole, aggregated across all models used through
that one managed connection.

## Create a limited enrollment code

The admin console exposes the same fields under the enrollment-code form. The API equivalent is:

```http
POST /admin/enroll-codes
Content-Type: application/json
X-Admin-Key: <admin credential>

{
  "orgId": "<organization id>",
  "model": "deepseek-v4-flash",
  "tokenTtlMinutes": 43200,
  "budgetLimits": [
    { "window": "5h", "maxUsd": 2 },
    { "window": "week", "maxUsd": 20 },
    { "window": "month", "maxUsd": 60 }
  ],
  "rpmLimit": 30,
  "tpmLimit": 120000
}
```

`model` selects the connection's initial default. It does not mint a model-specific credential: the
resulting device key is authorized for the deployment's complete managed-model catalog, such as
`deepseek-v4-flash` and `deepseek-v4-pro`. A user switches models inside the same CLI/Desktop connection
without replacing the key.

The response returns the one-time code, its exchange expiry, and the normalized `accessPolicy`. Treat the
code as a credential: deliver it only to its intended colleague, never put it in chat logs, and let it be
consumed once.

## Enforcement and failure behavior

1. Hara Control validates and stores the normalized policy with the one-time code.
2. Enrollment atomically claims the code and requests one LiteLLM key authorized for every managed model,
   with the exact expiry, three rolling budget windows, RPM, and TPM values.
3. Before a USD-limited key is minted, Hara requires every LiteLLM deployment behind every authorized alias to
   report positive input and output prices. Missing, zero, or unreadable pricing fails closed because a
   dollar ceiling cannot be enforced against zero-cost accounting.
4. LiteLLM must return the authoritative expiry and confirm every requested limit. A missing, changed, or
   malformed limit causes enrollment to fail closed; Hara Control revokes the possibly-created alias and
   restores the one-time code for a safe retry.
5. The immutable policy is copied to `DeviceToken` and returned to the enrolling client. The fleet API and
   admin console show expiry and configured limits without revealing the token.
6. Expired keys are excluded from the active fleet view. Explicit device revoke invalidates the key in both
   the control plane and LiteLLM.
7. On an authenticated heartbeat, Control reconciles older single-model keys in place by private alias and
   returns the current authorized catalog. The raw device token never needs to be reissued or sent back.
   If that device was originally bound to a pre-V4 model alias, the alias remains authorized but hidden
   from the new catalog so an older CLI keeps working until it upgrades.

## Fleet spend integrity

Hara never stores the raw LiteLLM virtual key after enrollment, so fleet usage must not call an endpoint
that requires that raw key. In a formal LiteLLM deployment, usage collection reads only `key_alias` and
`spend` from the isolated `litellm.LiteLLM_VerificationToken` table in the shared PostgreSQL database.
Alias filters are parameterized, and neither the token column nor provider credentials are selected by
usage queries. The separate in-place model-policy reconciliation path may read LiteLLM's one-way 64-hex
token identifier for exactly one private alias and submit it to the master-authenticated internal
`/key/update` endpoint; it never returns, logs, or copies that identifier into Hara storage.

The fleet response includes `spend_available`. A real zero is returned as `spend: 0` with
`spend_available: true`; a missing/unreadable authoritative source is `spend: null` with
`spend_available: false`. The console renders the latter as unavailable rather than a misleading
`$0.00`. Production readiness also checks that the isolated alias/spend columns are readable, so schema
or permission drift fails closed before a deployment is declared healthy.

The console's **Usage** view reads `GET /admin/usage?orgId=<id>&range=24h|7d|30d`. It displays the
authoritative USD spend, prompt-plus-completion tokens, request counts, last activity, device/model
breakdowns, and active-key quota progress. The query selects only parameterized aliases and aggregates
from LiteLLM's isolated ledger; it never returns raw virtual keys, prompts, responses, authorization
headers, or requester IP addresses. An organization-scoped admin can only read its assigned organization.
If the ledger query fails, totals and charts become unavailable while configured limits remain visible.
Because LiteLLM records `endTime` as a UTC wall clock without a PostgreSQL time-zone type, every range
boundary is explicitly projected to UTC before comparison; the database session's local time zone must
not change 5-hour, 7-day, or 30-day quota progress.

Production readiness also checks positive pricing for every managed model. The deployment gate performs a
minimal paid request with a temporary virtual key and requires both a spend-log row and positive recorded USD
spend before declaring the release healthy; the temporary key is deleted even if the check fails.

Internal access policy is distinct from upstream provider-key management. Multiple encrypted upstream
connections, key-pool routing, weights, and provider health are a separate control-plane feature; changing
an internal colleague limit must not rotate or expose any provider credential.
