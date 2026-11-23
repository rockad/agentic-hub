#!/usr/bin/env bash
# clarify-stop-check.sh - Thin wrapper delegating to clarify-stop-check.mjs.
#
# Always fails open ({} + exit 0) if node is unavailable.

set -uo pipefail

command -v node >/dev/null 2>&1 || {
  printf 'clarify-stop-check: node not found on PATH; failing open\n' >&2
  printf '{}\n'
  exit 0
}
exec node "$(cd "$(dirname "$0")" && pwd)/clarify-stop-check.mjs"
