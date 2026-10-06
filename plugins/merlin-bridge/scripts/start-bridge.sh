#!/usr/bin/env bash
# scripts/start-bridge.sh - Launcher for Merlin CDP Bridge
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHROME_PORT="${CHROME_DEBUG_PORT:-9222}"
BRIDGE_PORT="${MERLIN_BRIDGE_PORT:-4340}"

echo "[merlin-bridge] Checking Chrome CDP port ${CHROME_PORT}..."
if ! curl -s "http://127.0.0.1:${CHROME_PORT}/json/version" >/dev/null 2>&1; then
  echo "[merlin-bridge] Chrome not running on port ${CHROME_PORT}. Launching Windows Chrome..."
  node "${PACKAGE_DIR}/../chrome-browser/scripts/launch-windows.js" &
  sleep 2
fi

echo "[merlin-bridge] Starting server on http://127.0.0.1:${BRIDGE_PORT}..."
cd "${PACKAGE_DIR}"
exec bun run src/server.ts
