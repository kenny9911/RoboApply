#!/bin/bash
#
# Restart the RoboApply dev stack: Express API (:4607), Next.js web (:3611),
# and the LiveKit voice worker (supervised by scripts/dev-interview-agent.sh).
#
# Kills are scoped to THIS app — by listen port for web/API and by PID file
# for the worker — so other repos' dev servers (e.g. RoboHire's `next dev`)
# survive. Killing any `concurrently --kill-others` member cascades the
# teardown to the rest; the force-kill pass only mops up orphans that
# outlived the cascade.

set -euo pipefail
cd "$(dirname "$0")/.."

# Web port is pinned in package.json (`next dev -p 3611`); the API port comes
# from .env PORT (server/src/app.ts defaults to 4607 when unset).
API_PORT=$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')
PORTS=(3611 "${API_PORT:-4607}")
WORKER_PID_FILE="/tmp/roboapply-interview-agent.pid"

port_pids() {
    lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true
}

echo "🛑 Stopping dev stack..."
for port in "${PORTS[@]}"; do
    pids=$(port_pids "$port")
    if [ -n "$pids" ]; then
        echo "   :$port → $pids"
        kill $pids 2>/dev/null || true
    fi
done
if [ -f "$WORKER_PID_FILE" ]; then
    kill "$(cat "$WORKER_PID_FILE")" 2>/dev/null || true
fi

# Let the concurrently teardown cascade, then force-free anything left.
sleep 2
for port in "${PORTS[@]}"; do
    pids=$(port_pids "$port")
    if [ -n "$pids" ]; then
        echo "   :$port still held → SIGKILL $pids"
        kill -9 $pids 2>/dev/null || true
    fi
done

echo "🚀 Starting dev stack..."
exec npm run dev
