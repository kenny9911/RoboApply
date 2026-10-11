# Orchestrator queue

Work the orchestrator owes at a gate because no running bundle owns the file. Remove a line when it is done.

## At the parity-wave (PAR) gate

- Merge `i18n/staging` (dry run first), translate the delta into the eight other locales, `npm run check`. The key lists and the keys to remove afterwards are in `requests/wavePAR-carryover.md`, section "i18n merge and translate".
- Neon branch data: archive any `market = 'cn'` row whose `sourceBoard` is a RapidAPI aggregator (read paths already exclude them).

## Before `feat/jobright-clone` reaches production (owner)

- `ALLOWED_BRANDS=roboapply` on Vercel Production and Preview unless GoApply is to go live at the same time.
- Run `server/prisma/sql/001_vector.sql` and the additive push (`server/prisma/sql/README.md`) on the production database before the deploy.
- A `sk_test_` Stripe key and a `stripe listen` secret for browser verification; the clone `.env` holds a live key.
- `deploy/cn/compose.yaml` `localdb` now names `pgvector/pgvector:0.8.0-pg16` (PAR gate, MKT-0 O-5). The image was not pulled or run at the gate: at its first start, and on the mainland RDS instance, run `SELECT extversion FROM pg_extension WHERE extname = 'vector';` after `001_vector.sql` and confirm 0.7.0 or newer before any push.
- The rest of what the parity wave leaves for the owner is in `requests/wavePAR-carryover.md`, section "Owner".
