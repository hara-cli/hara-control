#!/usr/bin/env bash
# Phase-1.5 live e2e — the REAL LiteLLMAdapter. LiteLLM runs via docker-compose (official image, which
# ships a working prisma client for DB mode — the uvx install does not), sharing the SAME Postgres so
# its virtual-key admin API is enabled. hara-control runs on the host (GATEWAY_ADAPTER=litellm). The
# mock upstream runs on the host; the LiteLLM container reaches it via host.docker.internal (the
# compose default for HARA_MOCK_BASE). Run from repo root:  bash scripts/e2e-litellm.sh
set -uo pipefail
cd "$(dirname "$0")/.."

# shared with the litellm container (must match) + used by host-side hara-control
export LITELLM_MASTER_KEY="sk-hara-master-e2e"
export DATABASE_URL="postgresql://hara:hara@localhost:5433/hara_control?schema=public"
export HARA_CONTROL_ADMIN_KEY="admin-dev-e2e"
export LITELLM_URL="http://localhost:4000"
export GATEWAY_ADAPTER="litellm"
export PORT="4100"
export HARA_LICENSE_DEV=1 # self-mode dev bypass (no license needed for CI/e2e)
export MOCK_UPSTREAM_PORT="8899"
# NOTE: do NOT export HARA_MOCK_BASE / UPSTREAM_BASE_URL here — let docker-compose default them to
# host.docker.internal so the *container* reaches the host mock (localhost would point inside the container).

MOCK="" SRV=""
docker_bounded(){ local seconds="$1"; shift; node scripts/run-with-timeout.mjs "$seconds" docker "$@"; }
cleanup(){ for p in "$MOCK" "$SRV"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; docker_bounded 45 compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▶ docker control-plane preflight"
docker_bounded 15 ps --format '{{.ID}}' >/dev/null || { echo "DOCKER API UNAVAILABLE"; exit 1; }

echo "▶ build"; npm run build >/tmp/hcl-build.log 2>&1 || { echo "BUILD FAIL"; tail -20 /tmp/hcl-build.log; exit 1; }

echo "▶ clean slate (wipe pg volume — LiteLLM + hara-control share the DB via separate schemas)"
docker_bounded 60 compose down -v >/dev/null 2>&1 || { echo "COMPOSE CLEANUP FAIL"; exit 1; }

echo "▶ postgres (:5433)"; docker_bounded 60 compose up -d postgres >/dev/null 2>&1 || { echo "POSTGRES START FAIL"; exit 1; }
echo -n "  pg"; for i in $(seq 1 30); do docker_bounded 5 compose exec -T postgres pg_isready -U hara >/dev/null 2>&1 && { echo " ready"; break; }; echo -n "."; sleep 1; [ "$i" = 30 ] && { echo " timeout"; exit 1; }; done
npx prisma migrate deploy >/tmp/hcl-migrate.log 2>&1 || \
  npx prisma migrate dev --name init --skip-generate >/tmp/hcl-migrate.log 2>&1 || \
  { echo "MIGRATION FAIL"; tail -20 /tmp/hcl-migrate.log; exit 1; }

echo "▶ mock upstream (host :$MOCK_UPSTREAM_PORT)"; node phase0/mock-upstream.mjs >/tmp/hcl-mock.log 2>&1 & MOCK=$!

echo "▶ LiteLLM via docker-compose (shared PG → virtual keys; first run pulls the image)"
docker_bounded 120 compose up -d litellm >/tmp/hcl-litellm-up.log 2>&1 || { echo "COMPOSE UP FAIL"; cat /tmp/hcl-litellm-up.log; exit 1; }
echo -n "  waiting litellm"
for i in $(seq 1 120); do
  curl -sf "localhost:4000/health/readiness" >/dev/null 2>&1 && { echo " up"; break; }
  echo -n "."; sleep 2
  [ "$i" = 120 ] && { echo " timeout"; docker_bounded 30 compose logs --tail=50 litellm; exit 1; }
done

echo "▶ control plane (host :$PORT, GATEWAY_ADAPTER=litellm)"; node dist/main.js >/tmp/hcl-ctrl.log 2>&1 & SRV=$!
echo -n "  waiting ctrl"
for i in $(seq 1 40); do
  curl -sf "localhost:$PORT/admin/fleet?orgId=_" -H "x-admin-key: $HARA_CONTROL_ADMIN_KEY" >/dev/null 2>&1 && { echo " up"; break; }
  if ! kill -0 "$SRV" 2>/dev/null; then echo " DIED"; tail -20 /tmp/hcl-ctrl.log; exit 1; fi
  echo -n "."; sleep 1
done

echo "▶ e2e"; node test/e2e-litellm.mjs
