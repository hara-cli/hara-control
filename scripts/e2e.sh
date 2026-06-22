#!/usr/bin/env bash
# Phase-1 live e2e: ensure Docker + Postgres, migrate, boot the control plane, run test/e2e.mjs.
# Self-contained — launches Docker Desktop if the daemon is down. Run from repo root: bash scripts/e2e.sh
set -uo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://hara:hara@localhost:5433/hara_control?schema=public"
export HARA_CONTROL_ADMIN_KEY="admin-dev-e2e"
export GATEWAY_ADAPTER="mock"
export PORT=4100

SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true; }
trap cleanup EXIT

# 1. Docker daemon
if ! docker info >/dev/null 2>&1; then
  echo "▶ docker daemon down — launching Docker Desktop"
  open -a Docker 2>/dev/null || true
  echo -n "  waiting"; for i in $(seq 1 60); do docker info >/dev/null 2>&1 && { echo " up"; break; }; echo -n "."; sleep 2; done
fi
docker info >/dev/null 2>&1 || { echo "DOCKER_DOWN: daemon never came up — start Docker and re-run"; exit 2; }

# 2. Postgres
echo "▶ docker compose up -d postgres"
docker compose up -d postgres >/dev/null 2>&1
echo -n "  waiting for pg"; for i in $(seq 1 30); do docker compose exec -T postgres pg_isready -U hara >/dev/null 2>&1 && { echo " ready"; break; }; echo -n "."; sleep 2; done

# 3. Migrate (create tables)
echo "▶ prisma migrate"
npx prisma migrate dev --name init --skip-generate 2>&1 | tail -4

# 4. Boot the control plane
echo "▶ starting control plane (:$PORT)"
node dist/main.js >/tmp/hara-control.log 2>&1 &
SRV=$!
echo -n "  waiting"; for i in $(seq 1 30); do curl -sf "localhost:$PORT/admin/fleet?orgId=_" -H "x-admin-key: $HARA_CONTROL_ADMIN_KEY" >/dev/null 2>&1 && { echo " up"; break; }; if ! kill -0 "$SRV" 2>/dev/null; then echo " DIED"; tail -20 /tmp/hara-control.log; exit 1; fi; echo -n "."; sleep 1; done

# 5. Run e2e
echo "▶ e2e"
node test/e2e.mjs
