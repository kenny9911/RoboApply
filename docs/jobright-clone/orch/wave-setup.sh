#!/bin/bash
# usage: wave-setup.sh <base-ref> <ID>...   — one worktree + branch per work item from the base ref
set -uo pipefail
CLONE=/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone
WTROOT=/Users/kenny/code/RoboApply/.claude/worktrees
BASE=$1; shift
for id in "$@"; do
  wt="$WTROOT/wp-$id"
  if [ -d "$wt" ]; then echo "exists: $wt"; continue; fi
  git -C "$CLONE" worktree add -q "$wt" -b "wp/$id" "$BASE" || { echo "FAILED worktree $id"; continue; }
  ln -s "$CLONE/node_modules" "$wt/node_modules"
  [ -d "$CLONE/interview-agent/node_modules" ] && [ -d "$wt/interview-agent" ] && ln -s "$CLONE/interview-agent/node_modules" "$wt/interview-agent/node_modules"
  [ -d "$CLONE/extension/node_modules" ] && [ -d "$wt/extension" ] && ln -s "$CLONE/extension/node_modules" "$wt/extension/node_modules"
  cp "$CLONE/.env" "$wt/.env"; chmod 600 "$wt/.env"; cp "$CLONE/.env.local" "$wt/.env.local"
  [ -f "$CLONE/interview-agent/.env.local" ] && cp "$CLONE/interview-agent/.env.local" "$wt/interview-agent/.env.local"
  ( cd "$wt" && npx prisma generate >/dev/null 2>&1 && echo "ready: wp-$id" || echo "GENERATE FAILED: wp-$id" ) &
done
wait
