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
seven days.

## Create a limited enrollment code

The admin console exposes the same fields under the enrollment-code form. The API equivalent is:

```http
POST /admin/enroll-codes
Content-Type: application/json
X-Admin-Key: <admin credential>

{
  "orgId": "<organization id>",
  "model": "deepseek-chat",
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

The response returns the one-time code, its exchange expiry, and the normalized `accessPolicy`. Treat the
code as a credential: deliver it only to its intended colleague, never put it in chat logs, and let it be
consumed once.

## Enforcement and failure behavior

1. Hara Control validates and stores the normalized policy with the one-time code.
2. Enrollment atomically claims the code and requests a model-scoped LiteLLM key with the exact expiry,
   three rolling budget windows, RPM, and TPM values.
3. LiteLLM must return the authoritative expiry and confirm every requested limit. A missing, changed, or
   malformed limit causes enrollment to fail closed; Hara Control revokes the possibly-created alias and
   restores the one-time code for a safe retry.
4. The immutable policy is copied to `DeviceToken` and returned to the enrolling client. The fleet API and
   admin console show expiry and configured limits without revealing the token.
5. Expired keys are excluded from the active fleet view. Explicit device revoke invalidates the key in both
   the control plane and LiteLLM.

## Fleet spend integrity

Hara never stores the raw LiteLLM virtual key after enrollment, so fleet usage must not call an endpoint
that requires that raw key. In a formal LiteLLM deployment, Control reads only `key_alias` and `spend`
from the isolated `litellm.LiteLLM_VerificationToken` table in the shared PostgreSQL database. Alias
filters are parameterized, and neither the token column nor provider credentials are selected.

The fleet response includes `spend_available`. A real zero is returned as `spend: 0` with
`spend_available: true`; a missing/unreadable authoritative source is `spend: null` with
`spend_available: false`. The console renders the latter as unavailable rather than a misleading
`$0.00`. Production readiness also checks that the isolated alias/spend columns are readable, so schema
or permission drift fails closed before a deployment is declared healthy.

Internal access policy is distinct from upstream provider-key management. Multiple encrypted upstream
connections, key-pool routing, weights, and provider health are a separate control-plane feature; changing
an internal colleague limit must not rotate or expose any provider credential.
