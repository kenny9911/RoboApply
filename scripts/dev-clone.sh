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
# Local GoApply preview (dev only). In production every one of these is gated on something
# real — a mainland recruitment licence, SMS/WeChat credentials, a domestic model contract,
# counsel sign-off (docs/jobright-clone/CN_TW_LAUNCH_PLAN.md) — so GoApply ships with them off.
# This block turns on what this machine can honestly run, so the GoApply surfaces can be seen:
#   - AI: DeepSeek (a domestic provider; uses DEEPSEEK_API_KEY from .env). GoApply never falls
#     back to an international model, so without this its AI features stay hidden.
#   - Phone sign-in: one-time codes are printed in the API log instead of being sent by SMS.
#   - Job feed + campus calendar: shown as if the recruitment-info licence were in place.
#   - Sign-up: open (no invite code).
# Payments, WeChat login, email and voice interviews stay off: they need real credentials.
# GOAPPLY_PREVIEW=0 ./scripts/dev-clone.sh runs GoApply exactly as production would.
if [ "${GOAPPLY_PREVIEW:-1}" = "1" ]; then
  export CN_LLM_PROVIDER="${CN_LLM_PROVIDER:-deepseek}"
  export CN_LLM_MODEL="${CN_LLM_MODEL:-deepseek/deepseek-v4-flash}"
  export SMS_DEV_CONSOLE="${SMS_DEV_CONSOLE:-true}"
  export CN_RECRUITMENT_INFO_MODE="${CN_RECRUITMENT_INFO_MODE:-licensed}"
  export CN_CAMPUS_CALENDAR_ENABLED="${CN_CAMPUS_CALENDAR_ENABLED:-true}"
  export CN_SIGNUP_MODE="${CN_SIGNUP_MODE:-open}"
fi
exec npx concurrently --kill-others --kill-signal SIGINT --names api,web,agent \
  "npx tsx watch server/src/app.ts" \
  "bash -c 'until curl -sf http://localhost:4621/api/health >/dev/null; do sleep 0.5; done; exec npx next dev -p 3621'" \
  "./scripts/dev-interview-agent.sh"
