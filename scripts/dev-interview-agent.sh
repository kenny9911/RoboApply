#!/bin/bash
#
# Dev supervisor for the LiveKit mock-interview voice worker (interview-agent/).
# Ported from RoboHire's scripts/dev-interview-agent.sh on 2026-07-03, after
# discovering RoboApply had NO worker of its own — mock interviews were
# silently piggybacking on RoboHire's dev worker via the shared LiveKit
# project, and died whenever RoboHire's dev stack stopped.
#
# Why this exists: the worker is a separate process from the two npm dev
# members. Started by hand it silently dies (observed in RoboHire 2026-06-11)
# and every mock-interview session runs with no AI interviewer — the dispatch
# is created but nobody accepts it, so the room just sits silent. This wrapper
# runs as a third `concurrently` member of the root `npm run dev` and:
#   - builds the worker (tsc), then runs `node dist/main.js dev`
#   - RESTARTS it if it exits (the silent-death mode this prevents)
#   - never exits itself: under `concurrently --kill-others` any member's exit
#     tears down server/web too, and the rest of the product works fine
#     without the worker — so a missing .env.local or a build failure degrades
#     to a loud warning + idle, not a dead dev stack
#   - mirrors output to $AGENT_LOG (APPEND mode — history survives restarts;
#     each supervisor start writes a dated marker) and writes $AGENT_PID_FILE

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
AGENT_DIR="$PROJECT_ROOT/interview-agent"
AGENT_LOG="/tmp/roboapply-interview-agent.log"
AGENT_PID_FILE="/tmp/roboapply-interview-agent.pid"
RESTART_DELAY_SECONDS=5

CHILD_PID=""
STOPPING=0

say() { echo "[interview-agent] $*"; }

# Status markers for tooling — grep for '[dev-interview-agent] status:'.
mark() { echo "[dev-interview-agent] status: $1" >> "$AGENT_LOG"; }

shutdown() {
    STOPPING=1
    if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        kill -INT "$CHILD_PID" 2>/dev/null || true
        # The LiveKit CLI drains active jobs on SIGINT, which can hang; don't
        # let a stuck worker stall the whole `concurrently` teardown.
        local i
        for ((i=0; i<10; i++)); do
            kill -0 "$CHILD_PID" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$CHILD_PID" 2>/dev/null; then
            kill -9 "$CHILD_PID" 2>/dev/null || true
        fi
    fi
    rm -f "$AGENT_PID_FILE"
    exit 0
}
trap shutdown INT TERM

# Trap-responsive sleep: a foreground `sleep` blocks signal handling until it
# finishes; background + wait lets the INT/TERM trap fire immediately.
nap() {
    sleep "$1" &
    wait $! 2>/dev/null
}

idle_forever() {
    while true; do
        nap 3600
        [ "$STOPPING" = "1" ] && exit 0
    done
}

# Append-mode log with a restart marker (RoboHire truncated here, which wiped
# crash evidence on every dev restart — keep history, cap runaway growth).
if [ -f "$AGENT_LOG" ] && [ "$(wc -c < "$AGENT_LOG")" -gt 5242880 ]; then
    tail -c 1048576 "$AGENT_LOG" > "$AGENT_LOG.tmp" && mv "$AGENT_LOG.tmp" "$AGENT_LOG"
fi
echo "──── [dev-interview-agent] supervisor start $(date '+%Y-%m-%d %H:%M:%S') ────" >> "$AGENT_LOG"

if [ ! -f "$AGENT_DIR/.env.local" ]; then
    say "⚠️  interview-agent/.env.local not found — voice worker NOT started."
    say "   Mock interviews will have NO AI interviewer (silent room, no greeting)."
    say "   Create it from interview-agent/.env.example (LIVEKIT_URL/API_KEY/API_SECRET,"
    say "   OPENAI_API_KEY, LIVEKIT_AGENT_CALLBACK_SECRET, INTERVIEW_ENGINE_AGENT_NAME)."
    mark "env-missing"
    idle_forever
fi

say "building (tsc)..."
if ! (cd "$AGENT_DIR" && npm run build) >> "$AGENT_LOG" 2>&1; then
    say "✗ build failed — voice worker NOT started; mock interviews will have no AI interviewer."
    say "  See $AGENT_LOG (if node_modules is missing: cd interview-agent && npm install)"
    mark "build-failed"
    idle_forever
fi
say "build OK"

while true; do
    say "starting worker: node dist/main.js dev (log: $AGENT_LOG)"
    (cd "$AGENT_DIR" && exec node dist/main.js dev) > >(tee -a "$AGENT_LOG") 2>&1 &
    CHILD_PID=$!
    echo "$CHILD_PID" > "$AGENT_PID_FILE"
    wait "$CHILD_PID"
    code=$?
    [ "$STOPPING" = "1" ] && break
    say "⚠️  worker exited (code $code) — restarting in ${RESTART_DELAY_SECONDS}s (Ctrl+C to stop)"
    mark "worker-exited code=$code"
    nap "$RESTART_DELAY_SECONDS"
    [ "$STOPPING" = "1" ] && break
done
