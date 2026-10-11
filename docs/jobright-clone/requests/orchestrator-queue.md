# Orchestrator queue

Work the orchestrator owes at a gate because no running bundle owns the file. Remove a line when it is done.

## After each market phase (M1 … M5)

- Gate with `orch/workflows/wave-gate.js`; after M1 run `npm run eval:match -- --enforce M1` (must exit 0), after M2 `--enforce M2`, and so on (market-bundles note on the harness).
- Read the phase's `Schema requests`; additive ones are applied by the orchestrator (`prisma validate`, `check-schema-additive.mjs --sql`, `prisma db execute`, second diff empty).

## At the M2 gate (from the M1 gate, 2026-10-11)

- MKT-2B must have done both halves of the webhook-secret change or neither: `routes/stripeWebhook.ts` tries every secret of `stripeWebhookSecrets()` AND `STRIPE_WEBHOOK_TRIES_EVERY_SECRET` in `platform/billing/stripeEnv.ts` is true (its test assertion flipped). With the route change alone a secret list still keeps the rail closed; with the constant alone a list opens checkout and every webhook is rejected. Details: `requests/waveM1-carryover.md`, MKT-2B item 1.
- The ranking baseline (`server/src/features/match/eval/fixtures/baselines.json`) was rewritten at the M1 gate from the merged fit order. A lower value is accepted only by the owner, with `npm run eval:match -- --write-baseline`, never by editing the file.
- Everything else M1 handed on, by target bundle, with the owner list and the optional schema request: `requests/waveM1-carryover.md`.

## After the last market phase

- Merge `i18n/staging` once (`node scripts/i18n-merge-staging.mjs`, dry run first), translate the delta into the eight other locales, QA per locale, `npm run check`. `_pending-translation.json` is cumulative and stale: compute the real gap per locale (keys of `en.json` missing from the locale bundle). The key lists and the keys to remove are in `requests/wavePAR-carryover.md`, section "i18n merge and translate", and in `requests/waveM1-carryover.md`, section "Orchestrator" (items 4 to 8).
- Neon branch data: archive any `market = 'cn'` row whose `sourceBoard` is a RapidAPI aggregator (read paths already exclude them); delete the `claude-verify-*` test users.
- Production build in a separate worktree, with the `/legal` file-trace check; browser verification of both brands (`orch/parity-verify.md` first); PR.

## Before `feat/jobright-clone` reaches production (owner)

- `ALLOWED_BRANDS=roboapply` on Vercel Production and Preview unless GoApply is to go live at the same time.
- Run `server/prisma/sql/001_vector.sql` and the additive push (`server/prisma/sql/README.md`) on the production database before the deploy.
- A `sk_test_` Stripe key and a `stripe listen` secret for browser verification; the clone `.env` holds a live key.
- `deploy/cn/compose.yaml` `localdb` now names `pgvector/pgvector:0.8.0-pg16` (PAR gate, MKT-0 O-5). The image was not pulled or run at the gate: at its first start, and on the mainland RDS instance, run `SELECT extversion FROM pg_extension WHERE extname = 'vector';` after `001_vector.sql` and confirm 0.7.0 or newer before any push.
- The rest of what the parity wave leaves for the owner is in `requests/wavePAR-carryover.md`, section "Owner".
