#!/usr/bin/env bash
# Phase-0 spike runner: mock upstream + LiteLLM proxy + the /v1/messages test.
# No Docker, no real provider key. Run from the repo root:  bash phase0/run-spike.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# load .env if present, else fall back to spike defaults
[ -f .env ] && set -a && . ./.env && set +a || true
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-hara-master-dev-change-me}"
export MOCK_UPSTREAM_PORT="${MOCK_UPSTREAM_PORT:-8899}"
export LITELLM_PORT="${LITELLM_PORT:-4000}"
# keep the real-upstream config entry loadable without a real key (it won't be exercised)
export UPSTREAM_API_KEY="${UPSTREAM_API_KEY:-spike-unused}"
export UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-http://localhost:${MOCK_UPSTREAM_PORT}/v1}"
export HARA_MOCK_BASE="${HARA_MOCK_BASE:-http://localhost:${MOCK_UPSTREAM_PORT}/v1}"

mkdir -p phase0/.run
MOCK_PID="" LITE_PID=""
cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true; [ -n "$LITE_PID" ] && kill "$LITE_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "▶ starting mock upstream (:$MOCK_UPSTREAM_PORT)"
node phase0/mock-upstream.mjs >phase0/.run/mock.log 2>&1 &
MOCK_PID=$!

echo "▶ starting LiteLLM proxy (:$LITELLM_PORT)"
uvx --python 3.12 --from 'litellm[proxy]' litellm \
  --config litellm/config.yaml --port "$LITELLM_PORT" \
  >phase0/.run/litellm.log 2>&1 &
LITE_PID=$!

echo -n "▶ waiting for LiteLLM readiness "
for i in $(seq 1 90); do
  if curl -sf "http://localhost:${LITELLM_PORT}/health/readiness" >/dev/null 2>&1; then echo " up"; break; fi
  if ! kill -0 "$LITE_PID" 2>/dev/null; then echo " DIED"; tail -30 phase0/.run/litellm.log; exit 1; fi
  echo -n "."; sleep 1
  [ "$i" = 90 ] && { echo " timeout"; tail -30 phase0/.run/litellm.log; exit 1; }
done

echo "▶ running /v1/messages test (model=${1:-glm-mock})"
node phase0/test-messages.mjs "${1:-glm-mock}"
