#!/usr/bin/env bash
# Turn the Parley practice-interview pilot on in Vercel PRODUCTION.
#
#   scripts/parley-vercel-env.sh <provision-output> <allowlist>
#
#   <provision-output>  file holding the PARLEY_* lines that
#                       scripts/parley-provision.ts printed for the production
#                       Parley node (its webhook must point at
#                       https://www.roboapply.io/api/v1/interview-engine/webhooks/parley)
#   <allowlist>         who gets Parley: comma-separated emails / user ids, or
#                       "all". Required on purpose — there is no default.
#
# Values are read from the file and piped to `vercel env add`, never put on a
# command line. Production picks them up on the next deployment (this script
# does not deploy). DRY_RUN=1 prints what would change.
set -euo pipefail

file="${1:?usage: $0 <provision-output> <allowlist>}"
allow="${2:?usage: $0 <provision-output> <allowlist>  (comma list of emails / user ids, or all)}"
vercel="${VERCEL_CLI:-npx --yes vercel}"
cd "$(dirname "$0")/.."
[ -f .vercel/project.json ] || { echo "not linked to a Vercel project (run: npx vercel link)"; exit 1; }

set_env() {
  local name="$1" value="$2"
  if [ -n "${DRY_RUN:-}" ]; then
    echo "would set $name (${#value} chars) in production"
    return
  fi
  $vercel env rm "$name" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | $vercel env add "$name" production >/dev/null
  echo "set $name"
}

found=0
for name in PARLEY_URL PARLEY_API_KEY PARLEY_WEBHOOK_SECRET PARLEY_AGENT_ID PARLEY_TTS_PROFILES; do
  value="$(grep -E "^${name}=" "$file" | tail -1 | cut -d= -f2- || true)"
  if [ -z "$value" ]; then
    [ "$name" = PARLEY_TTS_PROFILES ] && continue # optional
    echo "missing $name in $file"; exit 1
  fi
  case "$name:$value" in
    PARLEY_URL:https://*) ;;
    PARLEY_URL:*) echo "PARLEY_URL must be https in production (browsers block mixed content): $value"; exit 1 ;;
  esac
  set_env "$name" "$value"
  found=$((found + 1))
done
set_env INTERVIEW_ENGINE_PARLEY_PILOT "$allow"

echo "done ($found Parley values + the pilot allowlist). Redeploy production to apply: npx vercel --prod (or push to main)."
