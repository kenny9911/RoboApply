#!/bin/bash
# Dev stack for the jobright-clone worktree on its own ports, so the main checkout's
# stack (web 3611 / API 4611) keeps working: API 4621, web 3621, and an interview worker
# registered under its own agent name so it never takes the main stack's dispatches.
#   RoboApply: http://localhost:3621     GoApply: http://goapply.localhost:3621
#
# Both brands run from the same .env (owner ruling D5, docs/jobright-clone/GOAPPLY_PARITY_PLAN.md).
# GoApply needs no variable of its own: with only the shared credentials it has AI, the job
# feed, email, voice practice and open sign-up, because every CN_<NAME> value is an optional
# override of <NAME> and unset means the shared stack. Set a CN_ value in .env only to try a
# China-specific provider. Nothing here turns a GoApply feature on or off.
set -uo pipefail
cd "$(dirname "$0")/.."
export PORT=4621
export NEXT_PUBLIC_API_URL=http://localhost:4621
export NEXT_PUBLIC_SHOW_ALL_NAV="${NEXT_PUBLIC_SHOW_ALL_NAV:-true}"   # dev override: show not-yet-flipped nav entries
export INTERVIEW_ENGINE_AGENT_NAME="${INTERVIEW_ENGINE_AGENT_NAME_CLONE:-RoboApply-Interview-Clone}"
# Phone sign-in demo (optional, dev only): one-time codes are printed in the API log instead
# of being sent by SMS, so the GoApply phone tab can be tried without an SMS provider. Email
# and password sign-in works on GoApply without it. SMS_DEV_CONSOLE=false hides the phone tab.
export SMS_DEV_CONSOLE="${SMS_DEV_CONSOLE:-true}"
# GOAPPLY_PREVIEW is retired: it used to switch on a GoApply preview profile (a domestic
# model, the feed, the campus calendar, open sign-up). Those are defaults now, so the variable
# is accepted and ignored for one release.
if [ -n "${GOAPPLY_PREVIEW:-}" ]; then
  echo "dev-clone: GOAPPLY_PREVIEW is no longer read; GoApply runs on the shared stack by default." >&2
fi
exec npx concurrently --kill-others --kill-signal SIGINT --names api,web,agent \
  "npx tsx watch server/src/app.ts" \
  "bash -c 'until curl -sf http://localhost:4621/api/health >/dev/null; do sleep 0.5; done; exec npx next dev -p 3621'" \
  "./scripts/dev-interview-agent.sh"
