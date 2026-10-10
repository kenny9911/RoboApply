# Orchestrator tooling (jobright clone)

Kept in the repo because the session scratchpad lives in /tmp and does not survive a restart.

- `wave-setup.sh <base-ref> <ID>...` — one git worktree + branch `wp/<ID>` per work item under
  `.claude/worktrees/wp-<ID>`, with node_modules symlinked from the clone worktree, the clone's
  `.env`/`.env.local` copied in (gitignored) and the Prisma client generated.
- `wave_commit.py [--items <json>] [--dry-run] [--no-merge] [--allow ID:path ...] ID...` —
  commits each worktree's changes on its branch after checking every changed path against the
  item's `owns` list, then merges into `feat/jobright-clone`. `--items` defaults to
  `int-bundles.json`; any JSON list of `{id, title, owns, namespace?}` works.
- `apply-translations.mjs <repoRoot> <chunksDir> [--dry-run]` — validates translator chunk files
  (EN key exists, ICU parses, same argument names, same %BRAND% counts, no literal brand names)
  and deep-merges accepted leaves into the locale bundles.
- `int-bundles.json` — the WP-93 final-wiring breakdown (14 bundles, disjoint ownership).
