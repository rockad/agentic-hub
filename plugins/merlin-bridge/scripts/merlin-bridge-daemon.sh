#!/usr/bin/env bash
# scripts/merlin-bridge-daemon.sh - Service manager for Merlin CDP Bridge
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="${MERLIN_BRIDGE_PORT:-4340}"
LOG_FILE="${HOME}/.gemini/antigravity-cli/log/merlin-bridge.log"
PID_FILE="/tmp/merlin-bridge.pid"

mkdir -p "$(dirname "${LOG_FILE}")"

is_running() {
  if [ -f "${PID_FILE}" ]; then
    pid=$(cat "${PID_FILE}")
    if kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  # Fallback: check if port is listening
  if curl --connect-timeout 2 -s "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

case "${1:-status}" in
  start)
    if is_running; then
      echo "[merlin-bridge] Already running on port ${PORT}"
      exit 0
    fi
    BUN_BIN=$(command -v bun || echo "$HOME/.bun/bin/bun")
    nohup setsid "${BUN_BIN}" run "${PACKAGE_DIR}/src/server.ts" </dev/null >> "${LOG_FILE}" 2>&1 &
    bg_pid=$!
    echo "${bg_pid}" > "${PID_FILE}"
    sleep 1
    if is_running; then
      echo "[merlin-bridge] Successfully started (PID $(cat "${PID_FILE}"))"
    else
      echo "[merlin-bridge] Failed to start. Check ${LOG_FILE}" >&2
      exit 1
    fi
    ;;

  stop)
    if [ -f "${PID_FILE}" ]; then
      pid=$(cat "${PID_FILE}")
      echo "[merlin-bridge] Stopping PID ${pid}..."
      kill "${pid}" 2>/dev/null || true
      rm -f "${PID_FILE}"
    fi
    # Also kill any leftover bun server instances on port
    pkill -f "bun.*server.ts" 2>/dev/null || true
    echo "[merlin-bridge] Stopped"
    ;;

  restart)
    $0 stop
    sleep 1
    $0 start
    ;;

  status)
    if is_running; then
      echo "[merlin-bridge] Running on port ${PORT}"
      curl --connect-timeout 3 -s "http://127.0.0.1:${PORT}/health" | jq . || true
    else
      echo "[merlin-bridge] Stopped"
    fi
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
