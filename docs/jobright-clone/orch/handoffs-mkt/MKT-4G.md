# MKT-4G

Scorer v4: the model fills a requirement checklist and the server computes every number; resume-first prompt; one pinned scorer version per market; the borderline rule; planned backfill in feed order; the scorer suite of the harness. Worktree `wp-MKT-4G`, branch `wp/MKT-4G`. Nothing committed, nothing pushed, no schema change, no network, no model call, no database.

This is the handoff after the independent review. All four items are done, the carry-over entry the reviewer judged not done is done, and all ten findings are resolved (none rejected; two are resolved with a stated refinement). The list is at the end under "Review resolution". Two tests outside my owns are red by design (listed with what they should assert). No item disagreed with the plan documents; where I added to an item or read it one way, it is listed under "Decisions" with the reason. I read MKT-4D's handoff and did what it asks of this bundle.

## Items

### 1. [P0] Scorer v4 agent: a checklist, never a number; resume first (done)

`server/src/roboapply/v2/agents/RAJobMatchScorerAgent.ts`: `RAJobMatchScorerV4Agent` beside the v3 class (v3 is unchanged).

- Output: `{ requirements: [{ id, kind, text, importance, status, evidence }], level: { post, resume, direction }, domain: { status, evidence }, trajectory: { status, evidence }, strengths[<=5], gaps[<=5], summary }`. No score anywhere. `parseScorerV4Output` builds the object from the named fields only, so a `score`, `total` or `percentage` the model adds at any depth is never read. A summary that states a number is dropped (`SUMMARY_NUMBER`).
- Throws `ScorerV4AnswerError` (the caller answers the estimate and stores nothing): not JSON, `requirements` not a list, `level` / `domain` / `trajectory` missing, or any fixed-list value (kind, importance, status, a level name, a domain or trajectory status) not on its list. Nothing is guessed. `direction` is derived from the two levels, so the three cannot disagree.
- `kind` and `importance` of an entry may be left out (they are then `null`): with a stored list the prompt says "fill only status and evidence" and the server reads both from the store. One that is given and is not on its list still throws. The status is never optional.
- Prompt: persona line, second-person rule, and the v3 hard rules (never invent; school tier, age, gender, nationality, ethnicity, family, photo, 籍贯, 政治面貌 are not inputs; gaps are observations; summary states no number). The "score each 0-100" section is replaced by the checklist and the four anchors (`met` with a verbatim resume quote, `partly` with a quote, `not_shown` with none, `not_applicable` for a line that is not a requirement of the candidate). A quote is "the phrase or the whole line that shows the requirement, not a single word on its own". Stored-list mode: return exactly the given ids and texts and fill status and evidence. No list: copy at most 12 lines verbatim first.
- Input order (`formatScorerV4Input`): `## Candidate profile`, `## Candidate resume`, then `## Job post`, qualifications, responsibilities, `## Requirements to check` (stored mode), the logistics facts, the closing instruction. Everything before `## Job post` is byte-identical for two jobs of one person (tested).
- Temperature 0, max tokens 2,400. Exports `SCORER_V4_PROMPT_VERSION = 'scorer_v4'`, the input and output types, `parseScorerV4Output`, `formatScorerV4Input`, `formatScorerV4Candidate`, `SCORER_V4_JOB_SECTION`, `ScorerV4AnswerError`.

Decisions that go beyond the item text:

1. **The output-language directive is v4's own.** The strict directive v3 uses asks for "evidence sentences" in the UI language. A translated quote fails the verbatim check and is downgraded, so the number would depend on the UI language. v4 says: `strengths`, `gaps` and `summary` in the UI language; every `text` and `evidence` copied character for character; fixed-list values and keys as written.
2. **The saved search is not an input of v4** (v3 passes it as "what the candidate is looking for"). The checklist compares the resume with the posting and nothing else (I3 read strictly).
3. **With no locale, the language is detected from the resume, not the posting**, so the system prompt stays the same across one person's jobs (the cached prefix). MatchService always passes a locale, so this only matters for a direct caller.

Tests: `RAJobMatchScorerAgent.test.ts`, 23 (17 for v4): the anchors and no "score each"; the kept hard rules; the quote instruction; stored-list instructions; temperature, tokens, version, the six level names equal `SENIORITY_LEVELS`; the language directive; prefix equality; job facts and no saved search; stored list one JSON line per entry; parser (valid, fences and prose around it, stray numbers at every depth, each unknown value, each missing part, kind and importance left out, the typed error, derived direction, caps, summary with a score).

### 2. [P0] The server computes every component; evidence is verified; the checklist is stored once per posting (done)

New `server/src/features/match/scorerV4.ts` (pure): `componentsFromChecklist(out, { weights, logistics, sources, stored, classYear, posting })` returns `{ dimensions, requirements, level, domain, trajectory, extracted, unverified }`.

**Which lines are judged.**

- Stored list: id, kind, text and importance come from the store, never from the model; an entry the list does not have is ignored; an answer that leaves a stored line out throws `ScorerV4ChecklistError`.
- No stored list (the model's own copy): a copied line is kept only when it is a verbatim substring of the posting (the CitationGuard of `evidence.ts`, same normalisation); duplicates dropped; at most 12; ids `r1…rN` assigned by the server. A line that is not in the posting disappears with whatever was claimed about it.
- **A line that disappears must not move the number** (review finding 1). A dropped "not shown" line would raise the share of what is left. So a copy the server cannot trust is refused like an incomplete stored answer (`ScorerV4ChecklistError`: the estimate answers, nothing is stored):
  - more than a third of the copied lines are not in the posting (`CHECKLIST_UNVERIFIED_MAX_SHARE`; a line with no text, no kind or no importance counts as missing);
  - no skill or experience line is left although the answer had one;
  - no skill or experience line is left although the posting itself lists hard skills or states years of experience;
  - the answer copied no line at all of a posting that has a qualifications section.
- **A copy is stored on the job only when every copied line was found in the posting** (`extracted` is null otherwise). A copy with a line missing serves this one score; the next score copies again. A thinned list never becomes the posting's checklist for everyone.
- Lines the model marks `not_applicable`, lines that are never judged and repeated lines are not copied lines: they count neither as kept nor as missing.

**Quotes.** A `met` or `partly` whose quote is not a verbatim substring of the PII-stripped resume the model saw becomes `not_shown` with empty evidence. A quote of one or two characters is a true quote when it stands in the text as a word of its own (`shortQuoteIn`, review finding 2): two characters of a script written without spaces (本科 in "北京大学 本科"; one such character alone never), or a short name that holds a letter and is not next to a letter or a digit ("Go" in "TypeScript, Go, SQL", never in "Google"; "C" is not a quote of "C++" or "C#", "R" not of "R&D"). The same rule keeps a two-character requirement line of the posting.

**Numbers**, as the item states: points 1 / 0.5 / 0, weights must 1 and preferred 0.5, `not_applicable` left out; skills over kinds skill and experience (not stated with none); title_level 100 / 60 / 25 / 0 by level distance, halved for a required education line that is not shown and, on GoApply, for a stated 届别 that excludes the person; industry 100 / 60 / 20; career_path 100 / 60 / 25; logistics is the caller's deterministic component, object for object. Total: `combineDimensions`, unchanged.

**`MatchService`.** The pinned rubric picks the scorer. v4 gets `RAJob.requirements` items or none. Row: `dimensions`, `explanation { strengths, gaps, rationale, requirements, level, domain, trajectory, estimateAtScore, responseLanguage, promptVersion }` (plus `tierRule` when the borderline rule applied), `promptVersion scorer_v4`, `rubricVersion fit_v4`, `jobContentHash`. The rewrite path writes strengths, gaps and summary only; the checklist is not even recomputed for a rewrite. A failed run says what failed: `ScorerFailedError.kind` is `answer` (the model answered and the answer is refused: the v4 parser, `ScorerV4ChecklistError`, or nothing scored) or `call` (transport, provider, the resume strip).

**I4 on an AI fit** (`fit.ts` `tierWithinCoverage`, `thinCoverage`, `aiCoverage`). A result that could judge less than 60% of the rubric weight is never Great and its confidence is low, when it is stored and on every read (the read needs it too: the 3-point rule alone would lift a stored Good with a total of 100 back to Great). The total is shown as computed.

**`repo.ts`**: `MatchRepo.saveJobRequirements(jobId, { v: 1, contentHash, model, extractedAt, items })`, one guarded `UPDATE`. A failed or lost write never fails the score.

**`fit.ts`**: `Fit.requirements` and `MatchFitView.requirements` carry the checklist on single-job reads of a v4 row. A list carries none, like the prose. `[]` for an estimate and for a v3 row. The fit-analysis card carries it too (additive spread; Request 2).

Decisions beyond the item text:

1. **Lines that are never judged** (`isNotJudgedRequirement`). A line about the applicant's own age, gender, marital status, 籍贯, 户口, political status, ethnicity, religion, photo, school tier (C15), citizenship or right to work cannot be "shown" by a resume that is stripped of those, and the product must not judge it. In v4 a copied "年龄35岁以下" would mechanically read `not_shown` and lower the score, which makes an age cap an input (strategy 2.5 forbids it). Such a line is `not_applicable` for everyone in a stored list and is not kept from a copy. Every pattern needs wording about the applicant (要求, 限, "must be", a label, 优先, "only", "authorized to work"): the topic word alone is not enough, so "citizenship applications", "Visa sponsorship programs for clients", "selling to top universities", "users aged 65 and older", "211 call center systems", 民族品牌, 党员管理系统 and 户籍管理系统 stay requirements. A school-tier phrase counts only next to a degree or graduate word. Tested both ways: 60 lines that must match, 60 that must not.
2. **A 届别 line of the checklist is the same fact as the profile rule.** On GoApply the profile rule decides it alone, so it is counted once (the estimate's rule: `classYearEligibility`, pinned equal to `titleLevelDimension` case by case in a test).
3. **A stored list longer than 12 is judged on its first 12 lines**, the same 12 for everyone.
4. **A qualifications section that asks for a degree and nothing else is truly copied by its degree line** (campus postings, 管培生). The review asked to refuse every copy without a skill or experience line when the posting "lists skills or qualifications". I refuse it when the posting lists hard skills or states years (its own structured fields say there is a skill or experience line), and I refuse an empty copy of a posting with a qualifications section. A degree-only copy of a degree-only section is accepted: refusing it would deny that whole class of GoApply postings an AI fit for good, with a paid call thrown away on every attempt.
5. **I4 for an AI fit is read on the weight the scorer could judge** (the fit's own `coverage`), the counterpart of the estimate's "what the posting states". It applies to every stored AI row on read (v3 rows too): one rule. No test outside my owns moved.
6. **Only v4 answers are `answer` failures.** Scorer v3 runs at temperature 0.1 and its class is unchanged: its parse errors stay retryable.

**MKT-4D request 4 (their handoff), done.** A stored list is used only when its `contentHash` equals the hash of the posting as it reads now, computed from the row's own text and skills (`jobContentHash(row)`), not the stored `RAJob.contentHash`: `job.index` writes that column a moment after enrichment wrote a list, so the stored column would call a fresh list stale in that window (tested). The write replaces a stale list: `WHERE "id" = $2 AND ("requirements" IS NULL OR "requirements" = 'null'::jsonb OR ("requirements"->>'contentHash') IS DISTINCT FROM $3)`. First writer still wins per text of the posting.

Tests: `scorerV4.test.ts` 58 (anchors; the recorded answer by hand, 79; evidence text; invented quote; quote matching; a line not in the posting; the three refusal rules with the review's reworded-line cases; the one-third tolerance and what is not stored; short quotes in Latin and Han; cap and ids; stray numbers; weights; kinds; not-stated cases; domain and trajectory; level distances; education halving; 届别; stored mode incl. an answer by id only; `readStoredRequirements`; never-judged lines; `borderlineTier` at every edge). `MatchService.test.ts` 86 (row fields, both brands, the rollback, model change, stored mode, first-writer rule, stale list, lost race and failed write, list against single read, the card, rewrite, the review's probes through the service: 74 / Good verbatim against the estimate when reworded, 64 / Possible against the estimate; one reworded line in three and nothing stored; an empty checklist refused; a degree-only posting accepted; I4 stored and read; failure kinds; `rewriteBlocked` on stale rows; short quotes through the strip). `fit.test.ts` 77 (the contract, the checklist on the view, I4).

### 3. [P0] One pinned scorer version per market; the borderline rule; planned backfill (done)

- `config.ts`: `scorerRubric(brand, env)` reads `MATCH_SCORER_RUBRIC` through `brandEnv` (GoApply: `CN_MATCH_SCORER_RUBRIC`, else the shared value); `fit_v4` unless the value is exactly `fit_v3`; a typo keeps the default. `currentScorerPin(brand, model, env)` returns `{ model, prompt, rubric }`. `scorerRoute.ts` is unchanged and still decides the route.
- No bulk invalidation. A row of another model, prompt or rubric is `stale` and keeps serving; the cron and on-demand calls replace it inside the existing budgets.
- Borderline rule (`scorerV4.borderlineTier`): a new v4 total within 3 points of an edge is stored with the tier on the estimate's side of that edge. No second call; the score is stored as computed. 66 with an estimate of 58 is stored Possible; 69 is Good. The edge and the estimate are recorded in `explanation.tierRule`. Scorer v3 keeps its rule.
- `cron.ts`: the pick order is the feed list's order; a candidate is skipped only when it has a row of the current pin for the posting as it is now; visibility is checked with `visibleTo`. Budgets unchanged. The dedupe key includes the prompt. **The walk goes down the feed's order until the allowance (and the brand budget) worth of items was really queued** (review finding 7): an item that already exists (waiting, or dead) takes no slot, so it cannot hold the head of the list. **An item that is done while its pair has no fresh score is queued again** (`onConflict: 'requeue'`): its row was replaced since (fit_v4, fit_v3 and back; model A, B and back), and the same version key would otherwise block the pair for the 7 days a finished item is kept. A dead item is left alone.
- `workers.ts`: the payload names no version; the worker scores with the pin of the moment it runs. **An answer that was received and refused is `PermanentWorkError`** (review finding 6): the item is dead after one attempt, one model call and one unit of the brand budget, not five. A call that failed is still retried with backoff.

Decisions:

1. **Which estimate decides the side.** The estimate as the fit contract shows it: on the AI scale once the market has a calibration map, the plain v2 estimate before. `estimateAtScore` still stores the raw estimate, as calibration needs.
2. **A posting the estimate cannot compare is queued too.**
3. **A service that was handed a scorer never reaches for a real agent.** With neither `scorer` nor `scorerV4` given (production) both real agents are available and the pin picks. A service built with one fake scores with that one and its pin follows, so the test worlds of other areas that inject a v3 fake keep working under the `fit_v4` default.

Tests: `config.test.ts` 6. `cron.test.ts` 29: feed order, caps, freshness per pin and per brand, gradual re-queue; on the platform's real `enqueue` over an in-memory table: v4, v3, v4 on one queue (the three finished items are queued again, no seventh item, the allowance charged for three, a second run queues nothing), model A, B, A, a finished item with a fresh row untouched, a dead and a waiting item taking no slot; through the real `drain` on the real service: a refused checklist is dead after one attempt with one scorer call and one budget unit, an upstream 502 is retried, a usable answer is done. `scorerV3.test.ts` untouched, 9 green.

### 4. [P1] Scorer stability and validity suite (done)

`eval/suites/scorer.suite.ts`, `eval/fixtures/scorer/selfcheck.json` and `README.md`, `eval/suites/scorer.suite.test.ts`.

- Replay goes through the product's own path: `getFit` on a MatchService built on the harness world whose scorer returns the parsed recorded answer.
- Offline: `fixtures/scorer/recorded.<market>.json` gives `icc_3_runs` and `tier_flip_rate`; `audit.<market>.json` (recruiters' grades) gives `spearman_human` with `human` labels; `recorded.v3.<market>.json` adds `spearman_human_v3` and `spearman_human_gain_over_v3` as information. With no recording the three rows read `no_fixture`.
- **Unusable answers are never dropped quietly** (review finding 3). `tier_flip_rate` is the share of pairs that did not get one and the same tier in all three runs, over every pair on today's inputs: a run with no usable answer (failed call, answer that does not parse, refused checklist) is such a pair, whether one run or all three gave nothing. `icc_3_runs` and `spearman_human` are computed over the pairs every run scored and are read only when those are at least 90% of the pairs (`MIN_MEASURED_SHARE`) and at least 30 (`SCORER_MIN_PAIRS`, the bound of the judge audit); below either the row reads `no_fixture` and says why, and the flip rate carries the failure. `spearman_human` needs 30 graded pairs. A recording with fewer than 30 pairs on today's inputs is too small a sample: all three rows read `no_fixture`.
- **Every score of the suite is a first score** (review finding 5): `scoreOnce` hands the service a repository without `saveJobRequirements`, so no pair is ever handed another pair's copied lines and the order of recording (four at a time) and replay (one by one) cannot matter, also once the test repository stores lists.
- Self-check, always: ten hand-written pairs with three hand-written answers each. Every total, tier and component is worked out by hand in the fixture. ICC 1 and no flip, or the suite throws. Two pairs (sc03, sc10) were reworked so no answer has more than a third of its copied lines missing from the posting; the totals are unchanged (67 and 44).
- Live: `recordMarket` calls the pinned scorer three times on a fixed draw of 100 pooled synthetic pairs, inside the market's brand, and writes the recording and a sheet for recruiters under `eval/.snapshots/<date>/scorer/`. `--import-audit` turns the graded sheet into the audit fixture. Recording needs `EVAL_SCORER_RECORD=1` next to `EVAL_LIVE=1`.

Tests: 21 in `scorer.suite.test.ts` (loader shape; the committed self-check; a wrong expectation fails; record then replay with answers that copy a real line of each posting; one flip and two unusable runs in 32 pairs fail the flip gate; a third of the totals moving misses both gates; a third of the pairs with one unusable run: flip rate 11/32 fails the command, ICC and Spearman read `no_fixture` although the survivors alone give ICC 1; all three runs unusable counts too; stale inputs; fewer than 30 pairs; two people on one posting with a repository that stores lists; Spearman with 32 and with 29 graded pairs and the v3 comparison; nothing written without a model; the audit import). `npm run eval:match` prints `selfcheck_icc_3_runs 1.0000 n=10`, `selfcheck_tier_flip_rate 0.0000 n=10` and six `no_fixture` rows.

### Carry-over

| Entry | Result |
|---|---|
| M1 MKT-4G.0 (hysteresis, Owner 20) | Read path left as built: the owner has not chosen. The borderline rule on a new v4 result depends on it: the read path is what keeps a stored borderline tier (66 / Possible) on later reads. So "keep it" is the consistent choice, and `/help/ranking` should say a tier can lag the number by up to 3 points (copy; `landing` is MKT-4F's). |
| M1 MKT-4G.1 (logistics at the prior in the AI total; `spearman_human` producer; baseline rule) | Logistics unchanged, as my item 2 states. `spearman_human` has its producer. I changed none of the six generated fixture files, so the ranking baseline is untouched. |
| M2 MKT-4G.1 (`rewriteBlocked`; `preScoreMany`) | **Done after the review.** `rewriteBlocked` (`daily_cap`, `budget`, `ai_unavailable`, `ai_failed`) is set whenever the person asked for the written parts in another language and they could not be written, on a current row (a rewrite) and on a stale row (its re-score would have written them). After this deploy every stored row is stale, so that is the common case. A re-score nobody asked a rewrite of sets nothing. `preScoreMany` stays: `eval/testdata/fitShim.ts` (not mine) calls it. |
| M2 MKT-4G.2 and .5 (the scorer's strip) | Fixed for the scorer: `MatchService` runs two strips one after the other, `stripResumeForScoring` then the retrieval area's `redactResumeText`. The patterns live once, in `retrieval/userText.ts`. A strip that cannot run sends nothing to a model. `stripResumeForScoring` alone is still the weaker one, so it stays unexported (Request 10). |
| M2 MKT-4G.3 (`estimateForPosting` stored-score query) | Done: `fitMany` asks for no stored score of the ad-hoc id. |
| M2 MKT-4G.4 (`matchScoreCached` write) | Done: the write and the Prisma method are gone. The interface member is kept optional and deprecated only because `testkit.ts` implements it (Request 1). |
| M3 | No section for this bundle. |

## Files changed

Modified: `server/src/roboapply/v2/agents/RAJobMatchScorerAgent.ts`, `RAJobMatchScorerAgent.test.ts`; `server/src/features/match/MatchService.ts`, `MatchService.test.ts`, `fit.ts`, `fit.test.ts`, `config.ts`, `repo.ts`, `cron.ts`, `cron.test.ts`, `workers.ts`.

New: `server/src/features/match/scorerV4.ts`, `scorerV4.test.ts`, `config.test.ts`, `repo.test.ts`; `server/src/features/match/eval/suites/scorer.suite.ts`, `scorer.suite.test.ts`; `server/src/features/match/eval/fixtures/scorer/selfcheck.json`, `README.md`.

Owned and unchanged: `scorerRoute.ts`, `scorerV3.test.ts`. No file outside my owns is edited or left behind: `git status --porcelain -uall` lists these 19 paths and nothing else (`config.test.ts`, `repo.test.ts` and `scorer.suite.test.ts` are tests colocated with owned files). The stray `.vitest/json/output.json` of the earlier run is deleted.

Absolute paths: worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4G`; handoff `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4G.md`.

## Tests run

| Command | Result |
|---|---|
| The nine test files I wrote or touched | 314 of 314 (agent 23, scorerV4 58, MatchService 86, fit 77, cron 29, config 6, repo 5, scorerV3 9, suite 21) |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M2` | exit 0 (INV-7 pending, due M4, MKT-4E) |
| `npx vitest run --exclude ".claude/**"` | 733 files: 731 passed, 2 failed; 18,517 tests passed, 2 failed, 1 skipped, 10 todo. The 2 are the red tests below. Run three times after the review changes, the same each time; no timeout or flake in any run. |

## Red tests for other bundles

1. `server/src/features/match/inputs.test.ts` › "the scorer pin and the calibration minimum" (MKT-4E owns the file). It asserts `currentScorerPin(brand, model)` is `scorer_v3` / `fit_v3`. The default is now `fit_v4`. It should assert `{ prompt: 'scorer_v4', rubric: 'fit_v4' }` with nothing set and v3 with `{ MATCH_SCORER_RUBRIC: 'fit_v3' }` as third argument, or drop the two lines: `config.test.ts` covers the pin.
2. `server/src/features/match/eval/run.test.ts` › "the shipped suites are taxonomy, ranking and language" (no owner in M4: orchestrator). Any new suite file breaks it. After the merge the list is the suites on disk, by name: `['language', 'ranking', 'retrieval', 'scorer', 'skills', 'taxonomy']` if MKT-4E and MKT-4F ship theirs under those names.

## Pre-existing failures

None.

## Requests

**MKT-4E**

1. `match/testkit.ts` `createMemoryRepo`: add `saveJobRequirements` and remove `updateVariantCachedScore` and `cachedScores`:
   ```ts
   async saveJobRequirements(jobId, doc) {
     const job = state.jobs.find((j) => j.id === jobId);
     if (!job) return false;
     const had = job.requirements as { contentHash?: unknown } | null | undefined;
     if (had && had.contentHash === doc.contentHash) return false;
     job.requirements = doc;
     return true;
   },
   ```
   Then `repo.ts` can make `saveJobRequirements` required and delete the deprecated `updateVariantCachedScore?`, and `MatchService.test.ts` can drop its `withRequirementStore` helper and the two lines that read `cachedScores`. My tests hold before and after this change: each puts the store, or its absence, on the repository itself, and the fake answers use the ids a stored list has (r1, r2). The scorer suite never stores a list (tested with a storing repository).
2. `match/contract.ts`: `FitAnalysisCard.requirements?: RequirementCheck[]` (the service already sends it for a v4 fit). `SCORER_PROMPT_VERSION` is no longer read by production code. The comments on `MatchExplanationSchema` and on `MatchFitView.rewriteBlocked` can name the v4 keys (`requirements`, `level`, `domain`, `trajectory`, `tierRule`) and say that `rewriteBlocked` is also set on a stale row.
3. `match/preScore.ts`: export the 届别 rule of `titleLevelDimension` as a function so `scorerV4.classYearEligibility` calls it instead of restating it (a test pins the two equal today).
4. UI (`components/features/match`): `requirements` holds `not_applicable` entries when the list is a stored one; a v4 fit has empty `keywordsMatched` and `keywordsMissing`; `rewriteBlocked` is set now (on current and on stale rows) and nothing renders it yet; an AI fit that could judge under 60% of the rubric reads at most Good with confidence `low` while its number is shown as computed (it can be 100), so the low-confidence line should be visible next to it.

**Orchestrator**

5. `eval/live/index.ts` `defaultScoreOnce` still calls `RAJobMatchScorerV3Agent` directly, so the live rows `scorer icc_3_runs [live]` measure v3. Replace its body with the pinned scorer:
   ```ts
   const { scoreOnce } = await import('../suites/scorer.suite.js');
   const { currentScorerPin } = await import('../../config.js');
   const world = recordsWorld(market, [persona], [row as MatchJobRecord]);
   return (await scoreOnce(world, { userId: persona.id, jobId: row.id, locale: persona.locale, prompt: currentScorerPin(brandOfMarket(market), model).prompt, answerer: { kind: 'live' }, deps: { resolveModel: () => model, routeAllowed: undefined } })).score;
   ```
6. `eval/gates.ts`: "Spearman not below the v3 value" has no gate. Add `{ layer: 'scorer', metric: 'spearman_human_gain_over_v3', rule: { kind: 'min', threshold: 0 }, sample: 'audited pairs, both scorers' }`. The `sample` text of `tier_flip_rate` can say "a run with no usable answer counts as a flip". `eval/README.md`: the shipped suites, the scorer fixtures, `EVAL_SCORER_RECORD`, how a recording is read (the text is in `eval/fixtures/scorer/README.md`).
7. `eval/world.ts`: the harness worlds inject a v3 fake only, so INV-3 and INV-10 run the v3 path (valid: the gates before the call are shared). To run the default pin there, add a counting v4 fake to `createWorld` deps. It must copy a line of the posting, as a model does: an empty checklist is refused for a posting that lists skills. Checked against the committed fixtures of both markets (240 of 240 pairs scored):
   ```ts
   scorerV4: { run: async (input) => { scorer.calls += 1; const line = String(input.job.qualifications || input.job.description).split(/(?<=[.。])\s+/)[0]!.replace(/[.。]$/, '').slice(0, 240); return { requirements: [{ id: 'r1', kind: 'experience', text: line, importance: 'must', status: 'not_shown', evidence: '' }], level: { post: 'senior', resume: 'senior', direction: 'match' }, domain: { status: 'not_stated', evidence: '' }, trajectory: { status: 'neutral', evidence: '' }, strengths: [], gaps: [], summary: null }; } },
   ```
8. `match/calibration.ts` (`pairsFor`): pass the pinned prompt so the map and the priors are learned from one scorer's rows: `deps.store.listCalibrationPairs({ market, since, limit: CALIBRATION_PAIR_LIMIT, promptVersion: currentScorerPin(market === 'cn' ? 'goapply' : 'roboapply', null, env).prompt })`. `repo.ts` accepts the optional `promptVersion` (tested as SQL text). Until then v3 and v4 pairs are mixed while the backfill runs.
9. `.gitignore`: add `.vitest/` (a `--reporter=json --outputFile` run writes there; the file of my earlier run is deleted, and a merge by explicit paths would not have taken it).
10. `match/pii.ts` and `match/index.ts` (no owner in M4): either leave them (the scorer is covered by the composition in `MatchService`), or move the retrieval rules into `pii.ts` and then export `stripResumeForScoring`. `match/evidence.ts`: its private `stripQuoteMarks` is restated in `scorerV4.ts` (`bareQuote`) for the short-quote rule; exporting it would remove the copy.
11. Merge-time check with MKT-4D: two `readStoredRequirements` exist (`match/scorerV4.ts`, with the content-hash test and the cap of 12, and `jobs/enrich/index.ts`). Their write guard and mine agree: one list per text of the posting, the first writer wins. Their never-judged filter (`WORK_AUTHORIZATION_LINE`, `isAgeLine`) and mine (`isNotJudgedRequirement`) are two lists for one purpose; mine is the wider one (it also covers gender, 户口, politics, school tier) and applies again when a stored line is read, so a line their filter lets through is still not judged.
12. `eval/run.ts`: `--live --suite scorer` still runs the whole live run. Recording alone would be cheaper if `--suite` skipped it.
13. `MARKET_TASK_PLAN.md` 3.3 "as built": the fit contract row (`Fit.rewriteBlocked` on current and stale rows; `requirements` on single-job reads only; an AI fit under 60% coverage is at most Good with low confidence), the requirement row (a stored list is for one `contentHash`; at most 12 lines judged; a copy is stored only when every line is the posting's), `ScorerFailedError.kind`, the env rows below.

**Owner**

14. SM-8 recording: `EVAL_LIVE=1 EVAL_SCORER_RECORD=1 npm run eval:match -- --live`, review `eval/.snapshots/<date>/scorer/recorded.<market>.json`, copy it to `eval/fixtures/scorer/`, have recruiters grade `audit.<market>.csv`, then `npx tsx server/src/features/match/eval/suites/scorer.suite.ts --import-audit <csv> --market <m>`. The three gates can only be read from that. The note of each row says how many pairs had a run with no usable answer: that number is the first reading of how often a real model's copy is refused.
15. **The refusal rules are a choice with no data behind the numbers.** One third of the copied lines may be missing; more refuses the answer. If the recording shows many refused answers, the levers are the prompt (copy verbatim) and that share, not a looser check: a looser check lets a reworded line raise the score.
16. **A thin AI fit: the number or the tier.** An AI fit that could judge under 60% of the rubric is at most Good with low confidence, and its number is shown as computed (it can read 100 next to "Good"). The estimate caps the number itself (79) in the same case. I kept the number because the plan says AI totals keep today's arithmetic. Capping it too would be one line in `assembleFit`.
17. **title_level in v4 is the level distance only** (strategy and MATCH 4.8, implemented as written). A posting of another discipline at the same level gets title_level 100. Worked example: a senior nurse's resume against a senior backend posting, location and pay met: level 100, skills 0, domain unrelated 20, trajectory away 25: (35×100 + 0 + 15×20 + 10×100 + 10×25) / 100 = 51, Possible. Scorer v3 judged title and level together and put that component near 0. Precompute scores feed candidates, which the role filter keeps on-discipline, so the exposure is the job page of an off-discipline posting. A fix would be one more anchored judgment (role: same / related / other) multiplying the level anchor; it changes the rubric, so it is yours to decide. The validity gate (Spearman with recruiters) is where it shows.
18. Owner 20 (hysteresis): see the carry-over table.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `MATCH_SCORER_RUBRIC` | The rubric the fit scorer writes: `fit_v4` (requirement checklist, `scorer_v4`) or `fit_v3` (four judged components, `scorer_v3`: the rollback). Any other value keeps the default. A change needs no deploy; rows of the other rubric keep serving, flagged stale, and are replaced within the budgets. | `fit_v4` |
| `CN_MATCH_SCORER_RUBRIC` | GoApply's own value; unset, GoApply reads `MATCH_SCORER_RUBRIC`. A value that is not a rubric gives `fit_v4`, not the shared value. | unset |
| `LLM_MATCHING_MODEL` / `CN_LLM_MATCHING_MODEL` | Existing, unchanged: the one pinned scorer model per market (unset: `LLM_MODEL`; GoApply unset: the shared value). | unchanged |
| `EVAL_SCORER_RECORD` | Shell switch. `1` with `EVAL_LIVE=1` lets a live harness run call the pinned scorer (3 runs × 100 synthetic pairs per market) and write a recording. Read from the process environment only. | unset: nothing is recorded |

No variable was added by the review changes: the one-third share, the 90% and the 30 pairs are named constants (`CHECKLIST_UNVERIFIED_MAX_SHARE`, `MIN_MEASURED_SHARE`, `SCORER_MIN_PAIRS`).

## i18n keys added or changed

None (no namespace).

## Known gaps

- **No model was called.** The v4 prompt has never met a model. How often a model copies a line and a quote exactly, how often its copy is refused, whether 2,400 output tokens hold 12 lines with quotes in Chinese, and the three gates are unknown until the owner's recording.
- **A refused answer is a paid call that ends in the estimate, and nothing remembers it.** The queue worker stops after one attempt. The job page does not: every open of the page asks again, inside the person's 80 a day and the brand budget, and at temperature 0 likely gets the same refusal. I added no memory of a refusal: its right length depends on how deterministic the real model is, which nobody has measured.
- **A dead queue item keeps its pair out of precompute** for that version of the resume, posting, model and prompt until the item is pruned (30 days). The pair still scores on demand, and when another person's clean copy has stored the posting's list, an on-demand score of the refused pair uses it.
- **The server can check that a copied line is the posting's, not that the copy is complete.** A verbatim copy of two lines of a posting that has eight is stored as its list (unless it has no skill or experience line while the posting lists skills or years). Enrichment v3 (MKT-4D) writes the list first for most postings.
- **Within the one-third tolerance a missing line still changes that one score**: the share is taken over the lines that are left (higher when the missing line was not shown, lower when it was met). It is not stored for anyone else.
- **Short quotes.** "Go" is accepted from "go-live support" (the hyphen is not a letter). "AI" from "AI-driven" is accepted for the same reason, which is the case that rule is for.
- **Never-judged patterns are word lists, now narrow.** A wording outside them (上海户口 with no 要求 or 优先, "top universities" with no degree word) is left to the prompt's rule; if the model copies such a line and answers "not shown", it lowers the score. Two over-matches are known and tested as such ("graduate admissions at elite universities", 985/211高校毕业生招聘经验): such a line is left out, never held against anyone.
- **One level of difference in the model's reading moves the total 14 points** (35% of 100 against 60). It is the largest source of run-to-run change by construction.
- **Evidence must be a resume quote.** A skill that is only in the profile reads "not shown" in the checklist, while the estimate counts profile skills.
- **Two first scores of one posting at the same moment**: both copy their own lines, one write wins, and the loser's row keeps its own (verified) checklist.
- `explanation.level`, `.domain`, `.trajectory` and `.tierRule` are stored and not on the wire (`contract.ts` has no fields for them).
- After the deploy every stored v3 fit is stale at once. Replacement is gradual: at most 25 a day per active person from the cron, plus on-demand opens (80 a day per person), inside the brand budget (20,000 a day). No estimate of the total number of calls: it depends on stored rows per person, which I did not read.
- When the queue does not drain, the cron's walk can leave up to 50 waiting items per person (the candidate list) instead of 25: an item that waits no longer blocks the ones behind it.
- `preScoreMany` and the optional `updateVariantCachedScore?` remain (reasons in the carry-over table).

## Review resolution

Each finding was checked against the code before it was changed. All ten are real. None is rejected.

| # | Finding | Result |
|---|---|---|
| Undone | Carry-over M2 MKT-4G.1: `rewriteBlocked` is not set on a stale row | **Done.** Confirmed: `blocked` keyed on `rewrite`, which is set only for a current row. `wantsProse` is now computed outside the branch and `blocked` keys on it, in every return that keeps the stored fit (no model, capped, failed call, an answer that scored nothing). Tests: a stale v3 row under the v4 pin with `{ locale: 'zh', regenerateExplanation: true }` and each reason (`daily_cap`, `budget`, `ai_unavailable` by no model and by a refused route, `ai_failed` by a failed call and by a refused answer); a row of another model; a changed posting; no flag when no rewrite was asked, when the language already matches, and on a cache-only read; a stale row that can be re-scored is written in the language asked for. `preScoreMany` stays (reason accepted by the reviewer). |
| 1 (high) | Lines the model did not copy verbatim vanish from the denominator | **Done, with one refinement.** `componentsFromChecklist` counts the copied lines that fail the posting check and throws when more than a third fail, when no skill or experience line is left although the answer had one, when the posting lists hard skills or states years and the copy has no such line, and when a posting with a qualifications section gets an empty copy. `extracted` is returned only when every copied line verified. I4: `tierWithinCoverage` holds an AI fit under 60% coverage at Good with low confidence at store time and on read. The two tests the review named now expect the estimate with `ai_failed` and nothing stored. The review's probes are tests: (a) verbatim 74 / Good, reworded: estimate, nothing stored on the job; (b) verbatim 64 / Possible, reworded: estimate; (c) empty checklist: estimate for the test kit's posting, and 100 / Good / low confidence for a posting with nothing to judge. Refinement: a degree-only copy of a posting whose qualifications ask for a degree and nothing else is accepted (decision 4 of item 2). The review's wording would refuse it on every attempt. |
| 2 (medium) | A true short quote is treated as invented | **Done.** `verifiedIn` falls back to `shortQuoteIn`: a whole-token rule for Latin names and a two-character rule for scripts without spaces. The prompt asks for the phrase or the whole line. Tests: the review's cases ("Go" against "TypeScript, Go, PostgreSQL" met; against "Google Cloud" not; 本科 against "北京大学 本科" met and title_level not halved), plus "C#", "R", "AI", "C" against "C++", "R" against "R&D", one Han character, a two-character requirement line, and the same through `MatchService` and the resume strip. |
| 3 (medium) | Scorer gates over survivors only; no floor | **Done, stricter than asked on one point.** A pair with an unusable run counts as a flip, also when all three runs gave nothing (`tierFlipRate` alone would not count that case). ICC and Spearman read `no_fixture` under 90% measured or under 30 pairs; Spearman needs 30 graded pairs; under 30 usable pairs every row reads `no_fixture`. The share and the count are in the row's note. Because every unusable pair is a flip, a scorer that leaves more than 5% of pairs without an answer in some run fails `tier_flip_rate`, which is tighter than the "about 90%" of the review. Tests: a third of the pairs with one unusable run (the survivors alone give ICC 1; the command exits 1), all three runs unusable, 29 graded pairs, 8 pairs. |
| 4 (low) | `rewriteBlocked` on a stale row | **Done**: the same change as the undone carry-over entry above. |
| 5 (low) | Record and replay differ once the test repository stores lists | **Done.** `scoreOnce` passes `repo: { ...world.deps.repo, saveJobRequirements: undefined }`. Test: two personas on one posting in both orders on a storing repository: the store is never called, each prompt hash equals the one of the person scored alone, and a control with the store left on shows the second person is handed the first one's lines. |
| 6 (low) | `job.score` retries a refused answer five times | **Done.** `ScorerFailedError.kind` (`answer` / `call`); the worker throws `PermanentWorkError` for `answer`. An answer in which nothing could be scored now throws in `throw` mode too (it returned an estimate, so the item ended "done" with no row). Tests through the real `drain`: a refused checklist is dead after one attempt, one scorer call, one budget unit; an upstream 502 is retried; a usable answer is done. v3 parse errors stay retryable (temperature 0.1, class unchanged). |
| 7 (low) | After v4, v3, v4 the cron cannot re-queue and the stale picks hold the head of the list | **Done.** The walk stops when `min(allowance, budgetLeft)` items were really queued; a done item whose pair has no fresh row is put back with `onConflict: 'requeue'`. Tests on the platform's real `enqueue`: v4, v3, v4 and model A, B, A on one queue; a dead and a waiting item take no slot; a done item with a fresh row is untouched. |
| 8 (low) | The parser refuses a stored-list answer without kind or importance | **Done.** Both are optional at parse time (`null`), a present wrong value still throws; stored mode never reads them; a copied line without them is dropped and counts as missing. Tests: the review's probe (`[{ id: 'r1', status: 'met', evidence }]`) parses and scores in stored mode. |
| 9 (low) | Never-judged patterns remove real requirement lines | **Done.** Every pattern now needs wording about the applicant; a school-tier phrase needs a degree or graduate word (or a preference right after it); 民族, 党员, 户籍, 国籍 and 年龄 need 要求, 限, 不限, 优先 or a label. All ten lines of the review are in the "must not match" list, with 50 more; the earlier "known over-match" assertions (211 East Street, 民族品牌) are reversed. I went further than the ten lines where the same fault was plain: age of users, photo services, marital counselling, work-permit processing, "national accounts". |
| 10 (low) | Stray `.vitest/json/output.json` | **Done.** Deleted (`rm -rf .vitest`); not recreated by any later run (no JSON reporter was used). `git status --porcelain -uall` lists only owned paths. Request 9 asks the orchestrator to ignore the directory. |
| Unowned edits | `.vitest/json/output.json` | Removed, as above. No other unowned path was touched. |
