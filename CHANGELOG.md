# Changelog

All notable changes to hara-control are documented in this file.

## 0.1.21 - 2026-08-22

### Fixed

- Preserve `image_url` content blocks for `deepseek-v4-flash-vision-exp` while retaining LiteLLM's native
  DeepSeek thinking and tool semantics. Deployment now applies an idempotent, exact-version and whole-file
  checksum-verified transform patch; any dependency drift fails closed instead of modifying unknown code.
- Keep the real three-object image-and-spend deployment probe introduced in 0.1.20. It now exercises the
  same native DeepSeek adapter used by organization devices and prevents a text-only HTTP 200 from being
  mistaken for working visual understanding.

## 0.1.20 - 2026-08-22

### Fixed

- Route `deepseek-v4-flash-vision-exp` through LiteLLM's generic OpenAI-compatible adapter. LiteLLM 1.92.0's
  native DeepSeek transform still flattens content arrays and silently removes `image_url` blocks; Flash,
  Pro, and their compatibility aliases remain on the native adapter so existing thinking behavior is unchanged.
- Replace the brittle 16-token RGB sampler release gate with a 512×512 three-object recognition probe. The
  gate now proves the image survived gateway conversion, verifies the semantic answer, records positive USD
  spend, and deletes the temporary virtual key before Control is promoted.

## 0.1.19 - 2026-08-21

### Added

- Add `deepseek-v4-flash-vision-exp` as the third managed DeepSeek model without changing the default
  from Flash. Enrollment and the localized administrator console now expose its 1M context, 384K output,
  full thinking dial, and explicit text-plus-image input capability.
- Require the production release gate to send an embedded red PNG through the managed visual route,
  verify the model observes `ff0000`, record positive LiteLLM spend, and delete the temporary key.

### Fixed

- Refresh DeepSeek budget accounting to the official 2026-08-21 peak USD rates. Flash and Vision-Exp use
  $0.44/M uncached input, $1.32/M output, and $0.014/M cache-hit input; Pro uses $1.32/M, $3.96/M, and
  $0.044/M respectively. The conservative peak rate prevents a fixed LiteLLM tariff from undercounting
  company budgets during peak hours; compatibility aliases receive the same correction.

### Security

- Override Prisma's vulnerable `deepmerge-ts` transitive pin with 8.0.0, eliminating the recursive-object
  stack-exhaustion advisory while retaining the existing Prisma 6 database and migration contract. Refresh
  the defensive `fast-uri` and `js-yaml` overrides to 3.1.5 and 4.3.1 so future dependency resolution cannot
  reintroduce their patched high-severity advisories.

## 0.1.18 - 2026-08-14

### Added

- Add reviewed, organization-scoped service bindings so administrators can manage tenant integrations and
  optionally provision an explicitly bound Hara Desk identity during enrollment without exposing the shared
  service credential to a device.
- Advertise the complete `off` / `low` / `high` / `max` thinking catalog for both DeepSeek V4 Flash and Pro
  in enrollment responses and the localized administrator console.

### Fixed

- Route every canonical and compatibility DeepSeek model through LiteLLM's native DeepSeek adapter and
  explicitly relay `thinking` plus `reasoning_effort`. The generic OpenAI adapter previously discarded these
  controls before the company request reached DeepSeek. Live gateway tests now prove all four states and
  reasoning-plus-tool-call streaming end to end.

### Security

- Keep service credentials server-side, scope bindings to their organization, validate upstream origins and
  capabilities, and preserve rollback/audit behavior when optional provisioning fails.

## 0.1.17 - 2026-08-05

### Added

- Let a SUPERADMIN explicitly issue a non-expiring personal device Key. The Key has no fixed
  date-based cutoff but remains restricted to the managed-model catalog, visible in fleet and usage
  reporting, governed by rolling budgets and rate limits, and immediately revocable.
- Add the same explicit lifetime choice to the administrator console with clear permanent-versus-
  finite status in English, Simplified Chinese, and Traditional Chinese.
- Persist reviewed skill capability declarations and grants per immutable asset version, and deny any
  execution capability that was not both declared by the skill and granted during review.

### Security

- Restrict non-expiring Key issuance to SUPERADMIN/shared-superadmin callers, reject conflicting
  finite and non-expiring lifetime fields, and require LiteLLM to confirm an authoritative null expiry
  before enrollment succeeds. Raw virtual Keys remain one-time delivery secrets; Control stores only
  their hashes and non-secret aliases.
- Keep one-time enrollment codes independently short-lived and single-use even when the resulting
  device Key is non-expiring.

## 0.1.16 - 2026-07-31

### Added

- Let an organization optionally bundle Hara Desk into the same one-time Control enrollment. Control
  keeps the shared Desk enrollment secret server-side and returns a separately scoped per-device Desk
  bearer, so employees configure the organization once and receive its model route and Desk together.

### Security

- Validate organization Desk origins, reject redirects and credential-bearing URLs, bound registration
  responses, and keep upstream errors and enrollment secrets out of audit records.
- Roll back the model key, device record, and one-time code if configured Desk provisioning fails, and
  record a sanitized compensating audit event instead of leaving a partially enrolled organization.
- Remove the unused Nest CLI build wrapper and invoke TypeScript/tsx directly, eliminating its vulnerable
  brace-expansion development dependency while retaining clean builds, production start, and watch mode.

## 0.1.15 - 2026-07-24

### Fixed

- Authorize every managed model on one device key, treating the enrollment form's model choice as the
  connection default rather than a separate credential boundary. A colleague can now switch between
  DeepSeek V4 Flash and V4 Pro through the same Hara Control connection without replacing the Token.
- Reconcile already-issued single-model LiteLLM keys in place during an authenticated heartbeat and
  return the current model/thinking catalog. The CLI persists that catalog only when the response still
  belongs to the same profile and credential, so a late heartbeat cannot overwrite a re-enrollment.
  Older devices retain their already-bound `deepseek-chat` or `deepseek-pro` alias as a hidden
  compatibility route while new clients see only the canonical V4 catalog.
- Attribute usage breakdowns to the model recorded by LiteLLM instead of the connection default, while
  keeping expiry, rolling budgets, RPM, and TPM limits aggregated on the same device key.

## 0.1.14 - 2026-07-23

### Added

- Publish a server-authoritative managed-model catalog for administrators and replace the enrollment
  console's free-text model alias with explicit DeepSeek V4 Flash and V4 Pro choices, including their
  context, output, and supported thinking levels.
- Return the enrolled key's `available_models` and `thinking_efforts` capability lists so newer CLI and
  Desktop clients can render only controls the server-authorized model actually supports.

### Changed

- Issue new device keys with DeepSeek's canonical `deepseek-v4-flash` or `deepseek-v4-pro` model ID.
  Existing `deepseek-chat` and `deepseek-pro` keys remain routed and priced for backward compatibility,
  while old unused enrollment codes are canonicalized when redeemed.
- Use canonical V4 model IDs in readiness and key-policy probes, and gate production deployment on
  separate paid, metered requests through both Flash and Pro routes shown in the administrator console.

## 0.1.13 - 2026-07-23

### Fixed

- Compare every LiteLLM usage range and rolling-budget boundary as an explicit UTC wall-clock
  timestamp, so a non-UTC PostgreSQL session cannot shift the 5-hour quota window by its local offset.

## 0.1.12 - 2026-07-23

### Added

- Add an organization-scoped admin usage dashboard with 24-hour, 7-day, and 30-day spend/token/request
  charts, per-device/model breakdowns, and live 5-hour / weekly / monthly quota progress.
- Let administrators create enrollment codes in the console with explicit key lifetime, USD budgets,
  RPM, and TPM limits; configured limits remain visible when the authoritative ledger is unavailable.

### Fixed

- Configure explicit official DeepSeek V4 Flash/Pro input, output, and cache-read prices so successful
  requests record positive USD spend and rolling 5-hour / 7-day / 30-day budgets can decrement.
- Refuse to issue USD-limited keys when a selected LiteLLM model has missing or zero pricing, include
  managed-model pricing in readiness, and gate production deployment on a temporary paid spend probe.
- Send the documented `parentId` field when creating a nested organization from the admin console.

## 0.1.8 - 2026-07-22

### Fixed

- Preserve the managed `.litellm-venvs/` directory in both release rollback archives and source
  `rsync --delete`. Deployments no longer compress gigabytes of reproducible Python runtimes or
  discard the already verified pinned LiteLLM environment before startup.

## 0.1.7 - 2026-07-22

### Fixed

- Synchronize the isolated LiteLLM database from the exact pinned 1.92.0 `schema.prisma` before
  startup. The deploy previews the generated SQL, refuses destructive operations, applies `db push`
  without `--accept-data-loss`, and requires a zero-drift recheck.
- Disable LiteLLM's own best-effort runtime schema mutation after the verified deploy-time sync, so
  a failed migration cannot leave a seemingly online proxy backed by an incompatible Key schema.
- Make `/health/ready` exercise the authenticated, read-only `/key/list` path in addition to process
  liveliness, covering the same Key-management tables required by enroll and revoke.
- Point the documented production Control and LiteLLM URLs at the replacement Aliyun RDS host while
  preserving separate `public` and `litellm` schemas.

## 0.1.6 - 2026-07-20

### Fixed

- Install and verify the exact Python Prisma runtime required by the pinned LiteLLM 1.92.0 proxy
  before production services may switch.
- Fingerprint managed LiteLLM virtual environments by the full production requirements file so a
  dependency-only correction cannot silently reuse an incomplete environment.
- Recognize PM2's ESM import execution path in the checked environment wrapper; the wrapper now
  launches its supervised child instead of appearing online with no data-plane process.
- Build Python virtual environments at their final immutable path before activation so generated
  console entrypoints keep valid absolute shebangs; incomplete runtimes now fail closed.
- Generate and instantiate the pinned Prisma Python client during runtime assembly, matching
  LiteLLM's official image build instead of discovering missing binaries after PM2 starts.
- Run Prisma client generation from an isolated temporary directory with a minimal environment so
  it cannot auto-load Hara's production `.env` while assembling the data-plane runtime.

## 0.1.2 - 2026-07-13

### Security

- Block the complete IPv6 link-local `fe80::/10` range in SSRF destination validation.
- Upgrade NestJS Express integration to 11.1.28, resolving the production Multer denial-of-service advisories.

### Release

- Verify clean installs, production dependency audits, tests, builds, Prisma schema validity, and tag/version consistency before publishing container images.
- Pin the production image examples to `ghcr.io/hara-cli/hara-control:0.1.2`.
