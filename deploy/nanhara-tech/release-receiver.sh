#!/usr/bin/env bash
# Forced-command receiver for the dedicated hara-control GitHub Actions deploy key.
# Install outside the application tree and bind it in authorized_keys with:
#   restrict,command="/usr/local/sbin/hara-control-release-receiver" ssh-ed25519 ...
set -euo pipefail
umask 077

APP_DIR="${HARA_CONTROL_APP_DIR:-/opt/hara-control}"
ROLLBACK_DIR="${HARA_CONTROL_ROLLBACK_DIR:-/opt/hara-control-rollbacks}"
REPOSITORY_URL="https://github.com/hara-cli/hara-control.git"
LOCK_FILE="/var/lock/hara-control-release.lock"

original="${SSH_ORIGINAL_COMMAND:-}"
read -r verb tag expected_sha extra <<<"$original"
if [[
  "$original" == *$'\n'* ||
  "$original" == *$'\r'* ||
  "$verb" != "deploy" ||
  ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ||
  ! "$expected_sha" =~ ^[0-9a-f]{40}$ ||
  -n "${extra:-}"
]]; then
  echo "deployment request rejected" >&2
  exit 64
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another hara-control deployment is already running" >&2
  exit 75
fi

staging="$(mktemp -d /opt/hara-control-release.XXXXXX)"
cleanup() {
  rm -rf "$staging"
}
trap cleanup EXIT

source_dir="$staging/source"
git init --quiet "$source_dir"
git -C "$source_dir" remote add origin "$REPOSITORY_URL"
git -C "$source_dir" fetch --quiet --depth 1 origin "refs/tags/$tag"
resolved_sha="$(git -C "$source_dir" rev-parse 'FETCH_HEAD^{commit}')"
if [[ "$resolved_sha" != "$expected_sha" ]]; then
  echo "release tag does not resolve to the workflow commit" >&2
  exit 65
fi
git -C "$source_dir" checkout --quiet --detach "$resolved_sha"

package_version="$(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
    process.stdout.write(typeof value === "string" ? value : "");
  ' "$source_dir/package.json"
)"
if [[ "v$package_version" != "$tag" ]]; then
  echo "release tag does not match package metadata" >&2
  exit 65
fi

mkdir -p "$ROLLBACK_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback="$ROLLBACK_DIR/hara-control-${tag#v}-pre-${timestamp}.tar.gz"
if [[ -d "$APP_DIR" ]]; then
  tar -C "$APP_DIR" \
    --exclude='./.env' \
    --exclude='./.npmrc' \
    --exclude='./node_modules' \
    --exclude='./.litellm-venv' \
    --exclude='./.litellm-venvs' \
    --exclude='./.litellm-runtime' \
    --exclude='./postgres-data' \
    --exclude='./phase0/.run' \
    -czf "$rollback" .
  chmod 600 "$rollback"
fi

mkdir -p "$APP_DIR"
rsync -a --delete --chown=root:root \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.npmrc' \
  --exclude='node_modules/' \
  --exclude='.litellm-venv/' \
  --exclude='.litellm-venvs/' \
  --exclude='.litellm-runtime/' \
  --exclude='postgres-data/' \
  --exclude='phase0/.run/' \
  --exclude='.deployed-release' \
  "$source_dir/" "$APP_DIR/"
chown root:root "$APP_DIR"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "production .env is missing after source sync" >&2
  exit 66
fi
chmod 600 "$APP_DIR/.env"

APP_DIR="$APP_DIR" bash "$APP_DIR/deploy/nanhara-tech/deploy-ai-rds.sh"

attestation="$staging/deployed-release"
{
  printf 'tag=%s\n' "$tag"
  printf 'commit=%s\n' "$resolved_sha"
  printf 'deployed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$attestation"
install -o root -g root -m 644 "$attestation" "$APP_DIR/.deployed-release"
echo "hara-control $tag deployed and ready"
