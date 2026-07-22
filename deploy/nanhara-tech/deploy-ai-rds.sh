#!/usr/bin/env bash
# Dockerless deploy of hara-control on `ai`, using external Postgres (Aliyun RDS).
# Postgres and the Nest app are not containerized. In real-gateway mode, this script creates a
# versioned/pinned LiteLLM virtualenv and supervises it with pm2.
#   bash deploy/nanhara-tech/deploy-ai-rds.sh
# Prereqs: node>=20, python3, pm2. .env must be a regular owner-only (0600) file.
set -euo pipefail
APP_DIR="${APP_DIR:-$(pwd)}"
PM2_NAME="${PM2_NAME:-hara-control}"
# Keep the historical production identity so an upgrade replaces the existing provider-bearing
# process instead of creating a second unmanaged instance on the same port.
LITELLM_PM2_NAME="${LITELLM_PM2_NAME:-hara-litellm}"
cd "$APP_DIR"
[ -f .env ] || { echo "✗ $APP_DIR/.env missing — set DATABASE_URL (RDS) + GATEWAY_ADAPTER=mock"; exit 1; }
command -v node >/dev/null || { echo "✗ node not found (need >=20)"; exit 1; }

# Parse/validate .env without executing it as shell. Re-enter once with the checked variables.
if [ "${HARA_ENV_LOADED:-}" != "1" ]; then
  # Upgrade old installations before strict preflight: create missing independent auth/KMS material
  # and derive an isolated schema=litellm URL from the checked schema=public control URL. Values are
  # never printed and existing non-placeholder secrets are preserved.
  node scripts/bootstrap-production-security.mjs "$APP_DIR/.env"
  exec node scripts/with-production-env.mjs "$APP_DIR/.env" -- bash "$0" "$@"
fi

command -v pm2  >/dev/null || { echo "… installing pm2 globally"; npm i -g pm2; }
NODE_BIN="$(command -v node)"
PM2_BIN="$(command -v pm2)"
ENV_BIN="$(command -v env)"
PM2_HOME_VALUE="${PM2_HOME:-$HOME/.pm2}"

# PM2 serializes the environment presented by its client. Invoke every mutating PM2 command from a
# deliberately empty environment so database credentials, control-plane auth and KMS material are
# never copied into the process list or dump. The managed wrapper loads the owner-only .env at child
# runtime instead.
pm2_clean() {
  env -i \
    HOME="$HOME" \
    USER="${USER:-}" \
    LOGNAME="${LOGNAME:-${USER:-}}" \
    PATH="$PATH" \
    PM2_HOME="$PM2_HOME_VALUE" \
    "$PM2_BIN" "$@"
}

PORT="${PORT:-4100}"
echo "▶ DB target: $(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]+@#://***:***@#')" # mask creds in the log

echo "▶ install + build (npm via .npmrc mirror if present)"
npm ci --include=dev
npm run build

echo "▶ migrate → RDS (known-failure guard + prisma migrate deploy)"
# If this fails on the vector extension, enable pgvector once on the RDS, then re-run:
#   psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'   (needs a privileged RDS account)
npm run prisma:deploy
if [ "${GATEWAY_ADAPTER:-mock}" = "litellm" ]; then
  echo "▶ bootstrap/verify encrypted DeepSeek source of truth"
  node dist/ops/provider-secret.js bootstrap-deepseek-env --scrub-env-file "$APP_DIR/.env"
  # Do not leak the one-time bootstrap value into either PM2 process or its saved dump.
  export UPSTREAM_API_KEY=""
fi
npm prune --omit=dev

GATEWAY_MODE="${GATEWAY_ADAPTER:-mock}"
PM2_ASSERT_NAMES=("$PM2_NAME")
if [ "$GATEWAY_MODE" = "litellm" ]; then
  echo "▶ build/verify pinned LiteLLM runtime"
  bash scripts/ensure-litellm-venv.sh
  echo "▶ verify/synchronize isolated LiteLLM schema"
  node scripts/sync-litellm-schema.mjs
fi
# The remaining process launches must not inherit credentials from this deployment shell.
unset DATABASE_URL LITELLM_DATABASE_URL HARA_CONTROL_ADMIN_KEY HARA_JWT_SECRET
unset HARA_KMS_MASTER_KEY HARA_KMS_KEYFILE LITELLM_MASTER_KEY UPSTREAM_API_KEY

if [ "$GATEWAY_MODE" = "litellm" ]; then
  PM2_ASSERT_NAMES+=("$LITELLM_PM2_NAME")
  # Always recreate the PM2 definition so an older direct-LiteLLM command cannot survive an
  # upgrade. The Node supervisor decrypts the current revision in memory and substitutes the
  # isolated LiteLLM database URL only for its child process. Runtime schema mutation is disabled:
  # the explicit non-destructive sync above is the only production schema writer.
  pm2_clean delete "$LITELLM_PM2_NAME" >/dev/null 2>&1 || true
  pm2_clean start "$APP_DIR/scripts/with-production-env.mjs" \
    --name "$LITELLM_PM2_NAME" \
    --interpreter "$NODE_BIN" -- \
    "$APP_DIR/.env" -- "$NODE_BIN" \
    "$APP_DIR/dist/ops/provider-secret.js" run-deepseek -- \
    "$ENV_BIN" DISABLE_SCHEMA_UPDATE=true \
    "$APP_DIR/.litellm-venv/bin/litellm" \
    --config "$APP_DIR/litellm/config.yaml" --host 127.0.0.1 --port 4000
  litellm_ready=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:4000/health/liveliness" >/dev/null; then
      litellm_ready=1
      break
    fi
    sleep 2
  done
  [ "$litellm_ready" = "1" ] || { echo "✗ LiteLLM did not become live"; exit 1; }
  echo "▶ verify priced request records positive USD spend"
  node scripts/with-production-env.mjs "$APP_DIR/.env" -- \
    "$NODE_BIN" "$APP_DIR/scripts/probe-litellm-priced-request.mjs"
else
  # Switching away from the managed gateway must also remove the old provider-bearing runtime.
  pm2_clean delete "$LITELLM_PM2_NAME" >/dev/null 2>&1 || true
fi

echo "▶ (re)start Nest via pm2 [$PM2_NAME] on ${HOST:-127.0.0.1}:${PORT}"
# Recreate instead of merging an old PM2 environment: removed credentials must actually disappear.
pm2_clean delete "$PM2_NAME" >/dev/null 2>&1 || true
pm2_clean start "$APP_DIR/scripts/with-production-env.mjs" \
  --name "$PM2_NAME" \
  --interpreter "$NODE_BIN" -- \
  "$APP_DIR/.env" -- "$NODE_BIN" "$APP_DIR/dist/main.js"

if ! env -i HOME="$HOME" PATH="$PATH" PM2_HOME="$PM2_HOME_VALUE" \
  "$NODE_BIN" "$APP_DIR/scripts/assert-pm2-env-safe.mjs" \
  "$PM2_BIN" "${PM2_ASSERT_NAMES[@]}"; then
  echo "✗ PM2 environment boundary verification failed; removing unsafe process definitions"
  pm2_clean delete "$PM2_NAME" >/dev/null 2>&1 || true
  pm2_clean delete "$LITELLM_PM2_NAME" >/dev/null 2>&1 || true
  exit 1
fi
pm2_clean save

sleep 2
curl -fsS "http://127.0.0.1:${PORT}/health/ready" >/dev/null
echo "✓ hara-control ready on 127.0.0.1:${PORT} (dockerless, RDS)"
