# Orchestrator queue

Work the orchestrator owes at a gate because no running bundle owns the file. Remove a line when it is done.

## After each market phase (M1 … M5)

- Gate with `orch/workflows/wave-gate.js`; after M1 run `npm run eval:match -- --enforce M1` (must exit 0), after M2 `--enforce M2`, and so on (market-bundles note on the harness).
- Read the phase's `Schema requests`; additive ones are applied by the orchestrator (`prisma validate`, `check-schema-additive.mjs --sql`, `prisma db execute`, second diff empty).

## At the M4 gate (from the M2 gate cross-review, 2026-10-11)

- GoApply alerts and the lifecycle tip choose and print a fit for a person without the 个性化推荐 grant. No bundle owns `features/alerts/` or `features/lifecycle/` in M4, and the owner has to choose between two behaviours first (`requests/waveM2-carryover.md`, Orchestrator 3c and Owner 24).
- Check that MKT-4B's admin refund sends `attemptKey` (carry-over MKT-4B.2a) and that MKT-4A lists every open withdrawal (`withdrawalQuotes`, MKT-4A.1a) before either route ships.

## At the M4 gate (from the M3 gate, 2026-10-11)

- `npm run eval:match -- --enforce M4` (the phase name changes here; `--enforce M2` exited 0 at the M3 gate). The ranking baseline (`server/src/features/match/eval/fixtures/baselines.json`) is unchanged since the M1 gate; a lower value is accepted only by the owner, with `npm run eval:match -- --write-baseline`, never by editing the file.
- Re-read `ALIPAY_CUTOVER.md` 4.3 g and `STRIPE_TEST_RECIPE.md` 5.1 rows 10a and 11 and section 7 against what MKT-4A, MKT-4B and MKT-4C built; they say "available after phase M4" (`requests/waveM3-carryover.md`, Orchestrator, "At the M4 gate").
- JC-5 (nine mainland deep links) is built and not delivered: three boards are live. Do not record it as delivered until the owner has filled a campus board's row (`requests/waveM3-carryover.md`, Owner 9).
- If MKT-4F changes the feed's age floor to the boards that expire by age, `tw_open_data` keeps the floor until the owner has answered `requests/waveM3-carryover.md` Owner 1 (MKT-4F.1 there).
- Three hold-outs of the M3 cross-review end with the bundle that prints the 台灣就業通 credit line on its surface: the Assistant's job lists (MKT-4H.1, `copilot/tools/jobs.ts` `creditablePreview`) in M4; similar jobs (MKT-5C.3) in M5; job alerts and Ready to apply have no owner (`requests/waveM3-carryover.md`, Orchestrator 3). Check at this gate that MKT-4H removed its hold-out together with the change that prints the line, and that it kept the three LinkedIn rules of `job-search/normalization.ts` (MKT-4H.2).
- Everything else M3 handed on, by target bundle, with the owner list, the schema comment requests and what the first cron runs after the merge do: `requests/waveM3-carryover.md`. The M4 and M5 sections of `requests/waveM1-carryover.md` and `requests/waveM2-carryover.md` still apply.

## After the last market phase

- Merge `i18n/staging` once (`node scripts/i18n-merge-staging.mjs`, dry run first), translate the delta into the eight other locales, QA per locale, `npm run check`. `_pending-translation.json` is cumulative and stale: compute the real gap per locale (keys of `en.json` missing from the locale bundle). The key lists and the keys to remove are in `requests/wavePAR-carryover.md`, section "i18n merge and translate", and in `requests/waveM1-carryover.md`, section "Orchestrator" (items 4 to 8), and in `requests/waveM2-carryover.md`, section "Orchestrator" (items 7 to 10; it adds server email strings and five extension strings). M3 adds `requests/waveM3-carryover.md`, section "Orchestrator" (items 12 to 16: the `admin`, `jobsCn` and `jobsTw` keys, the changed strings, and the zh-TW role labels, which are filled from the taxonomy data file and not translated). The M3 cross-review staged `jobSearch.intro` (new file `i18n/staging/jobSearch.en.json`): in the same step change `components/job-search/messages.en.json` to the same sentence and remove the three `jobSearch.linkedin_*` keys from it and from the nine bundles (`node scripts/check-job-search-locales.mjs` compares the two).
- Neon branch data: archive any `market = 'cn'` row whose `sourceBoard` is a RapidAPI aggregator (read paths already exclude them); delete the `claude-verify-*` test users.
- Production build in a separate worktree, with the `/legal` file-trace check; browser verification of both brands (`orch/parity-verify.md` first); PR.

## Before `feat/jobright-clone` reaches production (owner)

- `ALLOWED_BRANDS=roboapply` on Vercel Production and Preview unless GoApply is to go live at the same time.
- Run `server/prisma/sql/001_vector.sql` and the additive push (`server/prisma/sql/README.md`) on the production database before the deploy.
- A `sk_test_` Stripe key and a `stripe listen` secret for browser verification; the clone `.env` holds a live key.
- RoboApply's international feed is 30 employer boards on a fresh deployment and has no launch criterion yet: decide one and run the board import before the clone replaces production on roboapply.io (`requests/waveM3-carryover.md`, Owner 20 and Operations 24).
- Read "What the first runs after this merge do" in `requests/waveM3-carryover.md` (Orchestrator 17 to 22) before the first cron runs against a database: the first `jobs-plan`, `jobs-maintain` and `jobs-boards` rewrite queries, priorities and bank rows, and the first RoboApply ingest tick starts the 台灣就業通 sweep unless `TW_OPEN_DATA_JOBS_ENABLED=false`.
- Subscribe the Stripe Dashboard endpoint to the fourteen event types of `EXPECTED_STRIPE_EVENTS` (eight are new in M2, `charge.refunded` and `charge.dispute.created` among them), and run the two data steps of `requests/waveM2-carryover.md` (the search-document backfill and the skills dry runs) on each database after its push.
- `deploy/cn/compose.yaml` `localdb` now names `pgvector/pgvector:0.8.0-pg16` (PAR gate, MKT-0 O-5). The image was not pulled or run at the gate: at its first start, and on the mainland RDS instance, run `SELECT extversion FROM pg_extension WHERE extname = 'vector';` after `001_vector.sql` and confirm 0.7.0 or newer before any push.
- The rest of what the parity wave leaves for the owner is in `requests/wavePAR-carryover.md`, section "Owner". The market wave's owner lists are in `requests/waveM1-carryover.md`, `requests/waveM2-carryover.md` and `requests/waveM3-carryover.md`, section "Owner".
