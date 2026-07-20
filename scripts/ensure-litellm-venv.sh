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
LAYOUT_VERSION="v3"
TARGET="$BASE/$LAYOUT_VERSION-$VERSION-$REQUIREMENTS_SHA"
COMPLETE="$TARGET/.hara-runtime-complete"
CURRENT="$APP_DIR/.litellm-venv"
mkdir -p "$BASE"
chmod 700 "$BASE"

if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  echo "✗ $CURRENT exists but is not a managed symlink; move it aside explicitly before deployment"
  exit 1
fi

verify_runtime() {
  runtime="$1"
  installed="$("$runtime/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("litellm"))')"
  installed_prisma="$("$runtime/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("prisma"))')"
  [ "$installed" = "$VERSION" ] && [ "$installed_prisma" = "$PRISMA_VERSION" ] || {
    echo "✗ managed LiteLLM environment has unexpected dependency versions"
    return 1
  }
  "$runtime/bin/python3" -c '
import pathlib
import litellm
import prisma
from prisma import Prisma
schema = pathlib.Path(litellm.__file__).parent / "proxy" / "schema.prisma"
if not schema.is_file():
    raise SystemExit("LiteLLM proxy schema.prisma is missing")
Prisma()
'
  [ -x "$runtime/bin/litellm" ] || {
    echo "✗ managed LiteLLM console entrypoint is missing or not executable"
    return 1
  }
  expected_shebang="#!$TARGET/bin/python3"
  actual_shebang="$(sed -n '1p' "$runtime/bin/litellm")"
  [ "$actual_shebang" = "$expected_shebang" ] || {
    echo "✗ managed LiteLLM console entrypoint targets a relocated Python environment"
    return 1
  }
}

if [ -e "$TARGET" ]; then
  [ -d "$TARGET" ] && [ ! -L "$TARGET" ] && [ -f "$COMPLETE" ] && [ ! -L "$COMPLETE" ] || {
    echo "✗ existing managed LiteLLM environment is incomplete or unsafe"
    exit 1
  }
  [ "$(cat "$COMPLETE")" = "$REQUIREMENTS_SHA" ] || {
    echo "✗ existing managed LiteLLM environment has an unexpected completion marker"
    exit 1
  }
  verify_runtime "$TARGET"
else
  mkdir "$TARGET"
  chmod 700 "$TARGET"
  cleanup() { rm -rf -- "$TARGET"; }
  trap cleanup EXIT
  "$PYTHON_BIN" -m venv "$TARGET"
  "$TARGET/bin/python3" -m pip install --disable-pip-version-check --no-input -r "$REQUIREMENTS"
  installed="$("$TARGET/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("litellm"))')"
  installed_prisma="$("$TARGET/bin/python3" -c 'import importlib.metadata; print(importlib.metadata.version("prisma"))')"
  [ "$installed" = "$VERSION" ] || { echo "✗ installed LiteLLM $installed, expected $VERSION"; exit 1; }
  [ "$installed_prisma" = "$PRISMA_VERSION" ] || {
    echo "✗ installed Prisma Python $installed_prisma, expected $PRISMA_VERSION"
    exit 1
  }
  schema="$("$TARGET/bin/python3" -c '
import pathlib
import litellm
print(pathlib.Path(litellm.__file__).parent / "proxy" / "schema.prisma")
')"
  (
    generator_workdir="$(mktemp -d "/tmp/hara-litellm-prisma.XXXXXX")"
    trap 'rm -rf -- "$generator_workdir"' EXIT
    cd "$generator_workdir"
    env -i \
      HOME="${HOME:-/tmp}" \
      PATH="$TARGET/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      DATABASE_URL="postgresql://unused:unused@127.0.0.1:1/unused" \
      "$TARGET/bin/prisma" generate --schema="$schema"
  )
  verify_runtime "$TARGET"
  printf '%s\n' "$REQUIREMENTS_SHA" > "$COMPLETE"
  chmod 600 "$COMPLETE"
  trap - EXIT
fi

ln -sfn "$TARGET" "$CURRENT"
verify_runtime "$CURRENT"
echo "✓ LiteLLM runtime ready (pinned LiteLLM $VERSION + Prisma Python $PRISMA_VERSION)"
