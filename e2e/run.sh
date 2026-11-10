#!/usr/bin/env bash
# End-to-end smoke test through the real UI: builds the web app, starts a fresh server, drives every persona.
# Usage: ./e2e/run.sh   (needs Node 22 and Playwright with Chromium: npm i -g playwright && npx playwright install chromium)
set -e
cd "$(dirname "$0")/.."
PORT=${E2E_PORT:-3800}
OUT=${E2E_OUT:-e2e/out}
DB=$(mktemp -d)/e2e.db
mkdir -p "$OUT"
(cd web && npm run build >/dev/null)
if curl -sf "http://localhost:$PORT/health" >/dev/null; then echo "Port $PORT is already in use (an old server?). Stop it or set E2E_PORT." >&2; exit 1; fi
# Own process group, so the whole server tree (npx → tsx → node) is stopped at the end.
setsid bash -c "cd backend && DB_PATH='$DB' PORT=$PORT JOB_INTERVAL_MS=2000 exec npx tsx src/server.ts" >"$OUT/server.log" 2>&1 &
SERVER=$!
trap 'kill -- -$SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 1; done
BASE_URL="http://localhost:$PORT" OUT="$OUT" node e2e/smoke.cjs
