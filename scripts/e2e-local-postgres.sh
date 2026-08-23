#!/usr/bin/env bash
# Run the full Control HTTP e2e against an isolated throwaway PostgreSQL cluster. This is developer/release
# tooling only: Hara CLI and Desktop do not install or require PostgreSQL.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_bin="${HARA_TEST_POSTGRES_BIN:-}"
if test -z "$postgres_bin"; then
  for candidate_dir in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql/bin /usr/local/opt/postgresql@17/bin /usr/local/opt/postgresql/bin; do
    if test -x "$candidate_dir/postgres" && "$candidate_dir/postgres" --version >/dev/null 2>&1; then
      postgres_bin="$candidate_dir"
      break
    fi
  done
fi
if test -z "$postgres_bin"; then
  echo "a working local PostgreSQL server toolchain is required (or set HARA_TEST_POSTGRES_BIN)" >&2
  exit 1
fi
export PATH="$postgres_bin:$PATH"

test_root="$(mktemp -d /private/tmp/hara-control-e2e.XXXXXX)"
data_dir="$test_root/data"
socket_dir="$test_root/socket"
port_number="${HARA_E2E_POSTGRES_PORT:-$((55000 + ($$ % 8000)))}"
mkdir -p "$socket_dir"

cleanup() {
  if test -s "$data_dir/postmaster.pid"; then
    pg_ctl -D "$data_dir" -m immediate stop >/dev/null 2>&1 || true
  fi
  case "$test_root" in
    /private/tmp/hara-control-e2e.*) rm -rf -- "$test_root" ;;
    *) echo "refusing to remove unexpected test directory: $test_root" >&2 ;;
  esac
}
trap cleanup EXIT

initdb -D "$data_dir" -A trust -U hara >/dev/null
pg_ctl -D "$data_dir" -o "-h 127.0.0.1 -k $socket_dir -p $port_number" -w start >/dev/null
createdb -h 127.0.0.1 -p "$port_number" -U hara hara_control

cd "$repo_dir"
HARA_E2E_DATABASE_URL="postgresql://hara@127.0.0.1:${port_number}/hara_control?schema=public" \
  bash scripts/e2e.sh
