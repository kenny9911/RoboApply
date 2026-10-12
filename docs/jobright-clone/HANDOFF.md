# Handoff: finishing the Jobright clone (branch `feat/jobright-clone`)

Written 2026-10-12 for whoever continues this work (a person, Codex, or another agent session) with no memory of the earlier sessions. Keep the "State" section current: update it when a step below is finished.

## 1. What this branch is

One codebase, two brands, resolved per request from the Host header:

- **RoboApply** (roboapply.io): international market, Taiwan included. Market `intl`. Pays with Stripe, prices in USD.
- **GoApply** (goapply.top): mainland China. Market `cn`. Pays with Alipay (the existing implementation), prices in CNY.

Owner rulings that bind every change (full text in `docs/jobright-clone/README.md`):

- **D1**: the product never submits a job application. It prepares everything; the user clicks Submit.
- **D3**: never fabricate data, sources, licences, prices or counts.
- **D5**: both brands have the same functionality. China-specific providers (`CN_*` variables) are optional overrides that fall back to the shared stack. Only job boards, job sources, job-search APIs and what follows from the market differ.
- **D6**: sources, prices and payment rails are per market. Alipay must keep working exactly as it does; Stripe serves the international brand only.

## 2. Where to work

- Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone`, branch `feat/jobright-clone`, pushed to `origin` up to the commit section 3 names; the M5 gate's own changes are in the working tree until they are committed (section 3 says how to tell). Nothing from this work is on `main`. Do not merge to `main` or deploy without the owner's confirmation.
- Its `.env` points at the Neon **branch** database `jobright-clone` (endpoint `ep-quiet-king-a6psbfbe`), never production (`ep-empty-snow-a6mdqwbe`). Check with `grep -E '^(DATABASE_URL|DIRECT_DATABASE_URL)=' .env | sed -E 's#://[^@]*@#://<redacted>@#'` before any database command.
- Dev stack: `scripts/dev-clone.sh` (API 4621, web 3621). RoboApply at `http://localhost:3621`, GoApply at `http://goapply.localhost:3621`.
- Never print or commit secrets. The `.env` holds a **live** Stripe key; the code refuses to use it outside production, and no command or test may call Stripe or any other paid provider. One exception is deliberate and bounded: the job crons of step 5 call the job sources this `.env` has keys for (the step lists them and names the switch that avoids every metered call).

## 3. State (2026-10-12)

Merged, gated and pushed, in order:

| Step | Commit | What |
|---|---|---|
| Waves 1–5, final wiring, translations, browser-verification fix pass | `606365f` | The Jobright feature set on both brands |
| Parity wave PAR-1…PAR-11 | `d50446b` | GoApply on the shared stack with every capability on by default (`GOAPPLY_PARITY_PLAN.md`) |
| Schema SCHEMA-7, SCHEMA-8 | `da93156`, `54fa08d` | pgvector, embeddings, skills, billing records, `RAJob.headcount`; applied to the Neon branch |
| Market phase M1 | `0dbe2ef` | Stripe live-key guard, catalog sync, USD and CNY price defaults, fit contract, evaluation harness |
| Market phase M2 | `48a5e56` | Stripe webhook lifecycle, switch, resume, refunds; Alipay wire parity (additive); skills; embeddings |
| Market phase M3 | `55e7177` | Job sources per market: quota, planner, posting identity, employer boards, Taiwan open data, deep links |
| Market phase M4 | `df4aaf2` | Hybrid retrieval, scorer v4, withdrawal and admin billing, validated board seeds (505 intl / 41 TW / 52 CN) |
| Market phase M5 (merged; **gate done 2026-10-12**) | `198ee6b`, then the gate's own commit | Licensed feed behind its quota gate, more board connectors, closure and liveness check, USAJobs and 事求人, GoHire syndication adapter, Taiwan extras, sponsorship facts, env examples. Gate, after its cross-review fix pass: 779 test files / 20,853 tests passed (1 skipped, 10 todo), both typechecks, `npm run check`, extension 710 tests, `npm run eval:match -- --enforce M4` |
| Step 3: i18n merge and translation | `348d2db`, `a713ab6`, `14c1af8` | Staged strings merged; tests read the merged bundles; 8,412 strings translated into the eight locales; 59 unread keys retired. `npm run check` clean, both typechecks, extension 710 tests |
| Step 4: production build | build worktree | `npm run build` exit 0 on `31b893d` and again on the branch head before the PR; both `/legal` routes trace all 17 files of `content/legal/` |
| Step 5: browser and API verification, fixes | `be76c6c`, `e89af45`, `3e1cfd9`, `27c3789` | Report in `orch/parity-verify-results.md`. Fixed: an empty "About the job" on every employer-board posting; "BS/MS" read as a master's in the keyword check; one malformed planner answer failing the sentence search; GoApply's English page under a Chinese title |
| Step 6: clean-up and PR | (database only), PR #4 | Ten `claude-verify-*` users deleted on the Neon branch as the account purge would; no mainland JSearch, LinkedIn or Active Jobs DB row existed to archive. Draft PR https://github.com/kenny9911/RoboApply/pull/4 into `main` (not merged; it lists the owner items of section 6) |

Last full gate run (M5, 2026-10-12, after the cross-review fix pass): `npx prisma validate`, `npm run db:generate`, `npm run gen:brand` (no diff), both typechecks, 779 test files / 20,853 tests passed (1 skipped, 10 todo, 0 failed), `npm run check` (six checks clean), extension typecheck and 710 tests (36 files), `npm run eval:match -- --enforce M4` exit 0 with the ranking baseline untouched. `interview-agent/` did not change in M5 and was not run. Nothing was run against a database, a browser or a provider.

**The M5 gate is done (steps 1 and 2 below).** The 13 tests that were red at the seams between bundles are green: one was fixed in code (`normalize/ats.ts`: the posting-key rule covers the nine board systems), twelve on the test side (they pinned the tree before M5). The gate also applied the small requests the bundles addressed to the orchestrator, added `server/src/features/m5Seams.test.ts`, and wrote what stays open to `requests/waveM5-carryover.md`, by who must act. The gate's cross-review (three medium and nine low findings) is resolved as well: what was fixed and what was carried is in `requests/waveM5-carryover.md` ("Applied after the cross-review of the gate", fix package X1 to X4).

The M5 gate is committed and pushed as `4e449f6` (the paragraph about uncommitted gate paths no longer applies).

**Step 3 is done (2026-10-12).** The merge (`348d2db`) emptied every staging file, which broke eleven test files that imported staged strings (17 type errors stopped the production build, 17 tests failed): `a713ab6` points them at the merged bundles. The translation pass then applied 8,412 strings in 39 chunks (web 8,077, email 295, extension 40; every chunk validated with 0 rejected leaves), corrected one mistranslation found on the way (`credits.admin.refunds.facts.paidThrough` names the payment method, six locales had read it as "paid until"), and removed the 59 keys the gates listed as unread (PAR, M1 to M5 and FIX carry-overs; each grep-checked; `npm run check` resolves every call site). Kept on purpose: `legal.explain.notStated.{title_level,industry,logistics}` (M1 said remove them only if `EXPLAIN_KEYS` still lacks them; it does, but the open fix of `waveM5-carryover.md` item 9 brings back the posting-side-missing sentence, which is exactly these keys). `npm run check` is green.

**Steps 4 to 6 are done (2026-10-12)**; what was checked, what was fixed and what could not be checked is in `orch/parity-verify-results.md`. What is left is the owner's: section 6, and the "not configured" lines of that report (a verified mail sender, an S3 key that can write, `ALIPAY_CALLBACK_SECRET`, a Stripe test key, the VAPID keys, the sponsorship importers, a microphone for voice practice).

**How step 5 was run, for a rerun: on a stack that cannot reach anyone.** The Neon branch is a copy of production, and the dev API registers the platform crons in process (job alerts every 15 minutes, lifecycle e-mails and reminders hourly, queue-drain every 5 minutes). Earlier runs tried to send alert and lifecycle mail and web push; every attempt failed (Resend: `roboapply.io` not verified, `example.com` refused), so nothing was delivered, but that is luck, not design. Start the stack for verification with these lines in `.env.local` (not `.env`; remove them afterwards): `ROBOAPPLY_CRON_DISABLED=true` (no in-process schedule), `ENRICH_DAILY_JOBS=0` (no LLM enrichment: 43,305 `job.enrich` items were queued on 2026-10-12, up to 8,000 model calls a day per market), `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true` (no metered job-search calls). Trigger only `jobs-plan`, `jobs-boards` and `jobs-ingest` by hand; `queue-drain` runs every worker kind (notifications and push included) and `score-precompute` scores real users' copies. The feed is already stocked on the branch (about 49,600 open international and 2,050 mainland rows from the employer boards on 2026-10-11).

## 4. What remains, in order

### Step 1. Merge market phase M5

```bash
cd /Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone
# a) each worktree must have a finished handoff and green tests in its own files
for b in 5A 5B 5C 5D 5E 5F 5G 5H; do git -C ../wp-MKT-$b status --porcelain | wc -l; done
# b) ownership check (prints UNOWNED paths; colocated test files of owned files are fine)
python3 docs/jobright-clone/orch/wave_commit.py --items docs/jobright-clone/orch/market-bundles.json --dry-run MKT-5A MKT-5B MKT-5C MKT-5D MKT-5E MKT-5F MKT-5G MKT-5H
# c) commit the handoffs, then commit each bundle on its branch and merge (add --allow ID:path for each accepted unowned test file)
git add docs/jobright-clone/orch/handoffs-mkt && git commit -m "docs(orch): market phase M5 handoffs"
python3 docs/jobright-clone/orch/wave_commit.py --items docs/jobright-clone/orch/market-bundles.json MKT-5A MKT-5B MKT-5C MKT-5D MKT-5E MKT-5F MKT-5G MKT-5H
# d) remove the worktrees ONLY with the safe script (it refuses a dirty or unmerged one)
WAVE_BASE=jobright-m5-base bash docs/jobright-clone/orch/wave-cleanup.sh MKT-5A MKT-5B MKT-5C MKT-5D MKT-5E MKT-5F MKT-5G MKT-5H
```

Delete any `.vitest/` directory in a worktree before committing. **Never** remove a worktree by hand: an earlier cleanup deleted nine worktrees of uncommitted work because "branch is an ancestor of HEAD" is also true for a branch with no commits.

### Step 2. Gate M5 (make the merged tree green): done 2026-10-12

Run all gates; fix what is red at the seams between bundles (decide from `market/MARKET_STRATEGY.md` which side is right):

```bash
npx prisma validate && npm run db:generate && npm run gen:brand   # gen:brand must leave no diff
npm run typecheck:server
npx next typegen && npm run typecheck:web
npx vitest run --exclude ".claude/**"
npm run check
npm --prefix extension run typecheck && npm --prefix extension test
npm run eval:match -- --enforce M4          # exit 0; never edit the ranking baseline by hand
```

Then read the "Requests" sections of `orch/handoffs-mkt/MKT-5*.md` and apply those addressed to the orchestrator; write what stays open to `requests/waveM5-carryover.md`. Commit, push. (Done, except the commit and push: see section 3. The same commands are the gate to run again after step 3.)

### Step 3. Merge and translate the staged strings (one pass)

New strings since the parity wave live in `i18n/staging/*.json` (1,171 new and 30 changed keys at the end of the M5 gate, by the script's dry run; GoApply Chinese is staged too). What M5 added, the key to remove and the zh-TW wording to start from: `requests/waveM5-carryover.md`, "Orchestrator" item 1.

```bash
node scripts/i18n-merge-staging.mjs --dry-run     # read the plan
node scripts/i18n-merge-staging.mjs               # merges into en.json / zh.json, resets staging
npm run check                                      # now reports missing keys in the other locales
```

- `i18n/staging/_pending-translation.json` is cumulative and stale. Compute the real gap per locale instead: keys of `i18n/messages/en.json` missing from `i18n/messages/<locale>.json` (also `server/src/i18n/email/` and `extension/src/i18n/`).
- Locales: `zh`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `pt`, `de`. Keys under `authCn`, `billingCn`, `jobsCn`, `onboardingCn`, `practiceCn`, `notifyCn`, `campus`, `landing.cnHome` are required only in `en` and `zh`.
- Translate into a scratch folder, then apply with `node docs/jobright-clone/orch/apply-translations.mjs "$PWD" <chunksDir>` (layout and rules in the file header: same key structure, same ICU arguments, same `%BRAND%` count, no literal brand names).
- Register per locale, Taiwan vocabulary rules and banned words: `scripts/check-copy.mjs`, `scripts/check-zh-variants.mjs`, `CN_TW_LAUNCH_PLAN.md` §9. The product never applies for the user; no translation may say it does.
- Key removals and special cases collected by the gates: `requests/wavePAR-carryover.md` ("i18n merge and translate") and the `i18n` entries in `requests/waveM1…M5-carryover.md`.
- Done when `npm run check` and the full test suite are green. Commit, push.

### Step 4. Production build

Never build in the worktree the dev server runs from (they fight over `.next`). Use a separate worktree:

```bash
# --detach is required: the branch is checked out in the dev worktree, and git refuses to check it out twice
# ("fatal: 'feat/jobright-clone' is already used by worktree at …"). Never use --force for this.
git worktree add --detach /Users/kenny/code/RoboApply/.claude/worktrees/jobright-build feat/jobright-clone
# a later rebuild in the same worktree: move it to the branch's newest commit
git -C /Users/kenny/code/RoboApply/.claude/worktrees/jobright-build checkout --detach feat/jobright-clone
# node_modules must be a REAL directory here: the bundler refuses a symlink that leaves the project
# ("Symlink node_modules could not be resolved"). On macOS an APFS clone is instant and takes no space:
#   cp -cR ../jobright-clone/node_modules node_modules        (or: npm ci)
# copy .env and .env.local from the clone worktree, then:
npm run build
```

The build worktree is at a detached commit: commit nothing there. A fix found by the build is made in the dev worktree, committed on the branch, and the build worktree is moved again.

Also confirm the `/legal` pages can read their files in the serverless bundle: the route's `.nft.json` trace under `.next/server/app/legal/` must list `content/legal/**`.

### Step 5. Browser verification of both brands

Start with `docs/jobright-clone/orch/parity-verify.md` (exact commands and expected results). Cover on both hosts: signed-out pages, sign-up with email and password, resume upload, feed and job detail, natural-language job search, the Assistant, tailoring, practice (text; voice if the worker is running), pricing and the plan sheet, settings. For the job feed first trigger the crons on the dev stack (`/api/v1/cron/jobs-plan`, `jobs-boards`, `jobs-ingest`, `queue-drain`, `score-precompute`, with `Authorization: Bearer $CRON_SECRET` on port 4621) so the seeded boards are read. Know what those crons call from this `.env` (it has a RapidAPI key and the bank settings, and no kill switch is set): JSearch and Active Jobs DB on the RapidAPI plan, within their daily call budgets (Active Jobs DB is on the free plan and answers 429 once its month is used up); the RoboHire and GoHire banks (the GoHire bank is read once from its beginning); the public APIs of the 512 seeded employer boards; 台灣就業通 and the 事求人 file; and every job opened in the browser asks its ATS whether the posting is still listed. To verify without any metered call set `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED=true` in `.env` for the run (the boards, the banks and the Taiwan open data still fill the feed); `ATS_PUBLIC_SOURCES_DISABLED=true` stops the board reads and the posting check. Do not start a real payment. Fix what is broken; note what could not be checked.

### Step 6. Clean up and open the PR

- Delete throwaway `claude-verify-*` test users on the Neon branch. Archive `market = 'cn'` rows whose `sourceBoard` is `'jsearch'` or `'linkedin'` (neither is ever a GoApply source). Rows with `sourceBoard = 'activejobs'` are different since M5: Active Jobs DB is a source of both markets once a paid plan opens its gate, so archive mainland `'activejobs'` rows only on a database where no paid Active Jobs DB plan was ever active (true for the Neon branch today); on any other database they are GoApply's inventory, and the feed does not list a row again once its window has passed.
- Open a PR for `feat/jobright-clone` into `main`. Do not merge it. The description should list the owner items of section 6.

## 5. Rules that have already cost time

- **Alipay is frozen.** Tests named `A<n> …` are never edited, skipped or weakened; a red one means the change is wrong. `server/src/platform/billing/fulfilPass.ts`, the Alipay callback route and `handleAlipayCallback` are not edited. A GoApply plan never reaches Stripe.
- **Schema is additive only.** New models, nullable or defaulted columns, indexes. Review the SQL first (`npx prisma migrate diff --from-config-datasource --to-schema server/prisma/schema --script`, then `node scripts/check-schema-additive.mjs --sql <file>`), apply the reviewed SQL with `npx prisma db execute --file`, and confirm a second diff is empty apart from the pair in `schema-diffs/KNOWN_DRIFT.md`. Never `--accept-data-loss`. Only the Neon branch; production only with the owner.
- **Tests never reach a real database or the network.** `vitest.config.mts` pins the database URL to a closed port.
- **Stage explicit paths** when committing in a checkout other sessions share; check `git status` for files you did not write.
- **i18n**: components read keys from the bundles; a new English string goes to `i18n/staging/<namespace>.en.json` until the merge of step 3. Copy is brand-neutral (`%BRAND%`), plain language.
- **Standalone `tsx` scripts that import the server's Prisma client hang.** Use `pg` directly or the HTTP API.

## 6. What only the owner can do

- `ALLOWED_BRANDS=roboapply` on Vercel (Production and Preview) before this branch reaches production, unless GoApply is to go live at the same moment: a deployment with no value serves both brands.
- Run `server/prisma/sql/001_vector.sql` and the additive schema push on the production database before the deploy (`server/prisma/sql/README.md`).
- Stripe: a `sk_test_` key and a `stripe listen` webhook secret for local checkout tests; the live webhook endpoint and its secret for production (`market/STRIPE_TEST_RECIPE.md`).
- Alipay: `ALIPAY_CALLBACK_SECRET` in the GoApply environment; one supervised ¥12 order (`market/ALIPAY_CUTOVER.md`).
- Recruiter-bank jobs (RoboHire, GoHire) are synced but not listed until the bank has a candidate-facing posting page: set `ROBOHIRE_PUBLIC_JOB_URL_TEMPLATE` / `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` when it exists (work in the RoboHire repository).
- Rotate `OPENROUTER_API_KEY` (dead) and top up the Anthropic account; host the interview worker; a paid Active Jobs DB plan if the licensed feed is wanted.
- The decisions each gate left open, numbered, are under "Owner" in `requests/wavePAR-carryover.md` and `requests/waveM1…M5-carryover.md`. Before the first deploy read `requests/waveM5-carryover.md`, "Owner" 1 to 5 and "What the first runs after this merge do" (Workable, the daily 事求人 read, the GoHire bank's one re-read, the on-demand liveness check).

## 7. Map of the documents

| File | Use |
|---|---|
| `docs/jobright-clone/README.md` | Rulings D1–D6 and owner decisions |
| `docs/jobright-clone/GOAPPLY_PARITY_PLAN.md` | D5: how GoApply gets every capability |
| `docs/jobright-clone/market/MARKET_STRATEGY.md` | D6: sources, matching, prices, payments (decisive) |
| `docs/jobright-clone/market/MARKET_TASK_PLAN.md` | Phases, contracts between bundles, what was built |
| `docs/jobright-clone/market/BOARD_SEEDS.md` | How the employer-board seed lists were validated |
| `docs/jobright-clone/orch/market-bundles.json` | The 41 work bundles (owns, items); `parity-bundles.json` for the parity wave |
| `docs/jobright-clone/orch/handoffs-*/` | What each bundle did, asked for and left open |
| `docs/jobright-clone/requests/orchestrator-queue.md` | Work owed at the next gate |
| `docs/jobright-clone/requests/wave*-carryover.md` | Open items per later bundle, per owner |
| `docs/jobright-clone/orch/*.sh, *.py, *.mjs` | Worktree setup, ownership-checked commit, safe cleanup, bundle check, translation apply |
