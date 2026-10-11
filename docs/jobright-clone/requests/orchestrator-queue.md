# Orchestrator queue

Work the orchestrator owes at a gate because no running bundle owns the file. Remove a line when it is done.

## After each market phase (M1 … M5)

- Gate with `orch/workflows/wave-gate.js`; after M1 run `npm run eval:match -- --enforce M1` (must exit 0), after M2 `--enforce M2`, and so on (market-bundles note on the harness).
- Read the phase's `Schema requests`; additive ones are applied by the orchestrator (`prisma validate`, `check-schema-additive.mjs --sql`, `prisma db execute`, second diff empty).

## At the M3 gate (from the M2 gate, 2026-10-11)

- The ranking baseline (`server/src/features/match/eval/fixtures/baselines.json`) is unchanged since the M1 gate; `npm run eval:match -- --enforce M2` exited 0 at the M2 gate and must still exit 0 after M3 (the phase name changes at M4). A lower value is accepted only by the owner, with `npm run eval:match -- --write-baseline`, never by editing the file.
- New `RAJob` write paths of M3 leave `contentHash`, `searchDoc`, `searchTsv` and `lang` to the `job.index` worker, and a new or changed posting reaches it (`requests/waveM2-carryover.md`, Orchestrator 2).
- Everything else M2 handed on, by target bundle, with the owner list, the data steps and the optional schema requests: `requests/waveM2-carryover.md`. The M3, M4 and M5 sections of `requests/waveM1-carryover.md` still apply.

## At the M4 gate (from the M2 gate cross-review, 2026-10-11)

- GoApply alerts and the lifecycle tip choose and print a fit for a person without the 个性化推荐 grant. No bundle owns `features/alerts/` or `features/lifecycle/` in M4, and the owner has to choose between two behaviours first (`requests/waveM2-carryover.md`, Orchestrator 3c and Owner 24).
- Check that MKT-4B's admin refund sends `attemptKey` (carry-over MKT-4B.2a) and that MKT-4A lists every open withdrawal (`withdrawalQuotes`, MKT-4A.1a) before either route ships.

## After the last market phase

- Merge `i18n/staging` once (`node scripts/i18n-merge-staging.mjs`, dry run first), translate the delta into the eight other locales, QA per locale, `npm run check`. `_pending-translation.json` is cumulative and stale: compute the real gap per locale (keys of `en.json` missing from the locale bundle). The key lists and the keys to remove are in `requests/wavePAR-carryover.md`, section "i18n merge and translate", and in `requests/waveM1-carryover.md`, section "Orchestrator" (items 4 to 8), and in `requests/waveM2-carryover.md`, section "Orchestrator" (items 7 to 10; it adds server email strings and five extension strings).
- Neon branch data: archive any `market = 'cn'` row whose `sourceBoard` is a RapidAPI aggregator (read paths already exclude them); delete the `claude-verify-*` test users.
- Production build in a separate worktree, with the `/legal` file-trace check; browser verification of both brands (`orch/parity-verify.md` first); PR.

## Before `feat/jobright-clone` reaches production (owner)

- `ALLOWED_BRANDS=roboapply` on Vercel Production and Preview unless GoApply is to go live at the same time.
- Run `server/prisma/sql/001_vector.sql` and the additive push (`server/prisma/sql/README.md`) on the production database before the deploy.
- A `sk_test_` Stripe key and a `stripe listen` secret for browser verification; the clone `.env` holds a live key.
- Subscribe the Stripe Dashboard endpoint to the fourteen event types of `EXPECTED_STRIPE_EVENTS` (eight are new in M2, `charge.refunded` and `charge.dispute.created` among them), and run the two data steps of `requests/waveM2-carryover.md` (the search-document backfill and the skills dry runs) on each database after its push.
- `deploy/cn/compose.yaml` `localdb` now names `pgvector/pgvector:0.8.0-pg16` (PAR gate, MKT-0 O-5). The image was not pulled or run at the gate: at its first start, and on the mainland RDS instance, run `SELECT extversion FROM pg_extension WHERE extname = 'vector';` after `001_vector.sql` and confirm 0.7.0 or newer before any push.
- The rest of what the parity wave leaves for the owner is in `requests/wavePAR-carryover.md`, section "Owner". The market wave's owner lists are in `requests/waveM1-carryover.md` and `requests/waveM2-carryover.md`, section "Owner".
