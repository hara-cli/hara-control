#!/usr/bin/env bash
# Deploy / refresh the gw.nanhara.tech TEST control plane on the `ai` box. Idempotent.
# Run ON the box from the repo root:  bash deploy/nanhara-tech/deploy-ai.sh
# Prereqs (all present on `ai` as of 2026-06-23): docker+compose, node>=20, nginx, certbot. pm2 auto-installed.
# This does NOT touch DNS, the cert, or nginx — those are one-time steps in DEPLOY.md.
set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
PM2_NAME="${PM2_NAME:-hara-control}"
COMPOSE="docker compose -f docker-compose.yml -f deploy/nanhara-tech/docker-compose.prod.yml"

cd "$APP_DIR"
[ -f .env ] || { echo "✗ $APP_DIR/.env missing — cp deploy/nanhara-tech/.env.prod.example .env and fill it"; exit 1; }
command -v node >/dev/null || { echo "✗ node not found (need >=20)"; exit 1; }

# Parse/validate .env without executing it as shell. Re-enter once with the checked variables.
if [ "${HARA_ENV_LOADED:-}" != "1" ]; then
  node scripts/bootstrap-production-security.mjs "$APP_DIR/.env"
  exec node scripts/with-production-env.mjs "$APP_DIR/.env" -- bash "$0" "$@"
fi

PM2_REQUIRED_VERSION="6.0.14"
PM2_BIN="$(command -v pm2 2>/dev/null || true)"
PM2_CLI_VERSION=""
if [ -n "$PM2_BIN" ]; then
  PM2_CLI_VERSION="$(
    env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" PATH="$PATH" \
      "$PM2_BIN" --version 2>/dev/null | tail -n 1 | tr -d '\r'
  )"
fi
if [ "$PM2_CLI_VERSION" != "$PM2_REQUIRED_VERSION" ]; then
  echo "… installing pinned pm2 ${PM2_REQUIRED_VERSION}"
  env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" PATH="$PATH" \
    npm install --global "pm2@$PM2_REQUIRED_VERSION"
  PM2_BIN="$(command -v pm2)"
  PM2_CLI_VERSION="$(
    env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" PATH="$PATH" \
      "$PM2_BIN" --version 2>/dev/null | tail -n 1 | tr -d '\r'
  )"
fi
[ "$PM2_CLI_VERSION" = "$PM2_REQUIRED_VERSION" ] || {
  echo "✗ PM2 CLI must be exactly ${PM2_REQUIRED_VERSION}; got ${PM2_CLI_VERSION:-unavailable}"
  exit 1
}

if ! env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" PATH="$PATH" \
  "$PM2_BIN" jlist | node -e '
    const processes = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!Array.isArray(processes)) process.exit(1);
  '; then
  echo "✗ PM2 CLI/daemon compatibility check failed before deployment mutation"
  exit 1
fi

PORT="${PORT:-4100}"

if [ "${GATEWAY_ADAPTER:-mock}" = "litellm" ]; then
  echo "▶ data plane: postgres + litellm (127.0.0.1 only)"
  $COMPOSE up -d postgres litellm
else
  echo "▶ data plane: postgres only (mock gateway — no real LLM/key)"
  $COMPOSE up -d postgres
fi

echo "▶ install + build + migrate"
npm ci --include=dev
npm run build
npx prisma migrate deploy
if [ "${GATEWAY_ADAPTER:-mock}" = "litellm" ]; then
  # This is the Docker-based TEST path: Compose still injects the env value into its container.
  # Import is bootstrap-only and refuses to overwrite a different encrypted revision.
  echo "▶ bootstrap/verify encrypted DeepSeek source of truth"
  node dist/ops/provider-secret.js bootstrap-deepseek-env
fi
npm prune --omit=dev

echo "▶ (re)start Nest on ${HOST:-127.0.0.1}:${PORT} via pm2 [$PM2_NAME]"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start dist/main.js --name "$PM2_NAME" --update-env
fi
pm2 save

sleep 2
echo "▶ health check"
curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null
echo "✓ Nest + dependencies ready on 127.0.0.1:${PORT}"
echo "✓ done. Next: enroll a device — see DEPLOY.md §4."
