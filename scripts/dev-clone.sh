#!/bin/bash
# Dev stack for the jobright-clone worktree on its own ports, so the main checkout's
# stack (web 3611 / API 4611) keeps working: API 4621, web 3621, and an interview worker
# registered under its own agent name so it never takes the main stack's dispatches.
#   RoboApply: http://localhost:3621     GoApply: http://goapply.localhost:3621
set -uo pipefail
cd "$(dirname "$0")/.."
export PORT=4621
export NEXT_PUBLIC_API_URL=http://localhost:4621
export NEXT_PUBLIC_SHOW_ALL_NAV="${NEXT_PUBLIC_SHOW_ALL_NAV:-true}"   # dev override: show not-yet-flipped nav entries
export INTERVIEW_ENGINE_AGENT_NAME="${INTERVIEW_ENGINE_AGENT_NAME_CLONE:-RoboApply-Interview-Clone}"
exec npx concurrently --kill-others --kill-signal SIGINT --names api,web,agent \
  "npx tsx watch server/src/app.ts" \
  "bash -c 'until curl -sf http://localhost:4621/api/health >/dev/null; do sleep 0.5; done; exec npx next dev -p 3621'" \
  "./scripts/dev-interview-agent.sh"
