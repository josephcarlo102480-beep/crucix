#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/joseph/Crucix"
# Match the port the server will actually use: explicit $PORT wins, then the
# project .env (server-side, .env does NOT override an exported PORT), then
# the config default. A mismatch here used to spawn a duplicate server.
if [ -z "${PORT:-}" ]; then
  PORT="$(grep -oP '^PORT=\K[0-9]+' "${APP_DIR}/.env" 2>/dev/null || true)"
fi
PORT="${PORT:-3117}"
URL="http://localhost:${PORT}"
LOG_DIR="${APP_DIR}/runs"
LOG_FILE="${LOG_DIR}/launcher.log"

mkdir -p "${LOG_DIR}"

if ! command -v npm >/dev/null 2>&1; then
  xdg-open "file://${APP_DIR}/README.md" >/dev/null 2>&1 || true
  exit 1
fi

if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  (
    cd "${APP_DIR}"
    CRUCIX_NO_BROWSER=1 PORT="${PORT}" nohup npm run dev >>"${LOG_FILE}" 2>&1 &
  )
fi

for _ in $(seq 1 30); do
  if curl -fsS "${URL}/api/health" >/dev/null 2>&1 || curl -fsS "${URL}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

(xdg-open "${URL}" >/dev/null 2>&1 || true) &
