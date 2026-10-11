# MKT-1G

Plan documents follow the market strategy; env examples for the Stripe safety rule, the price variables and the other M1 variables (OT-1; env docs of ST-0 and PC-1). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G`, branch `wp/MKT-1G`. Nothing committed. No code, schema, i18n or dependency change: two env examples, one new test, five documents. This is the handoff after the independent review; the last section lists what the review changed.

## Items

### Item 1 [P0] `.env.example` states the Stripe safety rule and the price variables: done

Names, meanings and defaults were taken from the env arrays of the M1 bundles and from the item. After the review, three statements were also checked against the sibling worktrees as built (`wp-MKT-1A`, `wp-MKT-1C`), read only.

- **Stripe block** (`# ── Stripe (RoboApply consumer billing)`): says the rail is available only with the key AND a webhook secret and that with either missing RoboApply lists its plans and prices and cannot open a payment; that `STRIPE_WEBHOOK_SECRET` accepts a comma-separated list for a rotation; that `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` is read together with it; that a live key (`sk_live_` or `rk_live_`) is refused whenever `VERCEL_ENV` is not production, for every Stripe call, so local development and previews need a test key and a `stripe listen` secret. Added the commented line `# STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION=true` with its warning. Placeholders only (`sk_test_...`, `whsec_...`), and only inside comments: the three credential lines stay empty, because `__tests__/deploy/deployKit.test.ts` (not owned) requires every secret-named active line to be empty.
- **Interim warning on the webhook secret (review finding 1).** The list form is true in M1 only for readiness: MKT-1A's `stripeWebhookSecrets` splits both names, so the rail opens, but `server/src/roboapply/routes/stripeWebhook.ts` line 30 still reads `ROBOAPPLY_STRIPE_WEBHOOK_SECRET || STRIPE_WEBHOOK_SECRET` as one string and passes it to `constructEvent` (line 42); MKT-1A does not touch that file, and MKT-2B item 1 (phase M2) is what makes the route try each secret. The comment above `STRIPE_WEBHOOK_SECRET=` now ends: "Until phase M2 of the market wave (MKT-2B) is merged the webhook route verifies with a single value: set one secret, not a list (a list set before then lets checkout open while every webhook is rejected and nothing is fulfilled)." The comment above `# ROBOAPPLY_STRIPE_WEBHOOK_SECRET=` now ends: "Until then, when both names are set only ROBOAPPLY_STRIPE_WEBHOOK_SECRET is used to verify."
- **Plan price block** (`# ── Credits and plans`): the sentence about a plan being sellable when its price is set is replaced by the catalog rule of strategy 4.3 (every plan has a default amount in code, env values are overrides). The parity wave had already reworded the sentence to "a plan is sellable when its Stripe price is set"; that form is gone too. RoboApply defaults stated once in USD cents (999 / 2499 / 5499 / 999 / 999 / 2499 / 1749 / 3799) and again as the commented default next to each override (`# PRICE_PRO_MONTHLY_USD_CENTS=2499` and so on). Documented: `PRICE_<PLANKEY>_USD_CENTS`, `STRIPE_PRICE_<PLANKEY>_CENTS` (alias; the new name wins), `STRIPE_PRICE_<PLANKEY>` (optional pin, honoured only with an amount variable; a pin alone is ignored and logged; without a pin the price is created by the catalog sync on first use), `PRICE_<PLANKEY>_TWD_CENTS` (multiple of 100; unset = Taiwan pays USD with the reference line), `STRIPE_PRICE_<PLANKEY>_TWD_CENTS` (alias), `STRIPE_PRICE_<PLANKEY>_TWD` (pin). The sixteen `STRIPE_PRICE_*` lines are kept as commented examples; they were active empty lines before, so the file now has no active price variable.
- **GoApply lines**: left as the parity wave wrote them. Checked as the item asks: neither file ships `CN_PAYMENTS_ENABLED=false` as an active line and neither says a plan is "sellable only with CN_PAYMENTS_ENABLED=true". Nothing to correct. The kill-switch wording and `# CN_PAYMENTS_ENABLED=true` are unchanged.
- **Other M1 variables**, each with meaning and default, as commented lines: `JOB_SOURCES_CONTACT` (next to `ATS_PUBLIC_SOURCES_DISABLED`), `MATCH_PRIORS`, `CN_MATCH_PRIORS`, `MATCH_CALIBRATION_MIN_PAIRS=500`, `EVAL_LIVE`, `EVAL_JUDGE_MODEL` (after `MATCH_TIERS`). `CN_MATCH_PRIORS` also in `deploy/cn/cn.env.example`, as a commented optional override under a new heading `# ── Optional override: job matching ──`. `STRIPE_BILLING_PORTAL_URL` was not added.
- **Interim note on `JOB_SOURCES_CONTACT` (review finding 3).** In MKT-1C as built the variable is read only by the new helper `server/src/features/jobs/sources/userAgent.ts`, which has no caller; the bundles notes call it an inert contract, and MKT-3D item (4) and MKT-3E are the bundles that send it. The comment now ends: "Sent by the job-source adapters from phase M3 of the market wave; before that the variable has no effect."
- **One deliberate narrowing against strategy 5.1.** The strategy says products, prices and the portal configuration are created by code on first use. The portal configuration by code is MKT-2B (phase M2), so `.env.example` says "Stripe products and prices are created by code on first use" and leaves the portal to MKT-5H. The item asked for the file "as the code of this phase reads them".

Tests: `__tests__/deploy/envExample.test.ts`, 23 tests (22 before the review), text only (no network, no import of server code). Literal M1 names present and each with an entry of its own; the six pattern names present as whole names; no line of either file has a secret shape (`sk_live_`, `rk_live_`, `sk_test_`, `rk_test_`, `whsec_` followed by four or more word characters; the bare prefixes and the `...` placeholders pass, and the test proves the shapes do catch a key); Stripe credentials shipped empty; `CN_PAYMENTS_ENABLED` never an active off switch in either file; the Stripe block's four statements; **the two interim webhook sentences (new test)**; the override shown only as a commented line with its warning; the eight USD defaults; alias, pin and Taiwan rules; no active price variable; the GoApply `CN_PRICE_*_FEN` lines untouched and no `CN_PRICE_PRO_WEEKLY_FEN`; the comment above each of the six other variables, **including the interim sentence on `JOB_SOURCES_CONTACT` (new assertion)**; the kit's `CN_MATCH_PRIORS` line; no `STRIPE_` or `PRICE_` name in the mainland kit; every kit name in the root catalogue. The two interim checks carry a comment saying when MKT-5H removes them. The lists `M1_LITERAL_NAMES` and `M1_PATTERN_NAMES` are the ones MKT-5H extends.

### Item 2 [P1] Plan documents agree with the strategy on prices, defaults and rulings: done

Every number comes from MARKET_STRATEGY sections 3 to 5. Old statements were kept and marked "superseded by MARKET_STRATEGY M-n (2026-10-11)"; no paragraph was deleted. Much of this item had already been done by PAR-10 (the kill switch, the entity, the `licensed` default, JSearch and LinkedIn in TASK_PLAN and CN_TW_LAUNCH_PLAN), so the edits here are the statements that were still unmarked.

- `README.md`: the OPS-B1 row now carries $54.99 and $9.99, the student prices of both brands (GoApply ¥29 / ¥69), the catalog rule, the rail rule, and one sentence that the old values are superseded with the two reasons of strategy 4.1. Open decision 2 and open decision 8 (Stripe test-mode price ids) updated or marked superseded.
- `PRODUCT_PLAN.md`: new revision note at the top; section 6.3 quarterly $54.99 ("Save 26%") and 7-day pass $9.99, student $17.49 / $37.99, a paragraph for the catalog rule (M-13, M-15, M-25) (the document had no "needs STRIPE_PRICE_*" sentence; the nearest was the paragraph "RoboApply prices under D6", rewritten); free `autofill` 20 a day on both brands (M-14); the "Save 20%" example of 6.1; the providers row of 1.3 and F-FEED-15 (LinkedIn feed dropped M-4, JSearch demand-only M-3, age cut-off for aggregator rows only M-22). Beyond the item's list, because the acceptance line asks for agreement with sections 4 and 5: the TWD list (quarter NT$1,650, pass NT$299, student NT$519 / NT$1,150; the old NT$1,790 and NT$219 marked superseded), F-BILL-08 (M-21: 14 days for EU / EEA / UK / Taiwan, pro-rata with the waiver), and the retention of the renewal acknowledgement (4.4).
- `TASK_PLAN.md`: R-08, FND-4, WP-62, OPS-A9, OPS-B1 and the revision-log row H33 carry a superseded note; new section 14.6 "The market wave and the rules of this file it supersedes" (plan files, and a table of old statements with the strategy decision and the bundle that builds each; eight rows after the review); revision-log row P9. **After the review:** section 10 part C (the owner's RoboApply credential list): "Stripe products/prices (`STRIPE_PRICE_<PLANKEY>`)" now carries the M-13 / M-15 / M-25 note (no product or price is created by hand, no price id is configured; the owner supplies the key and a webhook secret, strategy §7 item 2), and "台灣就業通 open-data licence check (T-5)" in the same list carries the M-5 note.
- `CN_TW_LAUNCH_PLAN.md`: superseded notes on the original text of L-4, the current-state source row, the three stage-table cells (CN-0, CN-1, CN-2), "free during beta", the `partner_deeplink` mode gate of WP-JOBS-CN, the GoHire credential row, the stage env list, and the "Unlocks" cells of C-11, C-12, C-13 and C-15. Beyond the item's list: the 台灣就業通 statements (M-5). **After the review:** the "Stripe (exists)" row of 5.1 (M-13, M-25), the "TW open data" row of 5.1 (M-5), and two more statements of the same kind found by a wider search: the WP-TW-JOBS spike bullets ("If not confirmed, … stays false") and owner task T-5 ("Verify the 台灣就業通 open-data licence"). The document no longer says "pending verification" without the note.
- `ARCHITECTURE.md` had no hit for any of the five searches; its part is item 3.
- Not edited, as instructed: `GOAPPLY_PARITY_PLAN.md`, everything under `market/` and `orch/`.

Search record (five documents: README, PRODUCT_PLAN, TASK_PLAN, CN_TW_LAUNCH_PLAN, ARCHITECTURE), command for each pattern `grep -n -- "<pattern>" README.md PRODUCT_PLAN.md TASK_PLAN.md CN_TW_LAUNCH_PLAN.md ARCHITECTURE.md` in `docs/jobright-clone/`; "After" was re-run after the review edits:

| Pattern | Before | After |
|---|---|---|
| `59\.99` | README:95 (OPS-B1, stated as the price), PRODUCT_PLAN:966 (the price) | README:147 ("…had the quarter at $59.99… both values are superseded by MARKET_STRATEGY M-11"), PRODUCT_PLAN:968 ("The earlier price of $59.99 is superseded…"), TASK_PLAN:1017 (14.6 table, "both values superseded") |
| `6\.99` | README:95, PRODUCT_PLAN:967 (the price) | README:147, PRODUCT_PLAN:969, TASK_PLAN:1017, each inside the superseded sentence |
| `partner_deeplink` | CN_TW:32, 131, 302, 484, 488; TASK_PLAN:60, 821 | the same seven statements, now at CN_TW:32, 131, 302, 485, 489 (one line was added above) and TASK_PLAN:60, 821. The five CN_TW lines each carry a superseded note (M-6 / M-7); TASK_PLAN:60 is R-14, already marked SUPERSEDED with `licensed` as the default; TASK_PLAN:821 names it only as counsel's option in the legal track, under the D5 note of line 819. No line states it as the default |
| `CN_PAYMENTS_ENABLED=true` | CN_TW:34 (struck through), 132 (CN-2 stage cell, unmarked); TASK_PLAN:61, 654, 972 | the same five lines. CN_TW:132 now carries "superseded by MARKET_STRATEGY M-7 and §5.3 G2"; TASK_PLAN:654 gained the G2 and G5 wording; the other three were already superseded statements |
| `LinkedIn Job Search` | no hit | no hit |

Added to the record by the review (same five files, `grep -n -i`):

| Pattern | Before the review | After |
|---|---|---|
| `Stripe products/prices` | TASK_PLAN:817, unmarked | TASK_PLAN:817, followed by "*(superseded by MARKET_STRATEGY M-13, M-15 and M-25 (2026-10-11): no product or price is created by hand and no price id is configured; the owner supplies the Stripe key and a webhook secret (strategy §7 item 2))*" |
| `paid plans hidden` | CN_TW:430, unmarked | CN_TW:431, followed by "*Superseded by MARKET_STRATEGY M-13 and M-25 (2026-10-11): plans and prices are always listed; without the key or a webhook secret … no payment can be opened. No price id is needed for a current plan (M-15); the `STRIPE_ROBOAPPLY_*_PRICE_ID` names are read only by the legacy rate card (starter, growth, premium)*" |
| `pending verification` | CN_TW:433, unmarked | CN_TW:434, followed by "*Superseded by MARKET_STRATEGY M-5 (2026-10-11): the OGDL v1 licence is confirmed; the adapter ships on by default in market wave phase M3, and until then the source stays off*" |
| `licence check\|open-data licence` | TASK_PLAN:817 and CN_TW:529 (T-5), unmarked | TASK_PLAN:817 and CN_TW:530, each with the M-5 note; CN_TW:392 is the new note under the spike bullets; TASK_PLAN:1023 is the new 14.6 row (WP-42 stub, strategy M-5, MKT-3E) |
| `plans hidden\|price_unset\|price not set\|PRICE_ID` | (checked for other unmarked statements) | every remaining hit is a superseded statement, a "never price not set" sentence, or one of two design-time lines in ARCHITECTURE (2456, 2895) that the "Market wave (2026-10)" paragraphs at 2461 and 2886 already correct by name |

### Item 3 [P1] The market wave is findable from the plan documents: done

- `README.md`: new section "Market wave (D6)" (one paragraph: what it is, the specification, the executable plan and its companion, the parity wave merges first) and the phase table M0 to M5, 40 rows, bundle ids and titles generated from `orch/market-bundles.json` by script (not retyped). Also a row for the two plan files in "The documents", the Market row of "Shape of the plan", and the status sentence under D6.
- `ARCHITECTURE.md`: four paragraphs headed "Market wave (2026-10)", each naming the strategy sections and the modules with "planned, phase Mx": end of 4.3 (providers and planner, strategy 1), in 4.7 after the renormalisation sentence (fit, strategy 2.2, 2.4, 2.6; it also covers the `pre - 5` ranking input of 4.8), end of 4.8 (retrieval, strategy 2.1, 2.3, 2.5), in 7.1 after the Plans paragraph (prices and rails, strategy 4 and 5). No existing description was rewritten and no line was deleted (`git diff` shows 41 added lines and one changed line: Appendix B item 2, which keeps its text and gains a superseded note).
- Section 2.1: MKT-0 is merged, so the folder listing gained `ra-skills.prisma`, `ra-retrieval.prisma`, `sql/001_vector.sql` and `sql/README.md`, with one paragraph on what MKT-0 added and the two raw-SQL rules. **After the review (finding 4):** `RAJob.headcount` is no longer listed among MKT-0's columns (it is not in MKT-0's schema array or in MARKET_TASK_PLAN §4; commit 54fa08d added it). The paragraph now says: "`RAJob.headcount` (the bank's stated openings, nullable) was added separately as SCHEMA-8 at the parity gate; it is not part of MKT-0."
- Also: a note in Appendix A (where the wave's variables are listed) and in Appendix B item 2 (no Stripe price id is needed).

Module paths in the new ARCHITECTURE text and the bundle item whose FILES line names each (checked by script against `orch/market-bundles.json`; every path confirmed, none left out):

| Path | Marked | FILES line of |
|---|---|---|
| `server/src/platform/billing/stripeEnv.ts` | planned, phase M1 | MKT-1A item 1 |
| `server/src/platform/billing/stripeCatalog.ts` | planned, phase M1 | MKT-1A item 3 |
| `server/src/platform/billing/stripeEvents.ts` | planned, phase M1 | MKT-1A item 6 |
| `server/src/platform/billing/stripePortal.ts` | planned, phase M2 | MKT-2B item 5 |
| `server/src/platform/billing/stripeRefunds.ts` | planned, phase M2 | MKT-2D items 1, 2, 3, 5, 6 |
| `server/src/platform/billing/stripeHealth.ts` | planned, phase M2 | MKT-2B item 7 |
| `server/src/features/match/fit.ts` | planned, phase M1 | MKT-1F items 3, 5 (also MKT-2F items 1, 4) |
| `server/src/features/match/eval/` | planned, phase M1 | MKT-1D items 1 to 5 |
| `server/src/features/skills/` | planned, phase M2 | MKT-2G items 1 to 4 |
| `server/src/features/retrieval/` | planned, phase M2 | MKT-2H items 2 to 5 |
| `server/src/platform/embeddings/` | planned, phase M2 | MKT-2H item 1 |
| `server/src/features/jobs/ingest/quota.ts` | planned, phase M3 | MKT-3A items 1, 2 |
| `server/src/features/jobs/ingest/boards.ts` | planned, phase M3 | MKT-3D items 2, 3, 4, 5, 7 |
| `server/src/features/jobs/sources/twOpenData.ts` | planned, phase M3 (exists today as the WP-42 stub; the text says so) | MKT-3E items 2, 3, 6 |
| `server/src/features/feed/hybridSql.ts` | planned, phase M4 | MKT-4F item 1 |
| `server/src/features/jobs/ingest/adapters/fantasticFeed.ts` | planned, phase M5 | MKT-5A items 2, 3, 4, 6 |
| `server/src/features/jobs/ingest/adapters/syndication.ts` | planned, phase M5 | MKT-5E items 1, 2, 4 |
| `server/src/features/jobs/liveness/` | planned, phase M5 | MKT-5C items 1, 3 |
| `server/prisma/sql/README.md` (exists) | as merged | MKT-0 item 5 |

The item wrote "adapters/fantasticFeed.ts and syndication.ts"; both live under `server/src/features/jobs/ingest/adapters/` in the bundles file, and that is the path printed.

### Carry-over (`requests/wavePAR-carryover.md`, section "Market waves")

No entry names a file this bundle owns. Entry 5 (`market/JOB_SOURCES_CN.md` §2.1 and §8 rule 3, "bank jobs open the GoHire page" without its condition) is the only document entry; the file is under `market/`, which this bundle may not edit and which no M1 bundle owns. Left; see Requests.

## Files changed

| File | Lines (`git diff --numstat`) |
|---|---|
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/.env.example` | +105 −24 |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/deploy/cn/cn.env.example` | +7 |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/__tests__/deploy/envExample.test.ts` | new, 309 lines, 23 tests |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/docs/jobright-clone/README.md` | +58 −6 |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/docs/jobright-clone/PRODUCT_PLAN.md` | +15 −11 |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/docs/jobright-clone/TASK_PLAN.md` | +23 −7 |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/docs/jobright-clone/CN_TW_LAUNCH_PLAN.md` | +19 −18 |
| `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1G/docs/jobright-clone/ARCHITECTURE.md` | +41 −1 |

`git status` shows exactly these eight paths, all inside the bundle's owns. The reviewer found no unowned edit and there is none to revert. Outside the worktree: this handoff only, at `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-1G.md`.

## Tests run

All in the worktree, after the review edits.

| Command | Result |
|---|---|
| `npx vitest run __tests__/deploy/envExample.test.ts` | red first (2 failed, 21 passed: the two interim assertions, written before the env edits), then 23 passed |
| `npx vitest run __tests__/deploy/` | 5 files, 180 passed (includes the unowned `deployKit.test.ts`, which pins the same two files) |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | **646 files passed; 14,315 passed, 1 skipped, 10 todo; 0 failed.** That is the base (645 / 14,292) plus this bundle's one file and 23 tests. `git status` was identical before and after the run |

## Red tests for other bundles

None.

## Pre-existing failures

None in the worktree as it stands, and none in the run after the review.

One observation from the first round, kept for the orchestrator because this bundle's change does not explain it: **one earlier full run saw files that are not in this worktree.** It reported 648 files and 14,737 tests, three of them failed: `server/src/features/boundary.test.ts` (violation `jobs/sources/atsPublic/hooks.ts → jobs/normalize/salary.ts`), `server/src/features/jobs/normalize/salary.test.ts` ("JT-1: 台灣就業通 … 核薪 inside another word…") and `server/src/features/jobs/import/directFetch.test.ts` (read time 207.96 ms against a 200 ms limit). The first two are MKT-1C's work in progress (JT-1, `hooks.ts`); `git status` showed only this bundle's eight paths before and after. The three files pass when run alone, and every full run since is green with the expected counts. The third is a timing assertion that missed its limit by 8 ms on a busy machine: if it shows at the gate it is flaky, not red.

## Requests

**Orchestrator**

1. **Do not deploy or browser-verify the M1 tree with a list in the webhook secret, or with two different values in the two names.** Between the M1 and M2 merges the rail's readiness check accepts a list (MKT-1A `stripeWebhookSecrets`) while the webhook route verifies with one raw string (`stripeWebhook.ts` lines 30 and 42, untouched by MKT-1A). `whsec_a,whsec_b` opens checkout and every webhook answers 400 `invalid_signature`; with both names set, only `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` verifies. `.env.example` now says so. If the orchestrator prefers to close the gap in M1 instead of documenting it, the change is MKT-2B item 1's first sentence (the route's `secretOf` returns `stripeWebhookSecrets(process.env)` and `constructEvent` is tried with each secret), in a file MKT-2B owns.
2. **Check the worktree isolation of MKT-1C** (see Pre-existing failures): its files appeared in `wp-MKT-1G` during one test run of the first round. Nothing of it remains here and nothing of this bundle was overwritten. Compare `git -C .claude/worktrees/wp-MKT-1C status` with its handoff before merging.
3. **At the M1 merge, compare MKT-1A's, MKT-1C's, MKT-1D's and MKT-1F's "Env variables added or redefined" with `.env.example`.** If a handoff renamed, dropped or added a variable, three places change together: `.env.example`, `deploy/cn/cn.env.example` (only `CN_MATCH_PRIORS`) and the two name lists at the top of `__tests__/deploy/envExample.test.ts`. Checked after the review against the sibling worktrees: both webhook names are read as lists by `stripeEnv.ts` (readiness only, see request 1), and `JOB_SOURCES_CONTACT` is read by `sources/userAgent.ts` only. Still to check at the merge: that the new name wins over its alias (`PRICE_<PLANKEY>_USD_CENTS` over `STRIPE_PRICE_<PLANKEY>_CENTS`).
4. **`docs/jobright-clone/market/JOB_SOURCES_CN.md` §2.1 and §8 rule 3** (carry-over entry 5) still say a bank job opens the GoHire page without the condition. No M1 bundle owns the file. The sentence to add after each: "A bank row is listed only when `GOHIRE_PUBLIC_JOB_URL_TEMPLATE` is set; until then it is synced, counted and held (MARKET_STRATEGY M-7, finding C18)."
5. The documents say RoboApply's USD defaults, free `autofill` 20 and the Stripe rail rule hold "since phase M1 of the market wave". That is true once MKT-1A and MKT-1B merge with this bundle. If either is held back, those sentences are ahead of the code until it lands.

**MKT-5H** (next owner of these files)

6. `.env.example`, Stripe block, once MKT-2B has merged: (a) remove the two interim sentences ("Until phase M2 of the market wave (MKT-2B) is merged the webhook route verifies with a single value …" above `STRIPE_WEBHOOK_SECRET=`, and "Until then, when both names are set only ROBOAPPLY_STRIPE_WEBHOOK_SECRET is used to verify." above `# ROBOAPPLY_STRIPE_WEBHOOK_SECRET=`) together with the test "warns that until phase M2 the webhook is verified with one value, and which name wins"; (b) add that the billing portal configuration is created by code (left out here on purpose, see item 1).
7. `.env.example`, `JOB_SOURCES_CONTACT`, once M3 has merged: remove "Sent by the job-source adapters from phase M3 of the market wave; before that the variable has no effect." and the matching `expectHas` line in the test "JOB_SOURCES_CONTACT: the contact in the User-Agent…". The line below it, "# Taiwan open data (licence pending verification; WP-42 stub stays off)", describes the code until MKT-3E replaces the stub and is rewritten then.
8. `ARCHITECTURE.md`: the four paragraphs to replace are headed "**Market wave (2026-10).**" (sections 4.3, 4.7, 4.8, 7.1); the 2.1 paragraph is headed "Market wave (2026-10), schema as merged by MKT-0" and is already as-built. Search `planned, phase M` finds 18 lines today. The design-time table of 7.1 still shows `autofill` free 4 and the plan keys `pro_week` / `pro_month` / `pro_quarter`; this phase was told not to rewrite existing descriptions, so the new paragraph states the current values next to it.
9. `__tests__/deploy/envExample.test.ts`: extend `M1_LITERAL_NAMES` and `M1_PATTERN_NAMES` (or add M2 to M5 lists beside them); `commentAbove(text, '# NAME=')` returns the comment block over an entry.

**MKT-1C**: nothing. Its item makes the User-Agent helper an inert contract in M1 by design, so the gap of finding 3 is closed by the note in `.env.example`, not by a change to MKT-1C.

**Owner**: nothing new. The owner steps this bundle's text points to are strategy section 7 item 2 (a Stripe test key and one `stripe listen` secret for the clone `.env`; the live key there is refused outside production once MKT-1A merges).

## Schema requests

None.

## Env variables added or redefined

None introduced by this bundle. Documented in `.env.example` for the M1 bundles (name, meaning, default as written there):

| Variable | Meaning | Default |
|---|---|---|
| `STRIPE_SECRET_KEY` | the Stripe key; a live key is refused when `VERCEL_ENV` is not production | unset = no Stripe rail |
| `STRIPE_WEBHOOK_SECRET`, `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` | now required for the rail; each a comma-separated list. Until MKT-2B merges the webhook route verifies with one value, and with both names set only `ROBOAPPLY_STRIPE_WEBHOOK_SECRET` | unset = plans listed, no payment can be opened |
| `STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION` | `true` lets a live key work outside production | unset = refused |
| `PRICE_<PLANKEY>_USD_CENTS` | overrides a RoboApply catalog amount, positive integer cents | catalog 999 / 2499 / 5499 / 999 / 999 / 2499 / 1749 / 3799 |
| `STRIPE_PRICE_<PLANKEY>_CENTS` | alias of the line above | unset |
| `STRIPE_PRICE_<PLANKEY>` | optional pin of a Stripe price id, only with an amount variable | unset = price created by the catalog sync |
| `PRICE_<PLANKEY>_TWD_CENTS` | Taiwan price, TWD minor units, multiple of 100 | unset = USD with the reference line |
| `STRIPE_PRICE_<PLANKEY>_TWD_CENTS`, `STRIPE_PRICE_<PLANKEY>_TWD` | alias; optional pin | unset |
| `JOB_SOURCES_CONTACT` | URL or mailto in the User-Agent of job-board and open-data requests; sent by the adapters from phase M3, no effect before | the brand's site URL |
| `EVAL_LIVE` | `1` allows `npm run eval:match -- --live` | unset = refuses |
| `EVAL_JUDGE_MODEL` | judge model for `--live`, must differ from the scorer model | unset = `--live` refuses to judge |
| `MATCH_PRIORS` | JSON priors per not-stated component | 44 / 39 / 24 / 50 / 45 |
| `CN_MATCH_PRIORS` | GoApply override (also in the mainland kit, commented) | unset = `MATCH_PRIORS`, then the defaults |
| `MATCH_CALIBRATION_MIN_PAIRS` | pairs a market needs before the calibration map replaces the blend | 500 |

Not added: `STRIPE_BILLING_PORTAL_URL` (read nowhere).

## i18n keys added or changed

None. This bundle owns no namespace and touched no copy.

## Known gaps

- The env text for MKT-1D and MKT-1F (`EVAL_*`, `MATCH_*`) and the price variables is still written from the items and env arrays, not checked against their code (Request 3). The webhook secret and `JOB_SOURCES_CONTACT` statements were checked against the sibling worktrees after the review.
- The legacy lines `STRIPE_ROBOAPPLY_*_PRICE_ID` stay active and empty in `.env.example`: `server/src/lib/rateCard.ts` and `server/src/lib/mockInterviewPlans.ts` still read them for the legacy starter / growth / premium rows. They are not part of the market wave's catalog.
- `.env.example`, Alipay block, still reads "The rail's own credential, as STRIPE_SECRET_KEY is Stripe's". The item says to leave the GoApply lines as the parity wave wrote them; Stripe now needs a webhook secret as well, which the Stripe block states.
- `PRODUCT_PLAN.md` section 6.2 lists fewer buckets than strategy section 3 (`ai_answer` and `competitiveness` are missing there). Not a changed number, so not touched; MKT-5H's final pass can add the two rows.
- `ARCHITECTURE.md` section 4.4 still names `linkedin 150` among the daily budget defaults and Appendix A lists `INGEST_LINKEDIN_DAILY_CALLS` (design-time table). Existing descriptions were not rewritten in this phase.
- Documents only for items 2 and 3: there is no test that keeps the five documents in line with the strategy. The review found three statements the five recorded searches could not find; the wider searches added to the record above found two more of the same kind, and a statement worded differently again could still be unmarked.

## Review resolution

| # | Review point | Verdict | What was done |
|---|---|---|---|
| 1 | Finding (medium): `.env.example` says the webhook secret accepts a list and both names are read together, but the M1 webhook route verifies with one raw string | **Confirmed** in code: `stripeWebhook.ts:30` and `:42` in this worktree and, unchanged, in `wp-MKT-1A`; `wp-MKT-1A/server/src/platform/billing/stripeEnv.ts:61-67` splits both names for readiness only; MKT-2B item 1 is the change that tries each secret | Two interim sentences added to `.env.example` (quoted in item 1); one new test pins them; the pinned phrases "comma-separated list" and "rotation" still pass. Request 1 tells the orchestrator not to deploy or verify M1 with a list; Request 6 tells MKT-5H to remove the sentences and the test after MKT-2B |
| 2a | Finding (low): TASK_PLAN.md:817 "Stripe products/prices (`STRIPE_PRICE_<PLANKEY>`)" unmarked | **Confirmed** | Superseded note added in place (M-13, M-15, M-25; strategy §7 item 2). The same line's "台灣就業通 open-data licence check (T-5)" got the M-5 note |
| 2b | Finding (low): CN_TW_LAUNCH_PLAN.md:430 "Stripe (exists) … paid plans hidden" unmarked | **Confirmed, with one correction to the proposed wording.** The reviewer's note ended "No price id variable is read". That is not true of the names in that row: `STRIPE_ROBOAPPLY_*_PRICE_ID` is still read by `server/src/lib/rateCard.ts:100-116` and `server/src/lib/mockInterviewPlans.ts:71,78` (the same in `wp-MKT-1A`) | Note added in the "When absent" cell: plans and prices always listed; no payment without the key or a webhook secret; "No price id is needed for a current plan (M-15); the `STRIPE_ROBOAPPLY_*_PRICE_ID` names are read only by the legacy rate card (starter, growth, premium)" |
| 2c | Finding (low): CN_TW_LAUNCH_PLAN.md:433 "TW open data … pending verification … source off" unmarked | **Confirmed** | M-5 note added in the row, with "until then the source stays off" because the WP-42 stub is the code until MKT-3E. A wider search found two more unmarked statements of the same kind, marked too: the spike bullets of WP-TW-JOBS (new note line 392) and owner task T-5 (line 530); and a row for WP-42 / T-5 was added to TASK_PLAN 14.6 |
| 3 | Finding (low): `JOB_SOURCES_CONTACT` documented as already sent; nothing sends it in M1 | **Confirmed**: in `wp-MKT-1C` only `sources/userAgent.ts` and its test name the variable or `sourceUserAgent`; MKT-3D item (4) and MKT-3E wire it | Interim sentence appended to the comment; one assertion added to the existing test; Request 7 for MKT-5H. No request to MKT-1C: the bundles notes make the helper an inert contract in M1 by design |
| 4 | Finding (low): ARCHITECTURE 2.1 credits `RAJob.headcount` to MKT-0 | **Confirmed**: not in MKT-0's bundle entry, not in MARKET_TASK_PLAN §4; commit 54fa08d "SCHEMA-8" added it to `ra-jobs.prisma` | Removed from the MKT-0 list; one sentence added naming SCHEMA-8 and the parity gate |
| 5 | Undone: item 2 not fully met (the three statements of finding 2) | **Resolved** by 2a to 2c | The three lines and the two extra ones are in the search record of item 2, with the patterns that find them |
| 6 | Unowned edits | None reported, none found (`git status`: eight paths, all owned) | Nothing to revert |

Gates re-run after these edits: both typechecks exit 0, `npm run check` exit 0, full suite 646 files / 14,315 tests green.
