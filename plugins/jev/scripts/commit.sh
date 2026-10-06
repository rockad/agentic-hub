#!/usr/bin/env bash
set -euo pipefail

# Wrapper for commit using Bun
BUN_BIN="${HOME}/.bun/bin/bun"
# Resolve real script path (handling symlinks)
TARGET_FILE="${BASH_SOURCE[0]}"
while [ -L "$TARGET_FILE" ]; do
  TARGET_DIR="$(cd -P "$(dirname "$TARGET_FILE")" && pwd)"
  TARGET_FILE="$(readlink "$TARGET_FILE")"
  [[ $TARGET_FILE != /* ]] && TARGET_FILE="${TARGET_DIR}/${TARGET_FILE}"
done
SCRIPT_DIR="$(cd -P "$(dirname "$TARGET_FILE")" && pwd)"

if [ ! -x "$BUN_BIN" ]; then
  BUN_BIN="$(which bun 2>/dev/null || true)"
fi

if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
  echo "Error: bun is required for commit. Run: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

exec "$BUN_BIN" run "${SCRIPT_DIR}/commit.ts" "$@"
