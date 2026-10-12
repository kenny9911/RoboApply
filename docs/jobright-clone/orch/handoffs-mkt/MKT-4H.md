# MKT-4H

Search surfaces outside the feed (SM-9): planner relevance terms, the job-search API on both brands, Assistant job tools with cited ids, and the job-list card. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4H`, branch `wp/MKT-4H`. Nothing committed. Every edit is inside the bundle's owns. This is the handoff after the independent review: the review's findings and what was done about each come first, then the complete updated handoff. This text is also at `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4H.md`.

## Review resolution

All five findings were checked against the code and are real. None is rejected. Four are fixed in this bundle; two of those also need a change outside my owns, which is a Request (A and 1). The review found no unowned edit and none was made, so nothing was reverted.

1. **High, and item 2 judged not done: GoApply's planned search named an order the feed never applies.** Confirmed. `index-provider.ts` declared `ranksByRelevance: true` and `service.ts` set `meta.rankedBy` from that flag alone, while the feed reads `relevance` only when no `q` is typed (MKT-4F `FeedQueryService.ts` `typedText`: `filters.q?.trim() || relevance || null`; MKT-4F's handoff says the same) and this provider always sends `q`. Fixed in this bundle:
   - **No claim from a capability.** `SearchProvider.ranksByRelevance` is now `readsRelevance` (the source is handed the text) and a source answers `OrderedProviderJobs { jobs, rankedByRelevance }`. `service.ts` names an order only when every source that returned rows said, for this search, that the text took part in its order. A plain array never claims. A result with no rows claims nothing.
   - **The index passes on the feed's own word.** `index-provider.ts` `orderedPreview(feed, reader, input)` reads the feed through `previewOrdered` when the feed offers it and through `preview` otherwise. Only an explicit `relevanceApplied: true` counts; a feed that answers rows only is taken as "not applied". So until the feed reports it, GoApply answers `rankedBy: []` and lists the topics in `unverifiedPreferences`, exactly as RoboApply does.
   - **Wording.** `openapi.ts`: "the closest postings first", "The index orders by them" and "order each query's results and are returned in agent.rankedBy" are gone. `rankedBy` is now "topics ... that were used to order the results", "one input to the order, beside others such as how recent a posting is, so a result need not mention them", and it is empty "when nothing was found, and whenever a source that returned results did not order by the topics". A test refuses the old sentences on both brands.
   - **The gate test the review asked for.** `server/src/job-search/index-feed.gate.test.ts` runs the planned search over the real `createFeedQueryService` on the feed's own `FakeFeedRepo` (market cn, three equally recent rows, one of which mentions the topics), not over a fake preview. It asserts in every world that the API returns the feed's rows in the feed's order and that the claim equals the feed's own report; when the feed reports an applied order the topical row must precede the row it would otherwise follow; otherwise the topics must be in `unverifiedPreferences`.
   - **What I could not do:** the feed half (the text of legs B and C is `q` and `relevance` together, and `previewOrdered` reports the applied order) is in `FeedQueryService.ts` (MKT-4F) and `feed/index.ts` (no owner). It is **Request A**, with the exact change. Until it lands, item 2's first ACCEPT line is not met end to end and nothing false is said. When it lands, nothing in this bundle needs an edit: the provider picks the report up and the gate test's second branch becomes live.
2. **Medium: a job list returned after a `show_jobs` call was dropped with no card and no log.** Confirmed. Fixed in `CopilotService.ts`: the hold is per citation. A citation settles the lists returned so far (`heldLists.length = 0`); a list returned after the last citation is still held and is shown whole when the turn ends. The log `jobs_not_cited` now carries `afterCitation` and `uncitable` (lists returned in the last tool round, which no `show_jobs` call could follow). In addition a list tool that runs in the last tool round (`ToolContext.lastToolRound`, set by the service) no longer tells the model "Nothing is shown to the user yet. Call show_jobs": it says the whole list is shown as it is. Tests: the reviewer's sequence (`top_fit_jobs`, `show_jobs`, `search_jobs`, text) gives the cited card and then the later list, with the log; two citations in one turn give two cited cards and no log; a list in the last tool round of a turn that cited nothing is logged with `uncitable: 1`; the earlier test "a second, narrower search and one citation" is unchanged and green.
3. **Medium: the cited card printed "Pay not listed" for a similar job whose post states pay in words.** Confirmed (my earlier "no change is needed here" was wrong). Fixed: `cards/model.ts` `JobListRow.payText` (text only; null when the row's contract field says the post states no pay, `salary: null`), and `JobListCard.tsx` prints the words through `marketPayWords` (the rule `SimilarJobs.tsx` uses, so GoApply never prints 面议) as "Pay as stated: {text}", and "Pay not listed" only when the post states none. New string `assistant.cards.jobList.payAsStated`. The model side reads the same rule (`tools/util.ts` `payForModel`), so the answer and the card under it agree. Tests: three new cases in `JobListCard.test.tsx` (the server's `similar_jobs` and `show_jobs` over the area fakes, both brands, the parser) and new assertions in the similar-jobs pay test of `tools.test.ts`.
4. **Medium: `similar_jobs` still answers a title search until Request 1 is applied.** Confirmed, and it cannot be fixed inside my owns: the list is reachable only through `jobDetailService`, whose public surface (`features/jobs/detail/index.ts`, no owner in M4) does not offer `similar`, and `boundary.test.ts` forbids going around it. Done here: the service test is renamed so it no longer says "not a title search" (it tests the turn: the chip names the tool, the tool is asked, the cited jobs are the card), the tool test's comment and title say which read answers which list, and the pay fix of finding 3 is already in, so the gate has only Request 1 to apply and three things to delete. The model is still told which list it got (`by: 'title'`, `basis`).
5. **Low: `/feed/nl-query` lost a requirement the planner filed under `relevanceTerms`.** Confirmed with the reviewer's probe. Fixed at the root inside my owns instead of the proposed edit to `feed/filterDiff.ts` (no owner): `parseAgentPlan` is the one function both readers of a plan go through (the search API and the feed's `defaultPlanner`), so it now enforces the prompt's rule. A relevance term that states a requirement (the feed's own `isConstraintPhrase`) is moved to `unverifiedPreferences`, where the feed already turns it into the filter it names (pay floor, sponsorship) or shows it as not checked, and the API discloses it. The probe is a test: `planToFilters(parseAgentPlan({ queries: ['backend engineer'], relevanceTerms: ['visa sponsorship', 'equity'], unverifiedPreferences: [] }), …, 'intl')` now sets `needsSponsorship: true`, leaves `unmatched: ['equity']`, and equals the answer for the same phrases under `unverifiedPreferences`. The per-caller version of the rule in `agent.ts` (`splitRelevanceTerms`, the `conditionRule` dependency) is deleted: one rule in one place.

## Items

### 1. [P0] The planner returns relevance terms; unsupported constraints stay visible as unchecked: done

- `job-search/agent.ts` `PLANNER_PROMPT`: the schema gains `"relevanceTerms":["topic to rank results by"]` and one paragraph: up to 5 short topical phrases (industry, product area, technology, mission), 2 to 60 characters, no URL, never a condition on pay, visa or work authorization, benefits, hours, time zone, commute or company size (those stay in `unverifiedPreferences`). "Never claim these facts were checked" stays, and the terms get their own "never claim they were checked". The sentence that forced "industry" into `unverifiedPreferences` now reads "any other preference that is neither enforced by the schema nor placed in relevanceTerms".
- `job-search/agent-validation.ts`: `relevanceTerms` is in the allowed set and is the one lenient part of the plan. Not an array, a non-string, under 2 or over 60 characters, a control character, a URL (`http(s)://`, `//`, `www.`) or a repeat in another letter case is dropped; at most 5 topics are kept in the planner's order; a term that would push the joined text past 240 characters is dropped. Never fatal. The key is left off when no topic remains, so existing plans parse to exactly what they did. The roleless sentinel `{"queries":[],"unverifiedPreferences":[]}` still answers "name a role" when `relevanceTerms` sits beside it.
- **The prompt's rule is enforced by the parser** (review finding 5): `splitRelevanceTerms(raw, isCondition)` tells topics from requirement phrases with the feed's `isConstraintPhrase` (injectable as the second argument of `parseAgentPlan`). A requirement is looked for among all usable terms, before the cap of 5, so one named ninth is not lost and none uses up a topic's place. It is appended to `unverifiedPreferences` unless the planner stated it there already (whatever the letter case); at most 12 are moved (`RELEVANCE_MOVED_MAX`). A bad value (URL, control character, wrong length) is still dropped, never moved.
- Constants `RELEVANCE_MAX_TERMS` 5, `RELEVANCE_TERM_MIN_CHARS` 2, `RELEVANCE_TERM_MAX_CHARS` 60, `RELEVANCE_MAX_CHARS` 240 are twins of the feed's (`RANKED_BY_MAX_TERMS`, `RANKED_BY_MAX_CHARS`, `FEED_RELEVANCE_MAX_CHARS`); a test holds them equal.
- The feed needs no change: `feed/defaultService.ts` `defaultPlanner` is `parseAgentPlan(raw) as PlannerPlan`, so `POST /feed/nl-query` answers the planner's topics in `rankedBy` and handles a misfiled requirement like any other preference (tested through `planToFilters(parseAgentPlan(...))`, both markets).
- Both brands use the same planner. The gate (`createPlannerGate`: GoApply phone binding, `aiAllowed`, `ai.text`) is untouched and still runs before any reservation or model call.
- Tests: `job-search/agent-validation.test.ts` (new, 20): the acceptance plan (`queries ["backend engineer"]`, `remote true`, `relevanceTerms ["climate startups","Rust"]`, pay phrase in `unverifiedPreferences`), 9 terms cut to 5, URL / control character / length / non-string dropped with the plan kept, de-duplication, the joined-length rule, the twin constants, other fields still strict, requirement phrases moved (order, once each, before the cap, the cap of 12, the replaceable rule, words that are also topics stay topics), the feed path with the reviewer's probe. `agent.test.ts`: the prompt test.

### 2. [P0] The job-search API reads our index through the same retrieval pipeline: this bundle's half is done; the first ACCEPT line waits for Request A

- `job-search/index-provider.ts` (the GoApply index provider; the item says `service.ts`, PAR-8 put it in its own file) passes the request's query as `q` and the topics as `relevance` to the feed's preview seam. No ranking code exists in job-search: rows are handed on in the feed's order (`normalizeJob`, `matchesFilters`, `deduplicateJobs` and the slice keep order).
- **The order is the feed's to state, per read** (review finding 1). `orderedPreview` reads `feedService.previewOrdered` when the feed offers it, else `feedService.preview`; only `relevanceApplied: true` counts. The provider answers `{ jobs, rankedByRelevance }`.
- `job-search/service.ts`: `SearchOptions.rankBy` (the topics), `SearchProvider.readsRelevance`, `OrderedProviderJobs`. Only a source that declares `readsRelevance` is handed `opts.relevance`; a RapidAPI provider never sees the text. `meta.rankedBy` is present only when the caller asked for an order and every source that returned rows said it applied it. The cache key includes the topics only when a selected source can read them, so two RoboApply planned searches of one query are still one paid provider call.
- `job-search/agent.ts`: the planned search passes `rankBy` on every query and the response gains `agent.rankedBy` beside `agent.unverifiedPreferences`. It names the topics only when every query that found rows was ordered by them; otherwise it is `[]` and the topics are appended to `unverifiedPreferences`, so no wish of the request goes unseen.
- `job-search/openapi.ts` (version 1.3.0): `agent.rankedBy` is documented and required on both brands with the sentence "Ranking terms are not verified facts about a job", in the wording of review finding 1, plus one brand sentence each.
- **Where the item and the documents disagree (documents win, D3 and MATCH 4.10 point 4):** the item says `agent.rankedBy = the terms`. Reporting the terms for a list that was not ordered by them would state an order that never happened. So `agent.rankedBy` is the terms only when the order was applied. RoboApply's results are "provider results in provider order", so there it is always `[]` and its response is unchanged except for the added field (ACCEPT line 2). On GoApply it is `[]` until the feed applies and reports the order (Request A). Say if you want the literal reading.
- **State of the ACCEPT lines.** Line 1 ("a fixture row that mentions the terms precedes an equally recent one that does not", on a GoApply host): no outbound provider call is met and tested; the order is NOT met end to end, because with a typed `q` the feed does not read `relevance` (MKT-4F's rule as built). It needs Request A. Line 2 (RoboApply unchanged except `rankedBy`) and line 3 (the OpenAPI document validates) are met.
- Tests: `service.test.ts` (50; the MKT-4H block has 11: `q` and `relevance` sent and the feed's order kept, the three reports of a feed (applied, not applied, rows only), the report read strictly, keyword search shape unchanged, cache per order, failed index, no rows, RoboApply never handed the text and cache not split, a capable source that answers rows only, mixed sources), `agent.test.ts` (65: `rankedBy` on both brands, a feed that does not report, real service on both brands, requirement terms, 9 terms and a URL, two queries with one not ordered and with one empty, nothing found, failure), `routes.test.ts` (33: `/search` shape and request contract unchanged, `/agent/search` pass-through on 200 and 503, the documented field and its honest wording on both brands, an OpenAPI validation that resolves every `$ref`, checks every `required` name and fits a real `SearchResult` and `AgentSearchResult` to the schemas), `index-feed.gate.test.ts` (new, 5: the planned search over the real feed service, and `orderedPreview`).

### 3. [P0] Assistant job tools: imports included, fits from getFits, the card shows exactly the cited jobs: done (the Similar jobs list itself waits for Request 1)

- **Fits.** New `CopilotAreas.fits(userId, jobIds, { locale })`: one `getFits` batch call (never a model call), behind the feed's own rule (`isFeedPersonalized`: on GoApply no fit is read or shown without a live 个性化推荐 grant, as the Ready list and Similar jobs do). `addedRows` reads all ids in one call instead of one `storedFit` chain per job. Rows carry the feed card's fit fields including `confidence` and `confidenceReason`.
- **top_fit_jobs** merges `areas.addedJobs` (up to 50) with the feed's best-fit preview, orders all rows by the fit (score, then AI before estimate at one score, ties in the order they came, rows with no fit last: `orderByFit`) and returns at most the limit. An added job already in the preview is not listed twice; an added job with no fit is not a best fit.
- **show_jobs({ jobIds: 1..8, note? })**: accepts only ids in `allowedJobIds` (the registry check reads `jobIds` as well as `jobId`; a refusal is whole and logged as `copilot_guard_hit` kind `unknown_job_id`). Rows come from the turn's own lists (`ToolContext.listedJobs`, filled by `CopilotService`), no new query. The rows of job lists in the recent answers are seeded too, so "shown in the recent cards" works; such a row has its fit read again (one `fits` call) so the card never shows a fit from then as the fit now. An allowed id that is in no list (the job in context, a job only read with `get_job`) answers `job_not_listed` and tells the model to list first. The card is `job_list` with `cited: true`, exactly those jobs in that order, and the optional `note` (160 characters). The service checks the note with the reply's own guard (submission claim, number without a source, unknown job link); a note that fails is left off the card and logged.
- **Held lists, per citation, and the fallback** (review finding 2). `search_jobs`, `top_fit_jobs`, `added_jobs` and `similar_jobs` mark their output `list: 'candidates'`; the service emits no card for them when they return. `show_jobs` marks `list: 'cited'`: its card is emitted and the lists held so far are settled. A list no `show_jobs` call followed (none in the turn, or none after the last citation) is emitted whole when the turn ends, and `copilot_guard_hit` kind `jobs_not_cited` is logged with `lists`, `jobs`, `afterCitation` and `uncitable` (not logged when the turn was stopped or failed: the list is still shown). A list tool in the last tool round tells the model the list is shown whole (`ToolContext.lastToolRound`).
- **Implementation note on "stop emitting the card themselves":** the list tools still hand the service their whole list as a card object under the `candidates` flag. That object is the fallback card and the store of rows, so no card-building code exists twice, and `components/features/copilot/__tests__/wireCards.ts` (no owner in M4) keeps producing its `job_list` wire card from `topFitJobs`. No SSE `card` event comes from a search when it returns.
- **Prompt.** Line 35 is replaced with the item's sentence for signed-in turns (`CITED_JOBS_RULE`). Visitor turns keep the whole-list rule (`WHOLE_LIST_RULE`) and their card, as the item says.
- **similar_jobs({ jobId })** and the quick action. The chip hint is "call similar_jobs for the job in context, then show_jobs". **The item is wrong on one fact:** `jobDetailService.similar` is not on job detail's public surface (`features/jobs/detail/index.ts` offers `get`, `recordApplyClick`, `undoApplied`; `boundary.test.ts` forbids importing `defaultService.ts`), and the item also says the job-detail area is not edited. `areas.similarJobs` therefore calls `similar` when the surface has it and otherwise falls back to what the quick action did before, a search by the job's title through the feed, named as such to the model (`by: 'title'`, `basis`). Request 1 adds the three lines; `areas.ts` picks them up with no edit.
- **Pay on a list row** (review finding 3): the model reads figures, else the post's words, else "not listed", and "not listed" whenever the row's contract field says the post states no pay (`salary: null`). The card reads the same rule.
- **Open-data credit line** (M3 carry-over 1): done with item 4. `creditablePreview` and its test are deleted; rows keep their `cardMeta`.
- `contract.ts`: `JobListCardData`, `JOB_LIST_NOTE_MAX`, `JOB_LIST_MAX`, tool names `show_jobs` and `similar_jobs`.
- Tests: `tools.test.ts` (66: show_jobs acceptance, order, refusals, arguments, two lists, earlier rows; top_fit_jobs with imports; `orderByFit`; similar_jobs tool and production adapter with both of its sources; the last-round note; `areas.fits` is one `getFits` call and equals the job page's read; no grant, no read; no list tool reaches `areas.fit`), `service.test.ts` (48: card held back until cited, fallback and log, refused citation, narrower second search, a list after a citation, two citations, a list in the last tool round, note guard, added jobs, a job from a recent answer, a broken reply, the Similar jobs quick action, the prompt rules), `guard.test.ts` unchanged and green (80).

### 4. [P1] Assistant job-list card on the web renders the cited list: done

- `cards/model.ts` `parseJobList`: `cited` (only `true`), `note` (only on a cited list, at most 160 characters), per row `confidence`, `confidenceReason`, `addedByUser` (also for a feed row whose `source.kind` is `user_import`), `attribution` (text and a safe link from `cardMeta.tw_sources.attribution`) and `payText`.
- `cards/JobListCard.tsx`: a cited card is titled "Jobs mentioned in this answer" (`assistant.jobList.title`), shows the note above the list, the rows in the payload's order, the fit chip with the feed card's fields ("Quick estimate" for an estimate, and the one plain reason when its confidence is low, through the feed card's own `lowConfidenceReason`), "Added by you", pay in figures or in the post's own words ("Pay as stated: …", by the market's rule), and the 台灣就業通 credit line linked to the licence text. A card without `cited` (the fallback, a visitor's search, a stored older card) keeps the existing title "Jobs". The card never had "N results" wording; a test refuses any count that implies completeness.
- `cards/jobList.module.css` (new): two classes for the credit line, tokens only.
- Tests: `cards/JobListCard.test.tsx` (new, 14): real tools and `show_jobs` over the server fakes; order, labels, fallback title, note, fit chip, credit line, pay in words on both brands, both brands, parser strictness. The un-owned `__tests__/cards.test.tsx` stays green (121).

### Carry-over

- `waveM1-carryover.md`: no MKT-4H section.
- `waveM2-carryover.md` MKT-4H.1 (adapter names): kept; `fits` and `similarJobs` added beside them. `storedFit` is no longer called by a tool; it stays because the harness seam `assistant_stored_fit` reads it (Request 3).
- MKT-4H.2 (the planner does not emit `relevanceTerms`): done in item 1.
- MKT-4H.2a (`estimate` on cards): kept; the cited card passes it.
- MKT-4H.3 (`RACrossBankSearchService` reads `RAJobMatchScore` directly): none of this bundle's surfaces shows its number. The job-search API carries no fit; the Assistant reads `getFit` / `getFits` only.
- `waveM3-carryover.md` MKT-4H.1 (OGDL credit line on Assistant cards): done.
- MKT-4H.2 (LinkedIn dead code): `isLinkedInJob`, `isLinkedInUrl`, `sourceCounts`, `LINKEDIN_CAPABLE`, `offersLinkedIn` and the `agent.linkedinOnly` filter branch are removed with their three tests. The contract keeps the field: `linkedinOnly: true` is still a 400 before any reservation or model call, a wish in words is still disclosed, the response still carries `linkedinOnly: false`. The three rules of `normalization.ts` are untouched. Indeed-only rows are left as they are (Owner 22 is not answered).

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4H/`:

- `server/src/job-search/agent.ts`, `agent-validation.ts`, `service.ts`, `index-provider.ts`, `types.ts`, `openapi.ts`
- `server/src/job-search/agent.test.ts`, `service.test.ts`, `routes.test.ts`, `agent-validation.test.ts` (new), `index-feed.gate.test.ts` (new)
- `server/src/features/copilot/CopilotService.ts`, `areas.ts`, `contract.ts`, `prompt.ts`, `types.ts`, `tools/jobs.ts`, `tools/registry.ts`, `tools/util.ts`
- `server/src/features/copilot/__tests__/areaFakes.ts`, `tools.test.ts`, `service.test.ts`
- `components/features/copilot/cards/JobListCard.tsx`, `model.ts`, `jobList.module.css` (new), `JobListCard.test.tsx` (new)
- `i18n/staging/assistant.en.json`

`git status` shows 23 modified and 4 new files, none outside the owns.

## Tests run

| Command | Result |
|---|---|
| `npx vitest run --exclude ".claude/**" server/src/job-search/` | 12 files, 222 passed |
| `npx vitest run --exclude ".claude/**" server/src/features/copilot/` | 7 files, 248 passed |
| `npx vitest run --exclude ".claude/**" components/features/copilot/` | 5 files, 208 passed |
| per file | `agent-validation.test.ts` 20, `agent.test.ts` 65, `service.test.ts` (job-search) 50, `routes.test.ts` 33, `index-provider.test.ts` 11, `index-feed.gate.test.ts` 5, `tools.test.ts` 66, `service.test.ts` (copilot) 48, `guard.test.ts` 80, `JobListCard.test.tsx` 14, `cards.test.tsx` 121 |
| `npm run typecheck:server` | clean (exit 0) |
| `npx next typegen && npm run typecheck:web` | clean (exit 0) |
| `npm run check` | all six checks clean (exit 0) |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` (whole suite) | 732 files, 18,431 passed, 1 skipped, 10 todo, 0 failed |

Also run for information: `npm run eval:match -- --enforce M4` on this branch alone exits 1 for INV-7 only (MKT-4E's invariant); nothing in its output concerns this bundle.

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

**A. Orchestrator at the M4 gate: the feed applies `relevance` beside a typed `q`, and says so.** Needed for item 2's first ACCEPT line. Files: `server/src/features/feed/FeedQueryService.ts` and its test (MKT-4F in M4; its handoff leaves this to the gate), `server/src/features/feed/index.ts` (no owner).

Why: MKT-4F's `typedText` is `filters.q?.trim() || relevance || null`, so a read that carries both ignores `relevance`. The in-app search never meets this (the planner's role goes into the `titles` filter and no `q` is sent); the API's planned search always does (the role query is `q`, as item 2 says).

1. The text of legs B and C is both. `q` stays the only predicate.
   ```ts
   /** What the user wrote: the typed query and the text to rank by, together. Only `q` is ever a predicate. */
   function typedText(filters: FilterSet, relevance: string | null): string | null {
     return [filters.q?.trim(), relevance].filter(Boolean).join(' ') || null;
   }
   ```
2. Report the applied order.
   ```ts
   // interface Window
   /** Hybrid retrieval only: the request's `relevance` was part of the query text of a leg (B or C) that returned rows. */
   relevanceApplied?: boolean;
   // retrieveHybrid, after `const [a, b, c] = await Promise.all(...)`; add it to both return statements
   const relevanceApplied = !!h.relevance && (b.length > 0 || c.length > 0);
   // topRanked: return `relevanceApplied: w.relevanceApplied === true` (keep it across the top-up, which spreads `...whole`)
   async function previewOrdered(ctx: FeedCtx, input: FeedPreviewInput): Promise<{ items: FeedItem[]; relevanceApplied: boolean }> { /* the body of preview */ }
   // preview = (await previewOrdered(ctx, input)).items; add `previewOrdered` to the returned service object

   // features/feed/index.ts, interface FeedService
   /** As `preview`, and whether `input.relevance` took part in the order of the rows returned. */
   previewOrdered(userId: string, input: FeedPreviewInput): Promise<{ items: FeedItem[]; relevanceApplied: boolean }>;
   // feedService
   previewOrdered: (userId, input) => defaultFeedQueryService.previewOrdered(ctxFor(userId), input),
   ```
   `relevanceApplied` is false with no relevance text, with `FEED_HYBRID=off`, for a list that is not hybrid, and when neither leg returned a row. For a personalised reader the fused position only breaks ties (MKT-4F): `true` then means "took part", which is what the API text says ("one input to the order"). If the owner wants the claim only where the fused order is the list's order, return `relevanceApplied && fused`.
3. A `FeedQueryService.test.ts` case for `preview({ q, relevance })`. Use three equally recent rows, not two: with reciprocal rank fusion (k = 60) two rows that both match `q` tie exactly (1/61 + 1/62 either way) and the id decides. With rows c, b, a (the recency leg's order) where only `a` mentions the relevance terms, the lexical leg gives a, c, b and the fused order is c, a, b: `a` precedes `b`, which it follows without the terms. `index-feed.gate.test.ts` uses that fixture (`searchDocs` are set when the testkit has them).

Nothing in MKT-4H needs an edit afterwards: `orderedPreview` reads `previewOrdered`, GoApply's `agent.rankedBy` then names the topics, and the gate test runs its second branch. That branch has not run anywhere yet (see Known gaps 2).

1. **Orchestrator, `server/src/features/jobs/detail/index.ts`** (no owner in M4): offer the Similar jobs list on the public surface, so `similar_jobs` reads the job page's own list instead of the title-search stand-in.
   ```ts
   import type { ApplyClickResponse, JobDetailResponse, SimilarJobsResponse, UndoAppliedResponse } from './contract.js';
   // in interface JobDetailService:
   /** The job page's Similar jobs list (GET /jobs/:id/similar): by job vector, best fit first. */
   similar(userId: string, jobId: string): Promise<SimilarJobsResponse>;
   // in jobDetailService:
   async similar(userId, jobId) {
     return (await impl()).similar(userId, jobId);
   },
   ```
   `copilot/areas.ts` `similarJobs` picks it up with no edit. Afterwards the `by: 'title'` branch, the `?` on `JobDetailSeam.similar` and `SIMILAR_BY_TITLE_ROWS` can be deleted (and the second half of the adapter test in `tools.test.ts`). The card already prints a similar job's pay in words.
2. **Orchestrator, `components/features/copilot/MessageList.tsx`** (no owner in M4): add `'similar_jobs'` and `'show_jobs'` to `TOOL_KEYS`. The strings are staged (`assistant.tools.similar_jobs`, `assistant.tools.show_jobs`). Until then both show "Working…".
3. **Orchestrator or MKT-4E, `server/src/features/match/eval/seamRegistry.ts`** (no owner in M4): `readAssistantStoredFit` should read what the Assistant's lists read now, `areas.fits(userId, [jobId], { locale: 'en' })` with `personalized: async () => true` passed to `createDefaultAreas`. Then `CopilotAreas.storedFit` can be deleted (`types.ts`, `areas.ts`, `areaFakes.ts`, three assertions in `tools.test.ts`). Until then a test holds `fits` equal to `storedFit`.
4. **Orchestrator, `server/src/features/feed/sourceLine.ts`**: the comment on `creditLineHeld` still lists "the Assistant's job lists (copilot/tools/jobs.ts)" among the surfaces that hold a row out, and "the Assistant cards with MKT-4H.1" among the removals to come. Both are done; `itemOwesCreditLine` is now used by `agent/deps.ts` only.
5. **Orchestrator, optional, `server/src/features/feed/index.ts`**: `export { isConstraintPhrase } from './filterDiff.js'`, then `job-search/agent-validation.ts` can import it from the index. Today it imports `features/feed/filterDiff.js` directly and statically (job-search is outside `features/`; the feed already imports the planner files directly; no import cycle, checked). Also optional: `filterDiff.ts` `rankedByOf` no longer needs to filter the planner's own terms with `isConstraintPhrase` (the parser has done it); it is harmless as it is.
6. **Orchestrator, optional, `components/features/copilot/__tests__/wireCards.ts`**: also produce a cited card (`showJobs` after `topFitJobs`, with `listedJobs` on the context). The colocated `cards/JobListCard.test.tsx` covers that shape today.
7. **MKT-5H (documents):** `ARCHITECTURE.md` 5.2 tool list gains `show_jobs` and `similar_jobs`; the job-search API notes gain `agent.rankedBy` (named only when the source says the order was applied) and the rule that a requirement is never a relevance term.
8. **Owner:** Owner 22a (Indeed-only rows on the job-search API) is still open; nothing was changed for it.

## Schema requests

None.

## Env variables added or redefined

None.

## i18n keys added or changed

`i18n/staging/assistant.en.json` (English only; brand-neutral, so no `assistant.zh.json` entry):

- `assistant.jobList.title`: "Jobs mentioned in this answer"
- `assistant.cards.jobList.payAsStated`: "Pay as stated: {text}" (new in the review pass)
- `assistant.tools.similar_jobs`: "Looking for similar jobs…" (used once Request 2 is applied)
- `assistant.tools.show_jobs`: "Putting the list together…" (used once Request 2 is applied)

Read, not added: `fit.confidence.reason.*` and `fit.quickEstimateWhy.no_resume` (the feed card's strings), `assistant.cards.jobList.*`.

## Known gaps

1. Until Request 1 is applied, `similar_jobs` answers the title search through the feed, not the job page's vector list. The model is told which one it got.
2. Until Request A is applied, GoApply's planned search never names an order: the topics are sent to the feed, the feed does not read them beside `q`, and the response lists them as not applied. That is honest and it is not what item 2 asks for. The gate test's second branch (the feed reports an applied order) is written against MKT-4F's worktree code as I read it and the arithmetic in Request A.3; it could not be run here. If it fails at the gate after Request A, either the report is true while the order is not (the case it exists to catch) or the fixture needs the adjustment that message names.
3. "Never name a job you did not pass to show_jobs" is a prompt rule. The text is not checked against the card. What is logged: a turn that ends with a list no citation followed (`jobs_not_cited`, with `afterCitation` and `uncitable`). No real model was run, so how often a model cites is unmeasured: watch that log kind after release.
4. A cited answer needs one more model round (search, show_jobs, text: 3 of `MAX_ROUNDS` 4). A list returned in the third round cannot be cited: it is shown whole, and the model is told so.
5. Two planned queries are each ordered by the topics and then concatenated, as before; they are not fused into one order (that would be ranking code in job-search).
6. A requirement phrase moved out of `relevanceTerms` shares the existing cap of the API's disclosed list (the request's own clauses, then the planner's preferences, then the moved ones, cut at 12). Topics nobody ordered by are appended after the cap and never cut.
7. `get_job` still tells the model the post's own pay words on GoApply when they only say 面议 (unchanged; the job page prints "Pay not listed" for it). List rows follow the contract's `salary: null` since this pass.
8. The visitor's job-list card cannot print a credit line (`PublicFeedItem` has no `cardMeta`). It matters only if an operator adds `tw_open_data` to `PUBLIC_DISPLAY_PROVIDERS`; not changed here.
9. `JobListCard.tsx` imports `lowConfidenceReason` from `components/features/match/FitScore` (MKT-4E owns that folder in M4), as `feed/JobCard.tsx` does. A rename there breaks the web typecheck at merge.
10. UI was verified by tests only (both brands, the parser, order, labels, pay). No browser was run, per the rules; the card uses the shared copilot classes plus two token-only classes, so light, dark, 375px and 1280px follow the existing card.
11. `top_fit_jobs` orders its rows by the displayed fit as the item says, so within its at most 8 rows the feed's sponsorship-first and company-spread order is not kept. The set of feed rows is still the feed's top rows.
12. Server test files are not type-checked by any gate (`server/tsconfig.json` excludes them). I checked the two new job-search test files with a temporary config (removed again): no type error of their own.

Two things done outside the worktree, both read-only in effect: to verify finding 1, I ran `git status`, `grep` and `sed` on files of `wp-MKT-4F` (twice from a shell that had changed into that directory; nothing there was written). And one probe was started with the shared scratchpad as vitest's root by mistake: it ran test files left there by earlier work (they failed at setup, as they have no project around them) and wrote a vitest cache folder, which I removed.
