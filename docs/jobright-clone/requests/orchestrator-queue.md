# Orchestrator queue

Work the orchestrator owes at a gate because no running bundle owns the file. Remove a line when it is done.

## At the parity-wave (PAR) gate

- **MKT-0 O-2:** `server/src/features/auth/accountDeletion.test.ts`: add `RABillingConsentArchive` to `KEPT_BY_DESIGN` (proof of a checkout acknowledgement that must outlive the account; compliance-daily deletes it at `retainUntil`).
- **MKT-0 O-3:** `server/src/roboapply/services/SeekerAccountPurgeService.ts` `deleteRowsWithoutUserFk`: add `prisma.rABillingRefund.deleteMany({ where: { userId } })` to the transaction, and the delegate to the hand-made mock in `SeekerAccountPurgeService.brand.test.ts`.
- **MKT-0 O-5:** `deploy/cn/compose.yaml` `localdb` image → one that ships pgvector 0.7.0 or newer (check the version query); `docs/runbooks/cn-deploy.md` section 3 item 4 and section 6: run `server/prisma/sql/001_vector.sql` and confirm the version before the push.
- **MKT-0 O-7:** `deploy/cn/migration/plan.mjs`: a `MANUAL_SCOPES` entry that copies the whole `RASkill` table (shared vocabulary that `RAJob.skillIds` points to).
- Apply the Requests of `orch/handoffs-par/*.md` addressed to the orchestrator; run `npm run gen:brand`; remove the `'linkedin'` literal from the `JobProvider` union if PAR-7 reports nothing names it.
- Merge `i18n/staging` (dry run first), translate the delta into the eight other locales, `npm run check`.
- Neon branch data: archive any `market = 'cn'` row whose `sourceBoard` is a RapidAPI aggregator (read paths already exclude them).

## Before `feat/jobright-clone` reaches production (owner)

- `ALLOWED_BRANDS=roboapply` on Vercel Production and Preview unless GoApply is to go live at the same time.
- Run `server/prisma/sql/001_vector.sql` and the additive push (`server/prisma/sql/README.md`) on the production database before the deploy.
- A `sk_test_` Stripe key and a `stripe listen` secret for browser verification; the clone `.env` holds a live key.
