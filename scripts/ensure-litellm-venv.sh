#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REQUIREMENTS="$APP_DIR/deploy/nanhara-tech/requirements-litellm.txt"
VERSION="$(
  sed -n 's/^litellm\[proxy\]==\([0-9][0-9.]*\)$/\1/p' "$REQUIREMENTS"
)"
PRISMA_VERSION="$(
  sed -n 's/^prisma==\([0-9][0-9.]*\)$/\1/p' "$REQUIREMENTS"
)"

[ -n "$VERSION" ] || { echo "✗ could not resolve pinned LiteLLM version"; exit 1; }
[ -n "$PRISMA_VERSION" ] || { echo "✗ could not resolve pinned Prisma Python version"; exit 1; }
command -v "$PYTHON_BIN" >/dev/null || { echo "✗ python3 not found"; exit 1; }

BASE="$APP_DIR/.litellm-venvs"
REQUIREMENTS_SHA="$(
  "$PYTHON_BIN" -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$REQUIREMENTS"
)"
TARGET="$BASE/$VERSION-$REQUIREMENTS_SHA"
CURRENT="$APP_DIR/.litellm-venv"
mkdir -p "$BASE"
chmod 700 "$BASE"

if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  echo "✗ $CURRENT exists but is not a managed symlink; move it aside explicitly before deployment"
  exit 1
fi

if [ -x "$TARGET/bin/python3" ]; then
  installed="$("$TARGET/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("litellm"))')"
  installed_prisma="$("$TARGET/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("prisma"))')"
  [ "$installed" = "$VERSION" ] && [ "$installed_prisma" = "$PRISMA_VERSION" ] || {
    echo "✗ existing managed LiteLLM environment has unexpected dependency versions"
    exit 1
  }
else
  staging="$(mktemp -d "$BASE/.staging.XXXXXX")"
  cleanup() { rm -rf -- "$staging"; }
  trap cleanup EXIT
  "$PYTHON_BIN" -m venv "$staging"
  "$staging/bin/python3" -m pip install --disable-pip-version-check --no-input -r "$REQUIREMENTS"
  installed="$("$staging/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("litellm"))')"
  installed_prisma="$("$staging/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("prisma"))')"
  [ "$installed" = "$VERSION" ] || { echo "✗ installed LiteLLM $installed, expected $VERSION"; exit 1; }
  [ "$installed_prisma" = "$PRISMA_VERSION" ] || {
    echo "✗ installed Prisma Python $installed_prisma, expected $PRISMA_VERSION"
    exit 1
  }
  "$staging/bin/python3" -c '
import pathlib
import litellm
import prisma
schema = pathlib.Path(litellm.__file__).parent / "proxy" / "schema.prisma"
if not schema.is_file():
    raise SystemExit("LiteLLM proxy schema.prisma is missing")
'
  mv "$staging" "$TARGET"
  trap - EXIT
fi

ln -sfn "$TARGET" "$CURRENT"
resolved="$("$CURRENT/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("litellm"))')"
resolved_prisma="$("$CURRENT/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("prisma"))')"
[ "$resolved" = "$VERSION" ] || { echo "✗ active LiteLLM version mismatch"; exit 1; }
[ "$resolved_prisma" = "$PRISMA_VERSION" ] || { echo "✗ active Prisma Python version mismatch"; exit 1; }
"$CURRENT/bin/python3" -c '
import pathlib
import litellm
import prisma
schema = pathlib.Path(litellm.__file__).parent / "proxy" / "schema.prisma"
if not schema.is_file():
    raise SystemExit("LiteLLM proxy schema.prisma is missing")
'
echo "✓ LiteLLM runtime ready (pinned LiteLLM $VERSION + Prisma Python $PRISMA_VERSION)"
