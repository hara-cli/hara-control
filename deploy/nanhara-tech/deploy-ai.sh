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
command -v pm2  >/dev/null || { echo "… installing pm2 globally"; npm i -g pm2; }

set -a; . ./.env; set +a   # export .env so the data plane + Nest both see it
PORT="${PORT:-4100}"

if [ "${GATEWAY_ADAPTER:-mock}" = "litellm" ]; then
  echo "▶ data plane: postgres + litellm (127.0.0.1 only)"
  $COMPOSE up -d postgres litellm
else
  echo "▶ data plane: postgres only (mock gateway — no real LLM/key)"
  $COMPOSE up -d postgres
fi

echo "▶ install + build + migrate"
npm ci
npm run build
npx prisma migrate deploy

echo "▶ (re)start Nest on ${HOST:-127.0.0.1}:${PORT} via pm2 [$PM2_NAME]"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start dist/main.js --name "$PM2_NAME" --update-env
fi
pm2 save

sleep 2
echo "▶ health check"
curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && echo "✓ Nest responding on 127.0.0.1:${PORT}" || echo "… Nest started; root may 404 (that's fine). Check: pm2 logs $PM2_NAME"
echo "✓ done. Next: enroll a device — see DEPLOY.md §4."
