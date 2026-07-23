# Changelog

All notable changes to hara-control are documented in this file.

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
