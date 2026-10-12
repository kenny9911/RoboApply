#!/bin/bash
# usage: wave-cleanup.sh <ID>...  — remove a work item's worktree ONLY when it is safe:
# the worktree has no uncommitted changes AND its branch has commits that are merged into the
# clone branch. A branch with no commits of its own is NOT "merged" — it means nothing was
# committed, and removing the worktree would destroy the work (this happened once; never again).
set -uo pipefail
CLONE=/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone
WTROOT=/Users/kenny/code/RoboApply/.claude/worktrees
BASE=${WAVE_BASE:?set WAVE_BASE to the tag the worktrees were cut from}
for id in "$@"; do
  wt="$WTROOT/wp-$id"
  [ -d "$wt" ] || { echo "skip $id: no worktree"; continue; }
  dirty=$(git -C "$wt" status --porcelain | grep -v -E '^\?\? (node_modules|interview-agent/node_modules|extension/node_modules)$' | wc -l | tr -d ' ')
  ahead=$(git -C "$CLONE" rev-list --count "$BASE..wp/$id" 2>/dev/null || echo 0)
  if [ "$dirty" != "0" ]; then echo "KEEP $id: $dirty uncommitted change(s)"; continue; fi
  if [ "$ahead" = "0" ]; then echo "KEEP $id: branch has no commits (nothing was committed)"; continue; fi
  if ! git -C "$CLONE" merge-base --is-ancestor "wp/$id" HEAD; then echo "KEEP $id: not merged"; continue; fi
  for l in node_modules interview-agent/node_modules extension/node_modules; do [ -L "$wt/$l" ] && unlink "$wt/$l"; done
  git -C "$CLONE" worktree remove "$wt" && git -C "$CLONE" branch -q -D "wp/$id" && echo "removed $id"
done
