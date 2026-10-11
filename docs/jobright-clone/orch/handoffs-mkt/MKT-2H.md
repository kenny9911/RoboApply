# MKT-2H

Search document and embeddings write path: embeddings client, CJK segmentation, `searchDoc` / `searchTsv`, job and user vectors, sweep; relevance seam (SM-7 foundation, SM-11, SM-9, SM-12). This is the handoff after the independent review: every finding is resolved (see "Review resolution" at the end).

Worktree `wp-MKT-2H`, branch `wp/MKT-2H`, base `0dbe2ef`. Nothing committed. No command reached a database, a model, an embeddings endpoint or any provider. Nothing was checked against a running stack or a real PostgreSQL: every SQL statement here is tested only as text and parameters.

Two web reads were made, both through the fetch tool, which answers with a summary: the OpenAI pricing page (price row, item 1) and Alibaba's embedding page (inputs per request of `text-embedding-v4`, review finding 9). Please confirm both by eye once.

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-2H.md` (same text as below).

## Items

### 1. Embeddings client (P0): done

`server/src/platform/embeddings/` (`client.ts`, `budget.ts`, `usage.ts`, `index.ts`).

- `resolveEmbeddingConfig(brand, env)` → `{ model, apiKey, baseUrl, batchSize, dimensions: 1024, modelTag }` through `brandEnv` per key. `modelTag` is `<model>@1024`, or null with no key. Defaults: `openai/text-embedding-3-small`, `https://api.openai.com/v1`, batch 96 (the ceiling).
- `embedTexts(brand, texts, { purpose, carriesUserData, userId?, requestId? })` → `{ vectors, model, tokens }` or `{ unavailable: 'no_key' | 'policy' | 'budget' }`. A failed call (HTTP, timeout, malformed or wrong-sized response, a budget counter that cannot be read) throws `EmbeddingsError`, so a queue worker retries it.
- `embeddingAvailability(brand, { carriesUserData })` → `'ok' | 'no_key' | 'policy' | 'budget'`: the same checks without a request to the endpoint (review finding 1). The sweep asks it before it queues work.
- POST `<baseUrl>/embeddings` with `{ model, input, dimensions: 1024 }`, batches of at most `EMBED_BATCH_SIZE`, one retry on 429 or 5xx after `Retry-After` (bounded at 10 s, 1 s when absent), 20 s timeout. Every vector must be exactly 1024 finite numbers and line up with its input, otherwise the whole call fails. Nothing is padded, cut or zero-filled.
- A request of several inputs that the endpoint refuses with 400 is sent again in two halves, down to one input, and the size that worked is remembered for the process (review finding 9). A 400 for one input fails the call.
- Model id on the wire: a leading provider prefix is stripped for a direct endpoint; on OpenRouter only `openrouter/` is dropped.
- Policy: `checkLlmEgress` on the real endpoint host before any request. The provider the policy judges is the one the HOST belongs to; an unknown host is `newapi`.
- Budget: `budget:embed:<brand>` on `RARateCounter`, `EMBED_DAILY_TOKENS` per UTC day. Read without spending, then charged with the tokens the call used. `0` switches embedding off. A counter that cannot be read is not a spent budget: the call fails with `EmbeddingsError` code `budget_unreadable` and no request is made (review finding 5).
- Usage log: one `UsageDeductionLog` row per call, SKU `ra_embed`, units = reported tokens, under the brand system user. Tokens already spent are charged and logged even when a later batch fails. The cost is written only for a priced model called on its vendor's own host (`api.openai.com`); otherwise `platformCostUsd` is null and `costSource` is `unknown` (review finding 8). The host is in the row's metadata.
- `setEmbeddingsClientForTests(fake)` is the test seam for callers (a fake without `availability` counts as `'ok'`).

Decisions beyond the item text:

1. **A key is never sent to an endpoint it was not configured for.** With `EMBED_BASE_URL` set, only `EMBED_API_KEY` is used (never `OPENAI_API_KEY`). **GoApply's `CN_EMBED_BASE_URL` and `CN_EMBED_API_KEY` are one pair: both set or neither.** With only one of them set GoApply has no key (`no_key`), in both directions (review finding 6). `embeddingEnvProblems(env)` names the half-set pair (names only), and the client logs it once per process. A separate GoApply account on the shared endpoint sets `CN_EMBED_BASE_URL` to that same URL.
2. **The policy runs on every call, as chat calls do.** Behind `CN_LLM_DOMESTIC_ONLY` or `CN_RESIDENCY_STRICT` GoApply therefore sends public job text to a non-mainland endpoint no more than user text.
3. **Price row.** The rate table is `lib/modelCostTable.ts`, which I do not own, so the row is a new map in `lib/modelPricing.ts`: `EMBEDDING_MODEL_PRICING_PER_1M['text-embedding-3-small'] = 0.02`, with `lookupEmbeddingRate` and `calculateEmbeddingCost` (null for a model without a row). Read 2026-10-11 at `https://developers.openai.com/api/docs/pricing`; the fetch tool quoted the row `| Embedding | text-embedding-3-small | $0.02 | - | - |`.
4. **`docs/LLM_COSTS.md` is unchanged.** Its generator renders `MODEL_COST_TABLE` only. `npm run check:llm-costs` is green. See Requests.
5. **The usage row is written with `usageDeductionLog.create`,** the path the enrichment cost log uses, not `writeDeductionLog`: `'ra_embed'` is not in the `DeductionSku` union (`lib/matchBilling.ts`, not mine).

Tests: `platform/embeddings/client.test.ts` (42), `lib/modelPricing.test.ts` (3).

### 2. CJK segmentation, language, lexical document (P0): done, with the Unihan table empty

`features/retrieval/segment.ts`, `hantHans.ts`, `buildHantHans.ts`, `lang.ts`, `searchDoc.ts`, `jobText.ts`.

- `segmentForSearch(text)`: one function for documents and queries. NFKC, lower case, tech spellings as `normalizeTitle` spells them (`cpp`, `csharp`, `dotnet`, `nodejs`), Latin split on non-letters, Han and kana runs through `Intl.Segmenter('zh')` after the Traditional → Simplified fold.
- `toTsQuery(text)`: the OR of the distinct tokens, each quoted, at most 24; null for a text with no token.
- `detectLang(text)`: `zh-Hant`, `zh-Hans`, `ja`, `ko`, `en`, `other`.
- `buildSearchDoc(job)`: title; role labels (en, zh, zh-TW when present); level; skills, required first; summary; first 1,200 characters of requirements; at most 4,000 characters, cut on a token.

**The Unihan file was not obtained.** Downloading a file was not allowed in this session and no copy is on the machine. The fold is `foldTwToCn` alone (about 130 characters and 23 terms); no table was typed from memory. `HANT_HANS` is empty and `HANT_HANS_UNICODE_VERSION` is null. `buildHantHans.ts` is written and tested on a synthetic sample of the file format. See Owner requests.

Decisions beyond the item text:

1. **Bigram fallback, extended**: one-character Han pieces in a row also yield their bigram (鸿|蒙 → 鸿蒙), and a lone piece is glued to the word beside it (工程|师 → 程师). One-character function words are never glued.
2. **A query leaves three kinds of token out; a document never does**: function words and job-query noise, one-character CJK tokens and bare numbers. When nothing else is left they are kept.
3. **`.net` becomes ` dotnet` only where it is written as the platform** (review finding 10): at the start of a token (`.NET`, `C#/.NET`, `熟悉.NET`) and after `asp`, `ado`, `vb`. After a letter, a digit, a dot or `@` it stays `net`, so `careers.acme.net` and `hr@acme.net` no longer match a ".NET" query.
4. **`detectLang` does not call Latin text English by default**: `en` only when it shows English function words, else `other`.
5. With canonical skill ids, the document holds the canonical labels (en, zh, zh-TW) plus the posting's own spellings.

Tests: `segment.test.ts` (19), `lang.test.ts` (7), `hantHans.test.ts` (6), `searchDoc.test.ts` (10).

### 3. `job.index` worker (P0): done

`features/retrieval/repo.ts`, `cardText.ts`, `workers.ts`, `index.ts`; hook in `jobs/enrich/service.ts`; registration in `jobs/enrich/workers.ts`.

- `writeSearchDoc` is one statement: `UPDATE "RAJob" SET "searchDoc" = $1, "searchTsv" = to_tsvector('simple', $2), "contentHash" = $3, "lang" = $4 WHERE "id" = $5`.
- `contentHash` is `jobContentHash(row)` from `match/index.ts` (carry-over 1).
- `upsertJobEmbedding`: `INSERT … ON CONFLICT ("jobId") DO UPDATE`, the vector as a text literal cast `::halfvec(1024)`, checked for 1024 finite numbers before any SQL.
- `nearestJobsByJob`: public, canonical, open rows of the same market and model (and country when given), the job itself left out, by exact `<=>`.
- Worker: payload `{ jobIds }` (1 to 96). Lexical part for every job, then one `embedTexts` call for the card texts. A job whose stored vector has the current model and card hash is skipped. An unavailable client still succeeds with the lexical part written. A private import is indexed lexically always and embedded only when `aiAllowed(owner)` holds; its call carries `carriesUserData: true`.
- Hook: `EnrichDeps.enqueueIndex` (optional), called from `runHooks` after an enriched and after a rules-only finish, dedupe key `job.index:<jobId>:<enrichedAt ms>`.
- Registration: `workers = [jobEnrichWorker, ...retrievalWorkers]`. Concurrency 4, one embeddings call per item.
- `jobsNeedingIndex(market, tag, limit)`: rows that lack a search document or content hash come FIRST, then newest first (review finding 1). With a null tag only those rows are returned.
- New: `deleteJobEmbeddingsOfOwner(userId, market)` (vectors of a person's own private imports; review finding 11). `embeddedUserIds` now lists people with a vector of their own OR of a private import they own.

Decisions beyond the item text:

1. `JOBS_ENRICH_WORK_KINDS` also declares `job.index` and `user.embed` (`server/src/test/areaStubs.test.ts` requires it).
2. "Embedding row has another contentHash" cannot be asked in SQL; `jobsNeedingIndex` uses `e."embeddedAt" < j."enrichedAt"`, and the worker stamps `embeddedAt` when it finds the hash unchanged.
3. `jobsNeedingIndex` reads enriched rows only and asks for vectors of public rows only (Known gaps 5).
4. Timestamps are bound from the application clock, never SQL `now()`.
5. A batch never mixes markets in one embeddings call.

Tests: `repo.test.ts` (17), `workers.test.ts` (31, both workers), `jobs/enrich/service.test.ts`, `jobs/enrich/workers.test.ts`.

### 4. User vectors (P0): done

`features/retrieval/userText.ts`, `userSource.ts`, `workers.ts` (`user.embed`), `repo.ts`.

- `intentText`: target titles, role labels (en, zh), level, top 20 skills, industries, career goal. Empty when the person stated no title, role, industry or goal.
- `resumeText`: the last two titles with their bullets, the skills and the summary, from the primary resume's `parsedData`, then the strip. Built from structured fields: no education entry, no contact block, no employer name.
- **The strip is safe on its own** (review finding 2). `redactResumeText` drops every line that names a sensitive field (gender, sex, birth date, age, marital status, nationality, religion, ethnicity, race, photo, address; 性别, 出生, 生日, 年龄, 籍贯, 政治面貌, 民族, 婚姻, 婚否, 宗教, 照片, 家庭成员, 住址, 地址, 身份证, with the Traditional forms), removes URLs (scheme, `www.`, and profile sites written without one), then runs the platform redactor with `LLM_PII_KINDS` and the person's names. The label lists are the ones of `match/pii.ts`; `userText.test.ts` pins them. `defaultStrip` still prefers `stripResumeForScoring` when `match/index.ts` exports it.
- Worker gates: RoboApply none; GoApply the AI consent AND a live 个性化推荐 grant. **The gates are strict** (review finding 3): `hasLiveConsent(userId, AI_CONSENT_TYPE)` and `hasLiveConsent(userId, 'personalized_recommendation')`, which throw on a lookup error. A definite "no" deletes the person's vectors of that market before any text is built, and with the AI consent gone also the vectors of their private imports. A read that fails deletes nothing and fails the item, so the queue retries it.
- A kind whose `sourceHash` (sha1 of text + model tag) is unchanged is skipped. A kind with no text any more is deleted.
- `userVector(userId, market, modelTag)`: resume, else intent, else null; filtered on market and model tag.

Decisions beyond the item text:

1. `stripResumeForScoring` is not exported from `match/index.ts` (MKT-2F owns it in M2) and the boundary test forbids importing `match/pii.ts`. See Requests; nothing depends on that export any more.
2. A resume with no parsed data gives no resume vector.
3. "The free-text goal from onboarding" does not exist: onboarding stores an enum. The text uses that, else `RAProfile.careerGoal`.
4. A `user.embed` item whose market is not its brand's is refused.
5. A SPENT budget defers the item to the next UTC day. An unreadable budget counter is an ordinary failure, retried with backoff.

Tests: `userText.test.ts` (13), `userSource.test.ts` (4), `workers.test.ts` (user part).

### 5. Sweep and backfill CLI (P1): done (the reviewer judged it not done; both points are fixed)

`features/retrieval/sweep.ts`, `modelTag.ts`, `cli.ts`; third step in `features/match/cron.ts`.

- **Postings.** `jobsNeedingIndex(market, tag, 960)` → `job.index` items of 96, at most 10 a run, key `job.index.batch:<sha1 of sorted ids + tag>`, enqueued with **`onConflict: 'requeue'`**: the read still returns those rows, so they need a run; a finished or dead item for them runs again and a queued or leased one is left alone. Before the read the sweep asks `embeddingAvailability(brand, { carriesUserData: false })`; when vectors cannot be written (no key, route policy, budget 0 or spent) it passes a null tag, so only rows that lack the lexical part are returned and rows that cannot get a vector never fill the window. The result says why (`jobVectors`).
- **People.** Active in the last 7 days → `user.embed`, key by person, market, resume hash, search-profile version and model tag. Enqueued with `'requeue'` when the person has no stored vector of the write tag (the earlier item did not write one: client unavailable, item dead, or consent withdrawn and granted again), else `'keep'`. Nobody is queued while the market is between two models or while user text cannot be embedded (`embeddingAvailability(…, { carriesUserData: true })`); the result says why (`userVectors`).
- **Consent (GoApply).** A rotating window of 200 people who have a vector made from their data (`AppConfig` `retrieval.consentCursor.cn`). Deleted only on a definite "no"; with the AI consent gone the private-import vectors go too. A consent read that fails deletes nothing, stops the walk at that person and reports the step as failed.
- **Model switch.** New vectors are written with the configured tag; queries filter on `AppConfig` `retrieval.modelTag.<market>`. `RAJobEmbedding` has one row per job, so a re-embedded job leaves the previous model. The query tag therefore moves at the crossover: when the new tag holds at least `MODEL_SWITCH_SHARE` (0.5) of the rows that carry either tag. Queries always filter on the tag with more rows, so the dense leg covers the whole market before a change, **about half of it at the crossover**, and the whole market again at the end. It is never empty, but it does thin; the lexical leg is unaffected. With nothing stored the first tag is adopted at once.
- **Cron**: `composeScorePrecompute(precompute, calibration, retrieval?)`; the sweep is last, skipped with under 5 s of budget, and its failure is reported, never thrown. No cron entry, no edit of `cron/handlers.ts` or `vercel.json`.
- **CLI**: `npx tsx server/src/features/retrieval/cli.ts backfill --market intl|cn [--apply] [--limit n] [--all]`. A dry run makes one `SELECT` of counts and writes nothing; `--apply` only enqueues, with `'requeue'`. I did not run it.

**Where this differs from the plan documents.** MARKET_TASK_PLAN lists "dense-leg model switch at 90% coverage" among the choices the owner may overrule, and the bundle item repeats it. With one row per job, 90% keeps queries on the previous model while it holds about 10% of the rows, which is the opposite of what the rule is for. The constant is kept and named (`MODEL_SWITCH_SHARE`), with 0.5 as its value. 0.9 becomes right again when the table keeps both models' vectors (see Schema requests). **Owner: please confirm or overrule.**

Decisions beyond the item text:

1. `activeUsers` is handed in by the cron (the match repository is not on `match/index.ts`).
2. People are not queued while a market is between two models, and the worker keeps a vector of the model queries still use while its text is unchanged.
3. `--all` (not in the item): re-index every live row, for after the tokenizer or the fold table changes. Its keys carry the hour of the run.
4. Coverage is counted only while the two tags differ (two `indexStats` reads per run then).
5. `jobBatches`, `jobsQueued` and `usersQueued` count items waiting to run after the sweep. The queue answers the same for an item it just put back and one that was still waiting, so a still-waiting item is counted again on the next run.

Tests: `sweep.test.ts` (30), `modelTag.test.ts` (9), `cli.test.ts` (7), `match/cron.test.ts` (20). The queue doubles in `sweep.test.ts` and `cli.test.ts` keep the real conflict rule of `platform/queue/enqueue.ts`.

### 6. Relevance seam (P1): done

- `FeedQueryBodySchema.relevance`: optional, trimmed, at most 240 characters. `FeedQueryInput.relevance` is in `queryHash` (only when present) and on `QueryState`. Nothing reads it for the order.
- `preview` and `FeedService.preview` take `FeedPreviewInput` with the same field.
- `PlannerPlan.relevanceTerms?`; `planToFilters` → `{ patch, unmatched, rankedBy }`; `NlQueryResponse.rankedBy`.
- `rankedBy` (review finding 7): the planner's own terms, else the unmatched phrases with their lead-in dropped; **both pass `isConstraintPhrase`**, so a pay or visa phrase the planner names is never ranked by. When none of the planner's terms is a topic the terms are derived. Each term at most 60 characters, at most 5, and **joined by a space they never exceed 240 characters** (a term that does not fit is left out).
- `isConstraintPhrase` is narrower and wider where the review showed it wrong: `OPT`, `CPT`, `EAD` (capitals only) and `e-verify` are requirements; "equity research", "paid social", "paid media", "shift-left testing", "schedule optimization", "4k video", 弹性计算, 融资担保 and 地铁运营 are topics. `paid`, `equity`, `shift`, `schedule`, an amount in `k`, 弹性, 担保 and 地铁 count only in their requirement wording.
- `feed/index.ts` exports `similarJobIds(row, limit)`: `currentModelTag` then `nearestJobsByJob`; null when the market has no tag, the job has no vector or the read fails.
- `routes.ts`: no code change was needed; a header comment says so.

Acceptance: "backend jobs at climate startups using Rust, salary above 150k" → `rankedBy ['climate startups', 'Rust']`, pay phrase in `unmatched` only; same order with and without `relevance`, different session hash.

Tests: `filterDiff.test.ts` (25), `FeedQueryService.test.ts`, `routes.test.ts`, `similar.test.ts` (5).

### 7. Inert pre-wiring (P1): done

- `FEED_LIMITS.legLimit 200`, `rrfK 60`; `FeedOrder` gains `'query_match'`; `FeedItem.alsoIn?`.
- `feed/rankingText.ts` holds `RANKING_FACTORS`, `ORDERING_RULES`, `GOAL_ADJUSTMENTS` (moved verbatim) and `FRESHNESS_CURVE`; `contract.ts` re-exports the three names.
- `sql.ts` exports `qPredicateSql(q)`; `predicateFor` case `q` calls it.

Every existing feed test, the SQL snapshots and the web mirror test pass unchanged. `rankingText.test.ts` (7).

### Carry-over (waveM1, section MKT-2H)

1. `RAJob.contentHash = jobContentHash(row)` in the search-document statement: **done**.
2. `reconcile()` shape, optional `setCompanyIndustry`, `selectTaxonomyCandidates` 4th argument, import order in `enrich/index.ts`: **kept**; `enrich/index.ts` is untouched.
3. Hash recipe: **stored as it is.**
4. PAR 7a (`publicList` 45-day window): **left for MKT-5C.**
5. Feed latency: nothing to do; still unmeasured.

PAR carry-over "Market waves": 7a as above. 7b and 7 name files outside my owns.

## Files changed

New (all under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2H/`):
- `server/src/platform/embeddings/`: `client.ts`, `budget.ts`, `usage.ts`, `index.ts`, `client.test.ts`
- `server/src/features/retrieval/`: `segment.ts`, `hantHans.ts`, `buildHantHans.ts`, `lang.ts`, `jobText.ts`, `searchDoc.ts`, `cardText.ts`, `userText.ts`, `userSource.ts`, `repo.ts`, `modelTag.ts`, `workers.ts`, `sweep.ts`, `cli.ts`, `index.ts`, `testkit.ts`, and tests `segment`, `lang`, `hantHans`, `searchDoc`, `userText`, `userSource`, `repo`, `modelTag`, `workers`, `sweep`, `cli`
- `server/src/features/feed/rankingText.ts`, `rankingText.test.ts`, `similar.test.ts`
- `server/src/lib/modelPricing.test.ts`

Changed:
- `server/src/features/feed/`: `contract.ts`, `FeedQueryService.ts`, `filterDiff.ts`, `index.ts`, `routes.ts` (comment), `sql.ts`, and tests `FeedQueryService`, `filterDiff`, `routes`, `sql`
- `server/src/features/jobs/enrich/`: `service.ts`, `service.test.ts`, `workers.ts`, `workers.test.ts`
- `server/src/features/match/`: `cron.ts`, `cron.test.ts`
- `server/src/lib/modelPricing.ts`

Changed in this review round: `platform/embeddings/` (all four sources and the test), `features/retrieval/` `repo.ts`, `sweep.ts`, `workers.ts`, `userText.ts`, `modelTag.ts`, `segment.ts`, `cli.ts`, `index.ts` and their tests, `features/feed/filterDiff.ts` and its test.

Removed: `.vitest/json/output.json` (output of vitest's JSON reporter at the worktree root; not in my owns). Not changed: `docs/LLM_COSTS.md`. No `*.prisma`, no i18n file, no web file.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run --exclude ".claude/**"` (last run) | 690 files, 15,940 passed, 1 skipped, 10 todo, 0 failed |
| The files I wrote or touched (retrieval, embeddings, modelPricing, feed, enrich service and workers, match cron) | 34 files, 641 passed, 1 skipped |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | all checks green |
| `npm run eval:match -- --enforce M1` | exit 0 (retrieval layer `not_built`, as before) |
| `node docs/jobright-clone/orch/check-bundles.mjs …/market-bundles.json` | 0 problems |

Base was 675 files and 15,702 tests: +15 files, +238 tests (+37 in this round). Test files are not type-checked by the repository; mine were type-checked ad hoc and are clean. (`match/cron.test.ts` shows six type errors in the `job.score worker` block, lines 373 to 385, which is base code I did not write.)

## Red tests for other bundles

None.

## Pre-existing failures

None in the last two full runs. In the first round three timing tests failed once while sibling bundles ran suites on the same machine (`jobs/import/directFetch.test.ts`, `jobs/import/html.test.ts`, `match/eval/run.test.ts`), and `components/features/marketing/__tests__/home.test.tsx` timed out once in a partial run. None reproduced.

## Requests

**MKT-2F** (owns `match/index.ts` in M2)
1. Export `stripResumeForScoring` from `server/src/features/match/index.ts` (`export { stripResumeForScoring } from './pii.js';`). `retrieval/workers.ts` `defaultStrip` picks it up with no further edit, and `workers.test.ts` "the default resume strip" already asserts that the default is that function once it is exported. Not urgent any more: the fallback applies the same rules.
2. `similarJobIds(row, limit)` is on `feed/index.ts` with the signature your item casts to: `(row: { id, market, locationCountry? }, limit) => Promise<string[] | null>`. The ids are candidates only.

**Orchestrator**
3. `server/src/lib/matchBilling.ts`: add `'ra_embed'` to `DeductionSku`. `server/src/roboapply/v2/lib/raFeatureCatalog.ts`: add `ra_embed` to `FEATURE_BY_SKU`, `CLONE_SKUS` and `PLATFORM_SKUS`. Until then the rows are written and the admin cost report files them under "Other".
4. `scripts/print-llm-costs.ts`: render `EMBEDDING_MODEL_PRICING_PER_1M` as an "Embedding models" section and regenerate `docs/LLM_COSTS.md`. Or move the row into `MODEL_COST_TABLE`.
5. `server/src/platform/startup.ts`, next to the `brandEnvGroupProblems('goapply', env)` loop (about line 269): report `embeddingEnvProblems(env)` from `platform/embeddings/index.js` the same way (each entry has `set`, `missing` and a ready `message`; names only). Until then the half-set pair is logged once per process at the first GoApply embeddings call.
6. At the M2 merge, check the shape of `features/skills/index.ts` (MKT-2G) against `retrieval/workers.ts` `loadSkillLabels`. A mismatch is harmless (the stored skill strings are used).
7. First fill, after the merge and with the M0 push in place: `npx tsx server/src/features/retrieval/cli.ts backfill --market intl` (dry run), read it, then `--apply`. Without it the cron fills 960 postings per market per run.

**MKT-4A or whoever owns consent withdrawal**
8. On withdrawal of the AI consent call `deleteUserEmbeddings(userId, 'cn')` AND `deleteJobEmbeddingsOfOwner(userId, 'cn')`; on withdrawal of 个性化推荐 call `deleteUserEmbeddings(userId, 'cn')` (all from `features/retrieval/index.ts`). Today the vectors go at the person's next `user.embed` run or when the sweep's window reaches them (200 people per 15 minutes).

**MKT-4F** (notes, no change needed)
9. `toTsQuery` answers null for a text with no token: leave the lexical leg out. `userVector` answers `number[]`; `vectorLiteral(vector)` gives the text to cast `::halfvec(1024)`. Ask `isFeedPersonalized` before using a person's vector. `QueryState.relevance` and `FeedPreviewInput.relevance` carry the text. A query vector is embedded with `purpose: 'query'`; `{ unavailable }` or a thrown `EmbeddingsError` both mean "run without the dense leg". Delete `FEED_LIMITS.freshnessHalfLifeHours` when `FRESHNESS_CURVE` is read.

**MKT-5H**
10. The env variables below go into `.env.example` and `deploy/cn/cn.env.example`. In the GoApply example write the pair rule (`CN_EMBED_BASE_URL` and `CN_EMBED_API_KEY` together or not at all) and `CN_EMBED_BATCH_SIZE=10` next to `CN_EMBED_MODEL=text-embedding-v4`.

**Owner**
11. **Fill the Traditional → Simplified table.** Download `https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip`, unpack `Unihan_Variants.txt`, run `npx tsx server/src/features/retrieval/buildHantHans.ts <path>/Unihan_Variants.txt --write`, commit `hantHans.ts`, then re-index: `cli.ts backfill --market intl --all --apply` and the same for `cn`.
12. Confirm by eye: the price row (item 1.3), and that `text-embedding-v4` accepts at most 10 inputs per request (`https://help.aliyun.com/zh/model-studio/embedding`; the fetch tool quoted "text-embedding-v4的批次大小为10").
13. Confirm or overrule the model switch at the crossover (item 5).
14. Already on the owner list (SM-7, SM-11): confirm OpenAI as embedding processor for RoboApply resumes and profiles, and decide whether GoApply embeds in the mainland.

## Schema requests

None needed. Everything used was delivered by MKT-0.

Optional, for the owner to decide:
- Keep both models' vectors during a model change, so the dense leg covers the whole market throughout: key `RAJobEmbedding` by `(jobId, model)` instead of `jobId`. This is not additive (it changes the primary key), so it is a decision, not a request:
  ```prisma
  model RAJobEmbedding {
    // …
    @@id([jobId, model])   // today: jobId String @id
    @@index([market, model])
  }
  ```
  The upsert conflict target, `jobEmbeddingMeta` and a purge of the previous model's rows after the switch would follow.
- `@@index([market, userId])` on `RAUserEmbedding` would serve the consent window; the primary key serves it while the table is small.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `EMBED_MODEL` | Embedding model for both brands, requested at 1024 dimensions | `openai/text-embedding-3-small` |
| `EMBED_API_KEY` | Key of the embeddings endpoint | unset → `OPENAI_API_KEY`, but only while `EMBED_BASE_URL` is unset |
| `EMBED_BASE_URL` | OpenAI-compatible base URL | unset → `OPENAI_BASE_URL`, then `https://api.openai.com/v1` |
| `EMBED_BATCH_SIZE` | Inputs per request, at most 96. **Set it to the vendor's limit** when that is lower. A refused batch is halved and the working size remembered per process, but every new process pays the refused requests again | 96 |
| `EMBED_DAILY_TOKENS` | Tokens a brand may embed per UTC day; 0 switches embedding off | 20000000 |
| `CN_EMBED_MODEL`, `CN_EMBED_DAILY_TOKENS` | Optional GoApply overrides | unset → shared |
| `CN_EMBED_BATCH_SIZE` | Optional GoApply override. **10 for `text-embedding-v4`** | unset → shared |
| `CN_EMBED_BASE_URL`, `CN_EMBED_API_KEY` | Optional GoApply endpoint and key. **One pair: set both or neither.** URL without key: GoApply embeds nothing (the shared key is never sent to GoApply's endpoint). Key without URL: GoApply embeds nothing (its key is never sent to the shared endpoint). For a separate GoApply account on the shared endpoint, set the URL to that same endpoint | unset → shared |

Read, not new: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CN_LLM_DOMESTIC_ONLY`, `CN_RESIDENCY_STRICT`, `CN_LLM_DOMESTIC_HOSTS`, `RA_SYSTEM_USER_ID`, `CN_RA_SYSTEM_USER_ID`.

`AppConfig` keys written: `retrieval.modelTag.<market>`, `retrieval.consentCursor.<market>`. Rate counter: `budget:embed:<brand>`. Work kinds: `job.index`, `user.embed`. Usage SKU: `ra_embed`.

## i18n keys added or changed

None. This bundle has no namespace and no user-facing string. `NlQueryResponse.rankedBy` is data; its sentence belongs to the M4 surface.

## Known gaps

1. **No SQL here has run against PostgreSQL.** The statements are tested as text and parameters with a recording double. The `::halfvec(1024)` cast, the `<=>` operator, `to_tsvector` in an `UPDATE`, the new `DELETE … USING` and the `UNION` in `embeddedUserIds` first run on the Neon branch. The CLI dry run (one `SELECT`) is a safe first probe.
2. **The fold table is empty** (item 2, Owner request 11).
3. **Segmentation depends on the ICU data of the Node runtime.** A Node upgrade that changes ICU's dictionary needs `backfill --all`.
4. **A person's vector is at most one sweep plus one queue drain behind** a resume or search change (about 15 to 20 minutes).
5. **A private import that got no vector at its hook run** gets one only at its next enrichment. The sweep asks for vectors of public rows only.
6. **The sweep's read scans the market's live rows** when nothing needs indexing (one `LEFT JOIN`, every 15 minutes per brand). It needs a look near 200,000 rows.
7. `rankedBy` falls back to cleaned-up unmatched phrases: the planner prompt (`job-search/agent.ts`, not mine) does not emit `relevanceTerms` yet. `isConstraintPhrase` is a word list; a wording outside it is ranked by.
8. RoboApply may send public job text to any configured endpoint, a mainland one included (the existing chat policy); user text never.
9. The cost of a call is known only for `text-embedding-3-small` on `api.openai.com`.
10. First-fill cost, for planning: about 500 tokens per posting, so 100,000 postings are about 50 million tokens (about $1 at the row above). The daily budget of 20 million tokens caps a brand at about 40,000 postings a day.
11. **During a model change the dense leg covers about half of the market at its lowest point** (item 5). With the daily budget a market of 100,000 rows is in the change for about two and a half days.
12. **An active person with nothing to embed** (no title, role, industry or goal, and no parsed resume) has no vector, so the sweep puts their finished `user.embed` item back on every run. The item reads the person and ends without a model call. At most 200 such items per brand per run.
13. **One posting the endpoint refuses on its own** (a 400 for a single input, for example a vendor's content check) fails its whole `job.index` item on every run, so the up to 95 postings queued with it get no vector while it stays among the newest rows that need one. Not observed. The fix is a per-row marker ("refused by the endpoint, do not ask again until the text changes"), which needs a column or a small table.
14. The consent window of the sweep stops at the first person whose record cannot be read and starts there again on the next run. A record that can never be read would hold the window at that person; the step is reported as failed on every run, so it is visible.

## Review resolution

Undone item:
- **Item 5 (a), the sweep cannot queue a set of rows twice: fixed.** See finding 1.
- **Item 5 (b), "a model change does not empty the dense leg" was not true: fixed** as the reviewer proposed (crossover), and the claim is restated honestly in the code, the tests and this handoff: the leg thins to about half. See finding 4.

Findings:
1. **High, sweep and backfill can never queue the same rows twice: fixed, all four parts.** (1) `sweep.ts` and the CLI enqueue `job.index` with `onConflict: 'requeue'`. (2) New `embeddingAvailability` in `platform/embeddings` (key, route policy, budget; no request); the sweep passes a null tag to `jobsNeedingIndex` when it is not `'ok'`, and queues no person when user text cannot be embedded. (3) `jobsNeedingIndex` orders rows that lack `searchDoc` or `contentHash` first. (4) `sweep.test.ts` has a queue double with the real conflict rule and tests for: an item finished without vectors is queued again; a dead item is queued again; a waiting or running item is never doubled; a market whose vectors are refused (policy, budget) gets search documents for all 1,500 rows behind 5,000 vector-only rows, across three runs, and then goes quiet. `cli.test.ts` has the same for a second `--apply`.
2. **Medium, the embedded resume text kept gender, birth date, 政治面貌, 籍贯, marital status and profile URLs: fixed.** `redactResumeText` drops sensitive-field lines and removes URLs before the redactor runs. The reviewer's two probe lines are in `userText.test.ts` and come out empty; the label lists are pinned. `workers.test.ts` asserts the default strip is `stripResumeForScoring` when exported and the fallback otherwise, and that neither lets such a line or a profile link through. The export itself is Request 1 (MKT-2F).
3. **Medium, a failed consent read deleted vectors: fixed.** `embedUser` and the sweep use strict gates (`hasLiveConsent` directly). A lookup error deletes nothing: the work item fails and is retried; the sweep skips the person when queueing and stops its consent walk. The `user.embed` key no longer blocks a person without a vector: `'requeue'` when `userEmbeddingMeta` shows no vector of the write tag. Tests for each in `workers.test.ts` and `sweep.test.ts`, including the default dependencies against a throwing consent lookup.
4. **Low, the dense leg shrank to about 10% before the switch: fixed** with the crossover (`MODEL_SWITCH_SHARE = 0.5`, counted on rows that carry either tag). `modelTag.test.ts` walks a whole re-embedding and asserts the query tag never covers less than half of the vectors. This departs from the plan's 90% (a choice the plan marks as the owner's to overrule): flagged under item 5 and Owner request 13. The `(jobId, model)` key is described under Schema requests.
5. **Low, an unreadable budget counter was reported as spent: fixed.** `hasRoom` throws; `embedTexts` and `embeddingAvailability` raise `EmbeddingsError` (`budget_unreadable`); no request is made. `'budget'` now means a counter that was read and is spent. The sweep treats a failed availability read as "ask for vectors" and lets the worker decide.
6. **Low, GoApply's own key could reach the shared endpoint: fixed** by the stricter of the reviewer's two options: an own key on a shared URL is `no_key` as well (the pair rule), since a separate account on the shared endpoint can name that URL. `embeddingEnvProblems` reports both half-set cases, the client logs them once, the env table names both. The test that accepted an own key on a shared URL is rewritten. Wiring into `platform/startup.ts` is Request 5 (not my file).
7. **Low, `rankedBy` carried pay and visa phrases, dropped real topics and could exceed 240 characters: fixed**, all four parts, each of the reviewer's examples in `filterDiff.test.ts`.
8. **Low, a gateway call was costed at OpenAI's list price: fixed.** `EmbeddingUsageEntry.host`; the cost is written only for `api.openai.com`.
9. **Low, default batch 96 above what `text-embedding-v4` accepts: fixed and documented.** The limit of 10 was confirmed on the vendor's page (through the fetch tool; Owner request 12). The env table and Request 10 (MKT-5H) say `CN_EMBED_BATCH_SIZE=10`. The client also halves a refused multi-input batch and remembers the size that worked, so a forgotten setting costs refused requests, not dead items.
10. **Low, any `.net` domain became `dotnet`: fixed** with a lookbehind (not after a letter, digit, dot, `@`, `_` or `-`) plus `asp|ado|vb`. A URL, an e-mail address and the reviewer's two probes are in `segment.test.ts`. Existing documents keep their old tokens until re-indexed (`backfill --all`), which the Unihan step needs anyway.
11. **Low, the vector of a private import outlived the AI consent: fixed.** `deleteJobEmbeddingsOfOwner` in `repo.ts`, called by `embedUser` and by the sweep's consent step when the AI consent is gone. The sweep's window now also lists owners of private-import vectors who have no vector of their own. Named in Request 8 (MKT-4A).

Unowned edits:
- `.vitest/json/output.json`: deleted. It is the output file of vitest's JSON reporter; I removed it again after the one run in this round that used that reporter. `git status` shows nothing outside my owns.

Rejected: nothing. One point was changed in form, not in substance: finding 4 keeps a named constant (the plan asks for one) instead of a bare comparison.
