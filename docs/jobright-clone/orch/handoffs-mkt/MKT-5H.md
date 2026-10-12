# MKT-5H

Env examples for every variable of M2 to M5, the mainland deploy kit variables, and the final pass over the plan documents (OT-1). This is the handoff after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5H`, branch `wp/MKT-5H`. Nothing committed. Eight files changed, all inside the bundle's owns. No code file was edited, no network request was made, no `.env` was opened. The seven sibling worktrees and their handoffs were read, never written.

**State in one paragraph.** All three items are done and every gate is green on the final tree. All six review findings were real and are fixed. While fixing them the handoffs of the seven sibling bundles landed (MKT-5A to MKT-5G, read on 2026-10-12 between 01:45 and 01:55), so the M5 half of both env files and of the plan documents now follows what those bundles built, no longer the bundles file alone. That reading added one variable the plan did not have (`INGEST_BANK_RESYNC_DAYS`) and corrected or completed the statements listed in the table under item 1. What is left is outside the owns and is written under Requests with the exact text.

## Review resolution

| # | Finding | Verdict | What was done |
|---|---|---|---|
| 1 | `FANTASTIC_API_KEY_HEADER` and the direct route defaults contradicted MKT-5A as built; the test pinned the wrong statement (medium) | Real. Confirmed in `wp-MKT-5A/server/src/roboapply/v2/lib/raFantasticJobs.ts` (`DIRECT_KEY_HEADER`, `DEFAULT_PATHS`, `resolveTransport`) and in handoff MKT-5A, point 5 | `.env.example`: "Override of the header the direct key is sent in. Unset = Authorization, sent as Bearer <key>; any other header name carries the bare key. A value that is not a header name is ignored." and the route defaults per transport. The test now asserts those sentences and that "a header name is never guessed" is gone. `README.md` owner step (now 23): the header clause is dropped; what stays open is the expired route of the RapidAPI listing. The matching line of `MARKET_TASK_PLAN.md` section 6 is Request 8 |
| 2 | `ENRICH_REQUIREMENTS_MAX`: a value above 24 is read as 24 (low) | Real (`enrich/schema.ts` `enrichRequirementsMax`: `Math.min(24, n)`) | "a whole number from 1 to 24 (a larger whole number is read as 24); anything else means the default". Test regex updated |
| 3 | `TW_GOV_JOBS_URL`: the override rule was not stated (low) | Real (`wp-MKT-5D/.../twGovJobs.ts` `twGovJobsUrl`; handoff MKT-5D, Request 4) | The documented endpoint and "An override must be https on dgpa.gov.tw or a subdomain, without credentials; anything else turns the adapter off (reason url_invalid)". Test extended |
| 4 | README "Owner steps still open" said "copied" and left actions out (low) | Real | Both fixes: the introduction now says what the list is and where the yes-or-no choices are, and the missing actions are in. 32 steps became 42. Every action the reviewer named has a line (steps 8, 14, 15, 22, 29, 32, 36), and so have the owner requests of the seven M5 handoffs |
| 5 | The mainland kit named the paid source but not the variables that open it (low) | Real (`wp-MKT-5A/.../ingest/config.ts` `feedGateFor`: `plan_too_small`, `no_key`) | One sentence of prose above `# CN_ACTIVEJOBS_ENABLED=`, no new entry. A test holds the sentence and that the four names have no entry in the kit |
| 6 | The new Stripe comment gave the wrong directory (low) | Real | `server/src/lib/rateCard.ts` and `server/src/lib/mockInterviewPlans.ts`, also in the older line below it that names the second file. A test checks the sentence, that both files exist and that the short form is not written |
| undone | Carry-over entries left: M2 MKT-5H.3, .5, .6; M3 MKT-5H.2, .3, .5, .6; M4 MKT-5H.3, .4, .5 and the strategy half of .6 | Agreed: not done, and they cannot be done here | Their files are outside the owns and the item forbids `docs/jobright-clone/market/`. Requests 1 to 7, re-checked against this tree, and Known gap 3 with who must act |

No unowned edit existed, so nothing was reverted.

**Beyond the findings.** The reviewer wrote that MKT-5A was uncommitted and its final handoff should be read first. All seven M5 handoffs were read, and every request they address to MKT-5H is carried out where the file is mine:

- MKT-5A (env table): the header default; `FANTASTIC_TRANSPORT` is the transport of the whole client; `FANTASTIC_FEED_DISABLED` also stops the mainland search; `INGEST_FEED_DAILY_JOBS` covers the feed and the search of both markets; `FANTASTIC_MONTHLY_JOBS` (the larger number counts); `INGEST_FEED_COUNTRIES` (CN is ignored); the redefined `INGEST_ACTIVEJOBS_CN_DAILY_CALLS`, `RAPID_API_KEY`, the two `RA_ONBOARDING_*_DISABLED` switches and `RA_ONBOARDING_FANTASTIC_WINDOW`.
- MKT-5B: "none can be added" for Workable; the cap's range 1 to 2,000; the denylist is honoured with the flag on or off. Plan documents: nine systems, four of them seedable, the 48 MB answer limit, the Greenhouse list-first read.
- MKT-5C: the range of `LIVENESS_RECHECK_HOURS`; Lever's EU host is not asked. Plan documents: the mainland unseen rule, the three date facts on the wire, the one sponsorship label rule.
- MKT-5D: the two formats (`USAJOBS_USER_AGENT_EMAIL`, `TW_GOV_JOBS_URL`); `TW_GOV_JOBS_INCLUDE_TRANSFERS` covers both groups of posts; the README lists `SOURCE_REGISTER.md`.
- MKT-5E: `INGEST_BANK_RESYNC_DAYS` (new); "wins over the list endpoint and the database"; the key's fallback.
- MKT-5F: no variable. Plan documents: the pay rule in AppConfig, district and shift.
- MKT-5G: the API row `GET /companies/:id/sponsorship` in `ARCHITECTURE.md`; the importer steps in the owner list.

## Items

### 1. [P0] `.env.example` documents every variable the wave introduced after M1: done

**Sources read.** The env arrays of every M2 to M5 bundle in `orch/market-bundles.json`; the "Env variables added or redefined" section of all 25 handoffs of M2 to M4 and of the seven M5 handoffs; `MARKET_TASK_PLAN.md` section 5. Every M2 to M4 name was checked against the code in this tree. Every M5 name was checked against the code in its bundle's worktree: all 28 are read by non-test code there.

**What changed in `.env.example`** (1,436 to 1,780 lines; 58 new entries; two entries removed on purpose, the two LinkedIn names below):

- **Stripe block.** The interim "one secret, not a list" sentences are gone (a list is accepted since MKT-2B). New text: every secret is tried and trimmed; only whitespace inside a secret keeps payments closed; the Dashboard endpoint needs the fourteen event types; the portal configuration is created by code. New entries `# STRIPE_TAX_ENABLED=` and `# STRIPE_TEST_CLOCK_ID=`. A sentence says why the legacy `STRIPE_ROBOAPPLY_*_PRICE_ID` lines stay, with the real paths of their two readers.
- **Alipay block.** "as STRIPE_SECRET_KEY is Stripe's" is corrected. New `# ALIPAY_SECRETLESS_UNTIL=`, `# CN_ALIPAY_NOTIFY_ORIGIN=`, `# CN_ALIPAY_PACKAGE_ID_MODE=`; the `CN_BACKEND_URL` comment states the chain.
- **External job boards.** Two RapidAPI services, not three; one shared call gate. The two `RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET` names are commented lines marked as deprecated aliases. The two LinkedIn names lost their entries and moved to the "no longer read" note. As redefined by MKT-5A: `RAPID_API_KEY` is not used by Active Jobs DB on the direct transport, both kill switches also stop the licensed feed, and the window variable also decides the stored window of a planned search.
- **Cross-bank section.** `GOHIRE_BANK_TRANSPORT` (a syndication URL implies its own transport; `db` and `api` are then ignored with one warning; `off` still switches the bank off), `GOHIRE_SYNDICATION_URL` (the bank's transport, wins over the list endpoint and the database), new `# GOHIRE_SYNDICATION_KEY=` (unset = `GOHIRE_API_KEY`; with neither the bank is off while the URL is set).
- **"Job inventory, enrichment and scoring" rewritten into seven sections**, one comment per variable with meaning and default: the per-brand source summary, `JOB_PROVIDERS_<BRAND>`, `INGEST_BANK_RESYNC_DAYS`, `ENRICH_REQUIREMENTS_MAX`, `CN_RECRUITMENT_INFO_MODE`; metered providers and quota; public employer boards (`ATS_*`, `CN_ATS_BEISEN_*`, `CN_ATS_TENANT_DENYLIST`, the contact pair, `LIVENESS_*`); Taiwan open data (`TW_OPEN_DATA_*`, `TW_GOV_JOBS_*`); licensed feed and USAJobs (`FANTASTIC_*`, `INGEST_FEED_*`, `CN_ACTIVEJOBS_ENABLED`, `USAJOBS_*`); skills, embeddings and retrieval (`EMBED_*`, `CN_EMBED_*`, `SKILL_EMBED_MATCH_MIN`, `FEED_HYBRID`, `FEED_QUERY_EMBED_TIMEOUT_MS`); fit scoring (`MATCH_SCORER_RUBRIC`, `CN_MATCH_SCORER_RUBRIC`).
- `LLM_MATCHING_MODEL` and `CN_LLM_MATCHING_MODEL` gain "the one pinned scorer model per market".
- Every new line is commented out. A default is in the comment (or as the commented value). `CN_ATS_BEISEN_ENABLED` is `# CN_ATS_BEISEN_ENABLED=false` with the counsel sentence. No key has a value.

**ACCEPT.** Every literal name of the M2 to M5 env arrays, corrected by the handoffs, has exactly one entry with meaning and default; pattern names appear in pattern form; no secret shape; the 北森 flag is never true. Held by the test below.

**Differences between the sources (the handoff and the code win over the bundles file):**

| Name | Difference |
|---|---|
| `INGEST_QUOTA_RECHECK_HOURS` | added by MKT-3A, not in its env array |
| `TW_OPEN_DATA_COUNTY_WALK_MIN` | added by MKT-3E in its review round |
| `STRIPE_TEST_CLOCK_ID` | added at the M3 gate on MKT-3H's request |
| `INGEST_SCHEDULED_DEMAND_SHARE` | added at the M3 cross-review; now also in the kit and the test list |
| `STRIPE_BILLING_PORTAL_URL` | dropped by MKT-2B: read nowhere, kept out of both files (a test refuses it) |
| `RA_ONBOARDING_LINKEDIN_JOBS_DAILY_BUDGET`, `RA_ONBOARDING_LINKEDIN_JOBS_DISABLED` | nothing reads the first and the second has no effect (no adapter has the id `linkedin`). Documented as not read |
| `EVAL_SCORER_RECORD` | MKT-4G lists it; the M4 carry-over rules it belongs in neither file. Followed, and a test holds both |
| `INGEST_BANK_RESYNC_DAYS` | **new in M5, not in the bundles file** (MKT-5E): days after which a bank read by cursor is read again from the beginning; a whole number from 1 to 30, default 7. Entered in both files and in the test list |
| `FANTASTIC_API_KEY_HEADER` | bundles file: no default, never guessed. As built: an override; unset = `Authorization`, sent as `Bearer <key>` |
| `FANTASTIC_FEED_PATH`, `FANTASTIC_EXPIRED_PATH` | bundles file: `/active-ats`, `/expired-ats`. As built: those on the RapidAPI transport, `/v1/active-ats` and `/v1/expired-ats` on the direct transport |
| `INGEST_ACTIVEJOBS_CN_DAILY_CALLS` | redefined by MKT-5A: the 20 of an open gate are ingest's calls; a person's own mainland search needs this set above 0 |
| `TW_GOV_JOBS_INCLUDE_TRANSFERS` | bundles file: 一般人員 transfers. As built: every post outside the three kinds confirmed as open to the public, each tagged with its kind |
| `TW_GOV_JOBS_URL`, `USAJOBS_USER_AGENT_EMAIL` | each has a format rule the bundles file does not state (https on `dgpa.gov.tw`; an e-mail address) |
| `CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN`, `LIVENESS_RECHECK_HOURS` | ranges as built: 1 to 2,000; 0 to 720 |
| `RAPID_API_KEY`, `RA_ONBOARDING_ACTIVEJOBS_DISABLED`, `RA_ONBOARDING_EXTERNAL_JOBS_DISABLED`, `RA_ONBOARDING_FANTASTIC_WINDOW` | redefined by MKT-5A (see the External job boards bullet above) |
| `TW_OPEN_DATA_JOBS_ENABLED`, `TW_OPEN_DATA_JOBS_URL`, `INGEST_<PROVIDER>_DAILY_CALLS`, the two webhook secret names | redefined by MKT-3E, MKT-3A, MKT-2B; comments follow the merged code |

**Tests.** `__tests__/deploy/envExample.test.ts`, 25 to 69 tests. Lists `M2_`, `M3_`, `M4_`, `M5_LITERAL_NAMES` (67 names beside the 10 of M1), copied into the file. Rules: exactly one entry per name; no M2 to M5 name is an active line with a value; no kill switch shown switched on and no feature shown switched off; every credential empty; the secret shapes; `CN_ATS_BEISEN_ENABLED` commented and false in both files with the counsel sentence; no interim "until phase M" sentence. One describe block per area pins meaning and default; the statements taken from an M5 worktree are marked "As built by MKT-5x" in the test. Two mutation checks (the first in the first round; in this round eight facts broken on purpose, eight tests failed, files restored).

### 2. [P0] The mainland deploy kit lists every GoApply override of the wave: done

`deploy/cn/cn.env.example` (262 to 353 lines; 20 new entries), all new lines commented and worded "Optional: … Unset = …":

- **Payments:** `CN_ALIPAY_NOTIFY_ORIGIN`, `ALIPAY_SECRETLESS_UNTIL`, `CN_ALIPAY_PACKAGE_ID_MODE`; the `CN_BACKEND_URL` comment corrected.
- **Job sources:** `GOHIRE_SYNDICATION_URL`, `GOHIRE_SYNDICATION_KEY`, `INGEST_BANK_RESYNC_DAYS` (shared name), `CN_ACTIVEJOBS_ENABLED` (with the sentence that names the shared key and plan-size variables, and that the provider's host has not been checked from a mainland network), `INGEST_FEED_CN_DAILY_JOBS`, `INGEST_<PROVIDER>_CN_DAILY_CALLS` (pattern and `INGEST_ACTIVEJOBS_CN_DAILY_CALLS`), `INGEST_SCHEDULED_DEMAND_SHARE`, `# CN_ATS_BEISEN_ENABLED=false` with the 反不正当竞争法 Art. 13(3) sentence, `CN_ATS_BEISEN_MAX_POSTINGS_PER_RUN`, `CN_ATS_TENANT_DENYLIST`. The section says which boards this stack reads, that they are not read at all when GoApply writes none, and that JSearch has no variable here.
- **Matching:** `CN_MATCH_SCORER_RUBRIC`, `CN_LLM_MATCHING_MODEL`, `CN_MATCH_PRIORS` (one line), and the section "Optional override: embeddings and retrieval" with the five `CN_EMBED_*` names, the pair rule, "vectors never cross markets" and the mainland model as a recommendation.

**ACCEPT.** Every named override is a commented optional line with its fallback; nothing switches on a counsel-gated or paid-plan feature; no secret; `__tests__/deploy/deployKit.test.ts` (not owned) passes unedited.

**Asked to report.** The kit ships neither `CN_RECRUITMENT_INFO_MODE=off` nor `CN_PAYMENTS_ENABLED=false`, active or commented. `deploy/cn/README.md` has no variable table, so there are no lines to request. None of MKT-5D's six names belongs in the kit (they are RoboApply's).

**One departure.** `waveM2-carryover.md` MKT-5H.2 asks for `CN_EMBED_BATCH_SIZE=10` next to `CN_EMBED_MODEL=text-embedding-v4`. The item says to state the model as a recommendation, not a default, and the limit of 10 is one reading of the vendor's page through a fetch tool that the owner has not confirmed (Owner 16 there). So both are in the comment, in words, the limit with the date of that reading (2026-10-11), and the two entries carry no value.

### 3. [P1] Final pass over the plan documents: done

**`ARCHITECTURE.md`.** The four "planned" paragraphs (4.3, 4.7, 4.8, 7.1) are replaced by as-built descriptions, and more was brought in line:

- 2.1: the push order of `server/prisma/sql/README.md`.
- 4.2: an as-built table of the nine sources with market, dedupe priority and reader.
- 4.3: planner, quota, the board sync with its cron (nine systems, of which the seed files may name four; Workable's switch; 北森 off, unverified, its fixture synthetic; the Greenhouse list-first read; the 48 MB answer limit), Taiwan open data, 事求人 and the Taiwan extras (the pay rule in AppConfig `tw.payRule.v1`, district, shift), the licensed feed (seven-day backfill, one window per UTC hour, the expired feed, the gate, the two transports, how requests and postings are counted, no SEO seed while the feed is on), USAJobs, the GoHire bank (syndication, the weekly re-read), the mainland deep links, with the open points.
- 4.4: `linkedin 150` removed; the 45-day rule marked; identity and closure (posting key, closure per source with the 事求人 listing rule and the mainland unseen rule, liveness with its three hosts and what closes a row, three dates, the sponsorship label rule).
- 4.5: enrichment v3. 4.6: the `jobs-boards` row.
- 4.7: `getFit` / `getFits` / `getVariantFit`, invariants I1 to I8, estimate v2, canonical skills, scorer v4, the harness and its gates.
- 4.8: the embeddings client, the application-written `tsvector`, the side tables, three legs fused by reciprocal rank, Similar jobs.
- API table: `GET /companies/:id/sponsorship?jobId=` (MKT-5G's request). 5.2: `similar_jobs`, `show_jobs`, `agent.rankedBy`.
- 7.1: buckets as built, catalog prices, Stripe safety, catalog sync, the webhook events, reconcile, portal, switch, resume, refunds and withdrawal, the twelve Alipay rules with the additive mapping, the account purge and Stripe. 7.5: `ra_embed`. Appendix A: the variable note.
- The revision note at the top says where the M5 text comes from: the item, the bundle's code as it stood on 2026-10-12 before the merge, and its handoff.

**`README.md`.** The documents table gains one row for the wave's working documents (`ALIPAY_CUTOVER.md`, `STRIPE_TEST_RECIPE.md`, `BOARD_SEEDS.md`, `GOHIRE_SYNDICATION.md`, `SOURCE_REGISTER.md`, `ATS_BOARDS.md`). "Market wave (D6)" gains "State of each phase" (a table; what is built and off until the owner acts; what is on by default since M5 with its switch) and "Owner steps still open": 42 steps in five groups, the things someone has to carry out. Its introduction says that the yes-or-no choices are not repeated and step 42 says where they are. No secret, no account detail.

**`TASK_PLAN.md`.** The Market row of the overview; WP-16b and OPS-A3 marked; 14.6 gains eight rows and a state table; revision log row P10.

**`PRODUCT_PLAN.md`.** Marked: the mainland inventory of the onboarding panel (4.5), the cn feed note, the date line of F-FEED-15, the portal's scope in F-BILL-03, the refund lines of F-BILL-08. Section 6.2 gains `ai_answer` and `competitiveness`.

**`CN_TW_LAUNCH_PLAN.md`.** Marked: job sources per brand (2.1, 7), the Taiwan open-data rows, the Alipay notify origin, the Alipay credential row, and the pointer from C-13 to `market/ALIPAY_CUTOVER.md`.

**ACCEPT.** Search for `planned, phase M` in the five documents: **0 hits in each**. Prices and defaults in the new text were read from `planCatalog.ts`, `credits/catalog.ts` and `match/contract.ts`.

**Paths**, checked by script over the added text of each document:

- Confirmed in this tree: 51 in `ARCHITECTURE.md`, 16 in `README.md`, 7 in `TASK_PLAN.md`, 1 in `PRODUCT_PLAN.md`, 4 in `CN_TW_LAUNCH_PLAN.md`.
- Not in this tree, named by an M5 item and present in that bundle's worktree: `server/src/features/jobs/ingest/adapters/fantasticFeed.ts` (MKT-5A), `docs/job-search/ATS_BOARDS.md` (MKT-5B), `server/src/features/jobs/liveness/` (MKT-5C), `server/src/features/jobs/sources/usaJobs.ts`, `server/src/features/jobs/sources/twGovJobs.ts`, `docs/job-search/SOURCE_REGISTER.md` (MKT-5D), `server/src/features/jobs/ingest/adapters/syndication.ts`, `docs/jobright-clone/market/GOHIRE_SYNDICATION.md`, `scripts/gohire-syndication-probe.mjs` (MKT-5E).
- The handoffs `orch/handoffs-mkt/MKT-5A.md` to `MKT-5H.md` are in the clone checkout's handoff directory, not in this worktree.

### Carry-over entries

| Entry | State |
|---|---|
| M1 MKT-5H.1 (Stripe interim sentences and their test; portal by code) | done |
| M1 MKT-5H.2 (contact pair's interim sentence, both files; Taiwan line) | done |
| M1 MKT-5H.3 (test lists; shell-only names) | done |
| M1 MKT-5H.4 (`ARCHITECTURE.md` planned paragraphs, 7.1 table, `linkedin 150`, Appendix A) | done |
| M1 MKT-5H.5 (`PRODUCT_PLAN.md` 6.2 buckets) | done |
| M1 MKT-5H.6 (Alipay block wording) | done |
| M1 MKT-5H.7 (legacy price id lines stay) | done: kept active and empty, with the reason and the readers' real paths |
| M2 MKT-5H.1 (M2 variables; tax switch in the root file only) | done |
| M2 MKT-5H.2 (kit: Alipay names, embeddings block) | done, with the departure above |
| M2 MKT-5H.3, .6 (`MARKET_STRATEGY.md`, `PAYMENTS_AUDIT.md` notes) | **left**: outside owns, and they wait for owner answers. Request 2 |
| M2 MKT-5H.4 (`ra_embed` in 7.5) | done |
| M2 MKT-5H.5, .6 (two `*.prisma` comments) | **left**: no bundle edits `*.prisma`. Request 5 |
| M3 MKT-5H.1 (M3 variables, new names, LinkedIn names removed) | done |
| M3 MKT-5H.2, .3, .5, .6 (four documents under `market/`) | **left**: outside owns. Requests 1, 3, 4 |
| M3 MKT-5H.4 (old planner rule) | done |
| M3 MKT-5H.7 (M3 names in the test) | done |
| M4 MKT-5H.1 (five M4 variables; `EVAL_SCORER_RECORD` in neither file) | done |
| M4 MKT-5H.2 (5.2 tools, `agent.rankedBy`) | done |
| M4 MKT-5H.3 (runbooks: the purge and Stripe) | **left**: `docs/runbooks/` is not owned. The fact is in `ARCHITECTURE.md` 7.1. Request 6 |
| M4 MKT-5H.4 (fold the M4 notes into `MARKET_STRATEGY.md`) | **left**: outside owns. Request 2 |
| M4 MKT-5H.5 (`/help/ranking`: a tier can lag by 3 points) | **left**: namespace `landing` is not owned in M5. Request 7 |
| M4 MKT-5H.6 (boards not read when no brand writes them; strategy sentences) | env part done in both files; the strategy sentences are Request 2 |

### Where the item and the documents disagree (PRECEDENCE)

1. The item says "Do not edit documents under `docs/jobright-clone/market/` or `docs/job-search/`", while carry-over entries and three M5 handoffs ask this bundle to edit files there. The owns list decides: they are Requests 1 to 4 and 8 to 10.
2. The item says "for the M5 bundles that run in parallel with you, use the bundles file". The bundles file was the plan; the review and the M5 handoffs show what was built, and the task says the examples must describe what the code reads. Where they differ the code and the handoffs were followed (the table under item 1).

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-5H/`:

- `.env.example`
- `deploy/cn/cn.env.example`
- `__tests__/deploy/envExample.test.ts`
- `docs/jobright-clone/ARCHITECTURE.md`
- `docs/jobright-clone/README.md`
- `docs/jobright-clone/TASK_PLAN.md`
- `docs/jobright-clone/PRODUCT_PLAN.md`
- `docs/jobright-clone/CN_TW_LAUNCH_PLAN.md`

`git status` shows these eight and nothing else.

## Tests run

All on the final tree, in the worktree.

| Command | Result |
|---|---|
| `npx vitest run __tests__/deploy` | 5 files, 227 tests passed (`envExample.test.ts` 69; `deployKit.test.ts` unedited and green) |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0, all six checks clean |
| `npm run eval:match -- --enforce M4` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 758 files passed; 19,681 tests passed, 1 skipped, 10 todo, 0 failed (the base's 19,637 plus the 44 added here) |

The whole suite was run six times in this round while seven other bundles ran theirs on the same machine (load average between 50 and 200). Three runs were fully green, the last of them on the final tree. Three had failures, a different set each time, all of them wall-clock assertions or 5-second timeouts in files this bundle did not touch: see "Pre-existing failures".

Extension and interview-agent: not touched, not run.

## Red tests for other bundles

None.

## Pre-existing failures

None that fails by itself. Six failures in five files appeared in one or another full run under machine load; every one is a time limit, and the five files pass when run alone (241 and 94 tests green). None is in a file this bundle changed, and the change here is text files and one text test:

- `server/src/features/jobs/import/directFetch.test.ts`: "a 2 MB page of `<li ` is read … in milliseconds" (259 ms against a limit of 200), and one more test of that file in the first run
- `server/src/features/cn/jobs/__tests__/text.test.ts`: "unclosed tags (500 KB) is read in milliseconds" (263 ms against 250)
- `server/src/features/match/eval/run.test.ts`: "ranking and language measure NDCG through the seam …" (5 s timeout)
- `server/src/features/jobs/import/html.test.ts`: "gives what the two patterns gave, on every arrangement of brackets" (5 s timeout)
- `server/src/features/jobs/sources/atsPublic/atsPublic.test.ts`: "remembers 5,000 boards per process and forgets the oldest first" (5 s timeout; MKT-5B's file)

If the M5 gate runs the suite while other work loads the machine, these are the ones to run again alone.

## Requests

**Orchestrator, at the M5 gate**

0. **Check the M5 names once on the merged tree.** They were read in the bundles' worktrees and handoffs as these stood on 2026-10-12 at about 01:55, not on a merged tree. This prints every M5 name no code reads (expected: nothing):

   ```
   for n in $(sed -n '/^const M5_LITERAL_NAMES/,/^];/p' __tests__/deploy/envExample.test.ts | grep -oE "'[A-Z0-9_]+'" | tr -d "'"); do grep -rqF "$n" server/src || echo "not read by code: $n"; done
   ```

   If a bundle renamed, dropped or added a variable after that time, change three places together: `.env.example`, `deploy/cn/cn.env.example` (a GoApply name or a name the mainland stack needs) and `M5_LITERAL_NAMES` / `KIT_OVERRIDE_NAMES` in `__tests__/deploy/envExample.test.ts`. The M5 sentences of `ARCHITECTURE.md` 4.2 to 4.4 and the README's owner steps come from the same reading.

**Orchestrator: documents outside this bundle's owns**

1. `market/MARKET_STRATEGY.md` 5.3, cut-over step 2. Replace "must return our JSON (`{"code":40003,…}` with HTTP 403, or 40001 with HTTP 400), not a 401 / 404 / HTML page" with "must return our JSON (`{"code":40003,…}` with HTTP 403) with the `X-RA-Brand` response header, not a 401 / 404 / HTML page; 503 / 50003 means the route is reached and the secret is missing. The test host must resolve to GoApply, and the cashier's return address is GoApply's app origin, not the test host (`ALIPAY_CUTOVER.md` 2.1)."
2. `market/MARKET_STRATEGY.md`: fold the "As built" notes into the text once the owner has answered (`waveM2-carryover.md` Owner 5, 6, 21, 22, 23). From M4, with the wording in `MARKET_TASK_PLAN.md` 3.1 to 3.3: 4.4 "Statutory withdrawal" (per purchase; the waiver is the purchase's own checkout stamp; a purchase whose payment cannot be resolved is refused before the subscription is ended; the 14-day declaration after a provider failure; the public link); 2.3 step 7 (one requirement list per text of the posting); 2.3 step 8 and SM-9 (`q` and the ranking words are one query text; the API names an order only when the feed says it applied one); 2.1 point 3 and `SEARCH_RETRIEVE_MATCH.md` 4.9 (a typed `q` filters all three legs; the dense leg is unconstrained only without one); 1.2 (512 seeded sources; a board's first read is not a change). From M5: 1.3, the 事求人 row says "Later"; it is built and on by default (handoff MKT-5D, Request 5).
3. `market/PAYMENTS_AUDIT.md` B5 and B6 (the two lines that name `STRIPE_TEST_CLOCK_ID`): add "built at the M3 gate: with a test key a NEW customer is created under the clock; ignored with a live key and for a customer that already exists".
4. `market/JOB_SOURCES_TW.md` line 65 ("keep our 45-day rule on `TRANDATE`") disagrees with strategy JI-10 and the code: fold in the owner's answer to `waveM3-carryover.md` Owner 1. Its section 3.2 and `JOB_SOURCES_INTL.md` 4.2 take the facts MKT-5D measured (its handoff, Request 5). `market/JOB_SOURCES_CN.md` and strategy 1.4 list nine deep-link boards as if live: three are. `MARKET_TASK_PLAN.md` section 7 must not mark JC-5 delivered.
5. Two schema comments (comments only): `server/prisma/schema/ra-skills.prisma`, `RASkill.status` holds four values (`reviewed`, `unreviewed`, `dropped`, `seed`), the comment names two; `server/prisma/schema/ra-credits.prisma`, the comment on `RACreditLedger.bucket` lacks `billing:passover:*`.
6. `docs/runbooks/` (the RoboApply deploy runbook, or `cn-deploy.md` for the last sentence): "The account purge (`/api/v1/cron/account-purge`) needs a usable Stripe key in the deployment that runs it for RoboApply accounts with a running subscription, and reports `subscriptionsEnded`. A held account logs `purge blocked` with `stripe_not_configured` or `subscription_not_ended`. On a developer machine with the live key such an account stays soft-closed by design. The mainland stack never asks Stripe."
7. `/help/ranking` (namespace `landing`, staged): while `waveM1-carryover.md` Owner 20 stands as built, add one sentence, for example "A tier can stay one step behind its score by up to 3 points, so that it does not flip back and forth around a threshold." Scorer v4's borderline rule depends on the read path keeping that tier.
8. `market/MARKET_TASK_PLAN.md`, so that it agrees with the env examples:
   - Section 5, row `FANTASTIC_API_KEY_HEADER`: "another header name for the direct key; the raw key is then its value (Authorization, sent as Bearer <key>)".
   - Section 5, row `FANTASTIC_FEED_PATH / FANTASTIC_EXPIRED_PATH`: "route overrides (/active-ats and /expired-ats on the RapidAPI transport, /v1/active-ats and /v1/expired-ats on the direct transport)".
   - Section 5, new row: "M5 | MKT-5E | INGEST_BANK_RESYNC_DAYS: days after which a bank read by cursor is read again from the beginning; a whole number from 1 to 30 (7)".
   - Section 5, row `TW_GOV_JOBS_INCLUDE_TRANSFERS`: "true also ingests the posts outside the three public kinds (一般人員 transfers and the unconfirmed kinds), each tagged with its kind (false)"; row `TW_GOV_JOBS_URL`: add "https on dgpa.gov.tw only".
   - Section 5, row `INGEST_<PROVIDER>_CN_DAILY_CALLS`: add "Active Jobs DB: 20 while the feed's plan gate is open, ingest calls only; a person's own mainland search needs it set above 0".
   - Section 6, the JI-7 line "confirm the direct API's authentication header and the expired-feed route …": replace with "JI-7: on the first paid day check the expired-feed route of the RapidAPI listing, which could not be checked on the free plan (FANTASTIC_EXPIRED_PATH corrects it without a deploy). The direct API's key header is documented and built in (FANTASTIC_API_KEY_HEADER is an override). Trim INGEST_FEED_COUNTRIES and set INGEST_FEED_TAXONOMIES after the volume measurement."
   - Section 6, the SM-7 line "read the embedding model's price … so the cost row can be added": the row of the default model exists since the M2 gate (`server/src/lib/modelPricing.ts`). What is open: the owner confirms that row and the 10-inputs limit of `text-embedding-v4` by eye, and a model without a row has an unknown cost.
   - The "as built" lines the M5 handoffs give for sections 3.2 and 5: MKT-5A Request 4, MKT-5C O-9, MKT-5D Request 5, MKT-5E Request 3, MKT-5F Request 7, MKT-5G O-5.
9. `docs/job-search/SOURCE_REGISTER.md` section 3 (MKT-5D's file; its handoff, Request 4, asks for this once the bundles are merged). Remove the "M5 (MKT-5x)" markers and the sentence above the table that explains them, and correct:
   - `bank_robohire` and `bank_gohire`, "Other settings": add `INGEST_BANK_RESYNC_DAYS`.
   - `bank_gohire`, "On when": "`GOHIRE_SYNDICATION_URL` with `GOHIRE_SYNDICATION_KEY` or `GOHIRE_API_KEY` (a key) is the transport whenever it is set; otherwise `GOHIRE_BANK_TRANSPORT` (`db`, `api`) with `DATABASE_URL_GOHIRE` or `GOHIRE_API_KEY`".
   - `activejobs`, "On when": "`RAPID_API_KEY` (a key), or `FANTASTIC_TRANSPORT=direct` with `FANTASTIC_API_KEY` (a key), and the plan has quota". "Other settings": `INGEST_ACTIVEJOBS_CN_DAILY_CALLS` "(0; 20 for ingest while the feed's gate is open for the mainland)".
   - `activejobs_feed`, "On when": add "and the chosen transport has its key". "Turn it off with": add "the two kill switches of `activejobs` stop it too". "Other settings": add `FANTASTIC_API_KEY_HEADER`, `FANTASTIC_FEED_PATH`, `FANTASTIC_EXPIRED_PATH`, `INGEST_FEED_TAXONOMIES`.
   - The status cells of the Workable, Recruitee, Personio, Lever EU, 北森 and `activejobs_feed` rows, from handoffs MKT-5B and MKT-5A.
10. `README.md` of this folder after the gate: the M5 row of "State of each phase" says the bundles merge at the M5 gate. Once they are merged, write the gate's result there (test counts, what was not run), as the rows above it do.

**Owner**

Nothing new. The open steps are in one place: `docs/jobright-clone/README.md`, "Market wave (D6)", "Owner steps still open" (42 steps).

## Schema requests

None. (Request 5 is two comments.)

## Env variables added or redefined

None by this bundle: it documents, it reads nothing. The differences it found between the bundles file, the handoffs and the code are the table under item 1; the one name the plan did not have is `INGEST_BANK_RESYNC_DAYS` (MKT-5E; days after which a bank read by cursor is read again from the beginning; default 7).

## i18n keys added or changed

None. No staging file touched.

## Known gaps

Last phase: each gap has its next step and who must act.

1. **The M5 half was verified against worktrees and handoffs, not against the merged tree.** Next step: Request 0. Who: the orchestrator at the M5 gate.
2. **The design-time tables of `ARCHITECTURE.md` are kept and marked, not rewritten** (7.1 buckets and plan keys, 4.7 pre-score table, Appendix A names), in the document's own style. The as-built facts sit in the paragraph beside each. Next step: a document task after the wave; nobody is blocked. Who: owner's call.
3. **Seven carry-over entries are left** because their files are outside the owns (Requests 1 to 7). Who: the orchestrator; Requests 2 and 4 after the owner's answers (`waveM2-carryover.md` Owner 5, 6, 21 to 23; `waveM3-carryover.md` Owner 1 and 9).
4. **Two documents of this phase still describe M5 from the plan**: `MARKET_TASK_PLAN.md` sections 5 and 6 (Request 8) and `docs/job-search/SOURCE_REGISTER.md` section 3 (Request 9). Until they are corrected they disagree with `.env.example` on the header default, the direct routes and the new re-read variable; `.env.example` is right. Who: the orchestrator.
5. **The README's owner list holds actions, not every decision.** The yes-or-no choices stay in section 6 of `MARKET_TASK_PLAN.md`, the Owner sections of the four carry-over files and the M5 handoffs (step 42 names them). It was made from the M5 handoffs as they stood at about 01:55 on 2026-10-12; a handoff rewritten later may hold one more owner step. Next step: compare once at the gate. Who: the orchestrator.
6. **Four names read only by developer scripts are still not in the catalogue**, as before this wave: `ELEVENLABS_API_KEY`, `PARLEY_ADMIN_PASSWORD`, `ROBOAPPLY_API_READY_TIMEOUT_MS`, `ROBOAPPLY_PREVIEW`. `EVAL_ENFORCE` is set by the harness CLI for its own child process and is not an operator setting. Next step: a "developer scripts" section. Who: whoever edits `.env.example` next.
7. **`deploy/cn/cn.web.env.example` and `interview-agent/deploy/cn/worker.env.example` were not changed**: the env tables of the 32 handoffs of M2 to M5 add no variable the web pods or the worker read. No next step.
8. **Older comments of `.env.example` name server files as `lib/…`** (`lib/crypto.ts`, `lib/emailDomainPolicy.ts`, `lib/config.ts`, `lib/modelPricing.ts`, `lib/subscriptionGraceConfig.ts`, `lib/brand.ts`, `lib/databaseUrl.ts`); they predate this wave and were left as they are. The two this bundle wrote are corrected (finding 6). Next step: one pass that writes `server/src/lib/…`. Who: whoever edits the file next.
