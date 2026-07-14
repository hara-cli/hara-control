# Repository Guidelines

## Project Structure & Module Organization

NestJS code lives in `src/`, grouped into feature modules such as `enroll/`, `auth/`, `assets/`, and `security/`. Prisma schema and migrations are under `prisma/`; tests are in `test/`, with operational checks in `scripts/`. The static console lives in `public/console/`, deployment examples in `deploy/`, and design notes in `docs/` and `HARDENING.md`. Never edit generated `dist/` files.

## Build, Test, and Development Commands

- `npm ci` installs dependencies from `package-lock.json`.
- `npm run start:dev` runs the NestJS server in watch mode on port 4100 by default.
- `npm run build` type-checks and compiles production code into `dist/`.
- `npm test` runs offline TypeScript tests with Node and `tsx`.
- `npm run prisma:generate` regenerates the Prisma client after schema changes.
- `npm run prisma:migrate -- --name <change>` creates and applies a development migration.
- `npm run build && bash scripts/e2e.sh` starts Docker Postgres, migrates it, and exercises the live API.

## Generated Artifacts & Deployment Boundary

Never hand-edit `dist/` or generated Prisma client files. Schema changes belong in `prisma/schema.prisma` with a reviewed migration in `prisma/migrations/`; regenerate the client with `npm run prisma:generate`. Treat `public/console/` as source, not generated output.

Before release, run `npm test`, `npm run build`, `npx prisma validate` with a non-production validation URL, and the live `scripts/e2e.sh` gate when Docker/Postgres is available. A pushed `vX.Y.Z` tag matching `package.json` authorizes the workflow to build and publish `ghcr.io/hara-cli/hara-control`; ordinary branch and pull-request runs only verify. Do not tag or manually dispatch a production image without release authorization, and verify the resulting image before announcing deployment.

## Coding Style & Naming Conventions

TypeScript is strict: avoid `any`, preserve null checks, and keep dependencies explicit. Use two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Use `PascalCase` for classes and DTOs, `camelCase` for variables and methods, and NestJS filenames such as `roles.controller.ts` or `org-tree.service.ts`. No formatter or linter is configured; follow neighboring code and run `npm run build`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name offline tests `test/<feature>.test.ts`; reserve `.mjs` for live end-to-end scenarios. Add a focused regression test for behavior or security fixes. Keep unit tests deterministic with fake Prisma or gateway dependencies. There is no coverage threshold, but exercise changed branches and failure paths.

## Commit & Pull Request Guidelines

Recent commits use imperative subjects with prefixes such as `feat:`, `fix(security):`, `docs(auth):`, `security:`, and `release:`. Keep commits focused. Pull requests should explain behavior, security, and schema impact; link the issue/report; list validation commands; and include console screenshots for UI changes. Commit Prisma migrations and document new environment variables.

## Security & Hara Issue Workflow

Copy `.env.example` locally; never commit credentials, enrollment keys, signing material, database URLs, bearer tokens, or authorization headers. Preserve tenant, RBAC, audit, proxy, and token-revocation boundaries; use synthetic credentials in tests and examples.

Before handling a Hara issue, pull the newest messages and relevant attachments from Feishu group `hara 反馈群` (`oc_17590648f393135cde6a6b9cd6f1c710`). Report discovered bugs there with product version, reproduction/evidence, and expected versus actual behavior, with every secret redacted. After a verified release/deployment, reply to each original fixed report with the fixed version and focused checks, then send the group-level version/image, concise changes, applicable upgrade command, and requested verification; mention the named tester when applicable.
