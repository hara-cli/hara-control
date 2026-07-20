# Changelog

All notable changes to hara-control are documented in this file.

## 0.1.6 - 2026-07-20

### Fixed

- Install and verify the exact Python Prisma runtime required by the pinned LiteLLM 1.92.0 proxy
  before production services may switch.
- Fingerprint managed LiteLLM virtual environments by the full production requirements file so a
  dependency-only correction cannot silently reuse an incomplete environment.

## 0.1.2 - 2026-07-13

### Security

- Block the complete IPv6 link-local `fe80::/10` range in SSRF destination validation.
- Upgrade NestJS Express integration to 11.1.28, resolving the production Multer denial-of-service advisories.

### Release

- Verify clean installs, production dependency audits, tests, builds, Prisma schema validity, and tag/version consistency before publishing container images.
- Pin the production image examples to `ghcr.io/hara-cli/hara-control:0.1.2`.
