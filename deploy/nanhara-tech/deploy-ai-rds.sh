#!/usr/bin/env bash
# DOCKERLESS deploy of the hara-control TEST control plane on `ai`, using an EXTERNAL Postgres (Aliyun RDS).
# No container for Postgres (set DATABASE_URL to the RDS), none for the app (node + pm2). R1 (mock gateway)
# needs no LiteLLM either, so this path runs zero docker. Run from the repo root on the box:
#   bash deploy/nanhara-tech/deploy-ai-rds.sh
# Prereqs: node>=20, pm2. .env must point DATABASE_URL at the RDS and (R1) GATEWAY_ADAPTER=mock.
set -euo pipefail
APP_DIR="${APP_DIR:-$(pwd)}"
PM2_NAME="${PM2_NAME:-hara-control}"
cd "$APP_DIR"
[ -f .env ] || { echo "✗ $APP_DIR/.env missing — set DATABASE_URL (RDS) + GATEWAY_ADAPTER=mock"; exit 1; }
command -v node >/dev/null || { echo "✗ node not found (need >=20)"; exit 1; }
command -v pm2  >/dev/null || { echo "… installing pm2 globally"; npm i -g pm2; }

set -a; . ./.env; set +a
PORT="${PORT:-4100}"
echo "▶ DB target: $(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]+@#://***:***@#')" # mask creds in the log

echo "▶ install + build (npm via .npmrc mirror if present)"
npm ci
npm run build

echo "▶ migrate → RDS (prisma migrate deploy)"
# If this fails on the vector extension, enable pgvector once on the RDS, then re-run:
#   psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'   (needs a privileged RDS account)
npx prisma migrate deploy

echo "▶ (re)start Nest via pm2 [$PM2_NAME] on ${HOST:-127.0.0.1}:${PORT}"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start dist/main.js --name "$PM2_NAME" --update-env
fi
pm2 save

sleep 2
curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && echo "✓ Nest up on 127.0.0.1:${PORT}" || echo "… started; root may 404 (fine). Check: pm2 logs $PM2_NAME"
echo "✓ done (dockerless, RDS). Next: cert + nginx + enroll (DEPLOY.md §3,§5,§4)."
