# syntax=docker/dockerfile:1
#
# hara-control — the open-source control plane (NestJS + Prisma/Postgres). It ships as a CONTAINER IMAGE,
# not an npm package: it's a stateful service, so `docker run` / compose is what self-hosters want (unlike
# hara-cli/hara-design, which are npm packages). Published to GHCR on a version tag by
# .github/workflows/publish-image.yml — mirroring hara-cli's tag→CI flow, with an image as the artifact.

# ---- builder: install all deps, generate the Prisma client, compile Nest → dist/ ----
FROM node:22-slim AS builder
WORKDIR /app
# Prisma needs OpenSSL to detect its engine target at generate time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Install against the lockfile first (better layer caching). The schema is needed for `prisma generate`,
# so copy it before installing.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
# Now the rest of the source, then compile.
COPY . .
RUN npm run build

# ---- runtime: compiled app + generated client + static console ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HARA_ENV_LOADED=container \
    PORT=4100 \
    HOST=0.0.0.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Carry node_modules from the builder — it holds the generated @prisma/client + its native query engine AND
# the prisma CLI (needed for `migrate deploy` at boot). The engine binary must match the base image; both
# stages are node:22-slim, so it does. (Regenerating in a prod-only tree is fiddlier than copying.)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
COPY package.json ./
EXPOSE 4100
# On boot: apply pending migrations (idempotent), then start. Override CMD to skip auto-migrate if you run
# migrations out-of-band. DATABASE_URL / HARA_CONTROL_ADMIN_KEY etc. come from the environment.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
