# MKT-4F

Feed: hybrid retrieval by reciprocal rank, the residual text as a ranking query, then the ranking refinements (SM-7, SM-9 feed part, SM-12). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4F`, branch `wp/MKT-4F`. Nothing committed. No statement here has run against PostgreSQL; no embeddings endpoint, model, provider or database was called by any test or by the harness.

This is the handoff after the independent review. The review's findings and what was done about each come first, then the complete updated handoff. Same text: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4F.md`.

State in one paragraph: seven of the eight items are done in full. Item 7 is done except for one line of its text that cannot be met from this bundle's files (the Ready weekly selection does not get the wrong-title weight, because it asks the feed for Best fit; Request 3). Two tests outside my owns are red and cannot be avoided (the harness tests that run every suite on disk; MKT-4E reports the same two, MKT-4G the first). Three things need the orchestrator before the M4 gate: confirm the changed typed-query contract (Request 1), add two lines to `feed/index.ts` (Request 2), and the two harness assertions (Request 4).

## Review resolution

Every finding was checked against the code before it was acted on. None was rejected as wrong.

**Item 6, judged not done ("a collapsed job remains reachable from the card").** Confirmed, and it failed in two ways, both fixed:
- A later window folded a posting into a card the client already held (finding 4, below).
- Found while writing the test for that: a role in more than eleven places put up to ten names on the card and folded the rest away with no name and no link. A card now holds at most ten other postings (`ALSO_IN_MAX`, moved to `rankingText.ts`); the next place of the role becomes a card of its own and takes the places after it (`ranking.ts` `collapseSameRole(items, taken, maxFolded)`). So `alsoIn.count` always equals the number of places named and linked. The published rule and the help-page sentence say "up to 10".
- The declared difference stays: `alsoIn.locations` names every linked place (up to 10), not the first 3. A link without a name could not be opened by name. The plan's contract row (`locations: string[]`) sets no limit.

1. **High. A typed query of two or more words stopped filtering.** Confirmed: `wideQPredicateSql` bound the OR of the tokens, so `q = "product manager"` kept every posting that says either word. Fixed as proposed. `feed/sql.ts` `allTokensTsQuery(q)` is the AND of retrieval `queryTokens(q)` (quoted like `toTsQuery`), and `wideQPredicateSql` binds it: `(j."searchTsv" @@ to_tsquery('simple', $all) OR qPredicateSql(q))`. The OR query (`toTsQuery`) is now only the lexical leg's own match and ORDER BY. A one-word query is unchanged, so every ACCEPT line of item 1 still holds. `testkit.ts` emulates both forms (`'a' & 'b'`: every token; `'a' | 'b'`: any). Tests: `sql.test.ts` (the AND value, the same tokens as the leg's query, every filtering statement binds it), `hybridSql.test.ts` (the filter binds the AND once, the leg's match and order bind the OR twice, the dense leg neither), `FeedQueryService.test.ts` "a typed query of two words keeps the postings that carry BOTH" (count, For you, the four sorts, sample, alert candidates, the Assistant's preview, the visitor list; 60 one-word rows that are newer and more numerous stay out). **The contract changed:** see Request 1.
2. **Medium. "Hiding N weaker fits" counted first-window rows twice.** Confirmed with the reviewer's scenario (20 instead of 10). Fixed: the rows of a hybrid first window that the fit-tier view hid and that lie at or below the refill boundary are kept on the session as rank entries flagged `h: true` (never in `jobIds`, never served, ignored by the same-role logic); `ensureFilled` adds them to the ids it skips. `contract.ts` `FeedSessionRanksSchema` documents the flag. Test: Great view, ten lexical-leg rows 50 days old that score Unlikely: `hiddenByTier` is 10 with and without the search documents, `totalEstimate` 15, ten `h` entries, and a hidden row above the boundary is not stored.
3. **Medium. Newest with a query text was not in date order.** Confirmed (o003 and o007 before o000). Fixed with the reviewer's second option, at the root: an explicit Newest is one recency statement, with or without a query text (`listPlan` replaces `usesHybrid`). The legs run for Recommended and Best fit, and for a list that is not personalised when the default order was asked for with a query text (`query_match`). Reason for this option over dropping rows below leg A's boundary: for a date-ordered list the legs could then add only dense rows that do not contain the typed words, at the price of two statements and an embedding call. This departs from item 2's "for newest only when a query text is present"; see "Where an item and a document differ". Web, same rule: `JobsWorkspace.tsx` sends `relevance` and shows the "Ranked by" strip only under Recommended and Best fit (`sortUsesRelevance`); the words are kept and apply again when the person returns to a ranked sort. Tests: `postedAt` never increases along the pages of a Newest session and equals the list without the text; a typed `q` under Newest lists exactly the postings that carry the word; no vector is asked for or read; the web test for Newest.
4. **Medium. A posting folded by a later window into a card already sent was unreachable.** Confirmed. Fixed as proposed: `ensureFilled` gets the page offset and `takenGroups` considers only cards at index >= offset (the page being built or later). A fresh posting whose role's card was already sent is a card of its own, and later places join that one. The sponsorship rule now holds in refills too: with "I need visa sponsorship", a posting that mentions it never joins an earlier card that does not (`TakenGroup.sponsors`); it becomes the role's card and the other places join it. Tests: the fold into an unsent card on the same page, the sent-card case (second card that names the other place), the same under Recommended with the legs, the sponsorship case, and one assertion used by all of them: every folded id is named in the `alsoIn` of a card on a delivered page and no job is listed twice.
5. **Medium. Seen and skipped counted scroll passes.** Confirmed (`useImpressions.ts` queues a card every time it leaves the screen). Fixed as proposed: `repo.recordImpressions(userId, jobIds, at, sessionStartedAt)` raises the counter only `WHERE "lastImpressionAt" IS NULL OR "lastImpressionAt" < sessionStartedAt`, and the stamp is never before the session's start, so a second batch of one session cannot count even when two clocks differ. Nothing else reads the counter (checked by search). The published sentence stays ("three or more visits"), and it now matches MATCH 4.11 ("on three sessions"). Tests: `repo.test.ts` (the statement and its four parameters, the stamp rule, the in-memory twin), `FeedQueryService.test.ts` (three batches of one session count once, the next session once more, a late batch of the first session nothing).
6. **Medium. The Ready weekly selection does not get the wrong-title weight.** Confirmed: `agent/service.ts` asks the feed seam for `sort: 'best_fit'` in both places (lines 527 and 632), and Best fit orders by fit alone. My earlier sentence was wrong and is corrected under item 7. The fix is outside my owns: Request 3. Where the weight does apply today: the feed's Recommended order, the Assistant's `search_jobs` in its default order, and the precompute pick (`match/cron.ts` asks for Recommended). Not: Best fit, the Assistant's `top_fit_jobs`, Ready.
7. **Medium. A plain-language search that changes no filter threw its ranking terms away.** Confirmed. Fixed: when the diff is empty or a no-op and the response has ranking terms, `Explore.tsx` keeps the "doesn't change your current search" message and adds a block with the "Ranked by closeness to" line (and the "Not checked" line), a button "Rank my list by these words" and Cancel. The button saves nothing and calls `rankListBy({ saved: false })`, which stores `version = baseVersion`, so the terms end at the next change of the search instead of surviving one. Tests: `explore.test.tsx` (the offer, no PATCH, the stored state, dismissal, GoApply's AI label), `feed.test.tsx` (the list sends the terms; version 4 ends them), `feedHooks.test.ts`.
8. **Low. The "last seen" part of freshness cannot change a score on real rows.** Confirmed by reading ingest: `upsert.ts` sets `lastSeenAt = now()` on every write and `resolvePostedAt` refuses a date more than one day after the fetch, so the hours since a job was last seen exceed its posting age by a day at most. Not changed: the reviewer names it an owner decision, the item prescribes the rule, its ACCEPT line and both sentences, and either way out (a new rule, or deleting published copy) is a product choice. `ranking.ts` now says in a comment what the rule does on real rows. It is Owner 1, with both options and the exact edits.
9. **Low. `relevance` was ignored whenever `q` is present.** Confirmed, and it also made the web strip untrue for a saved search that carries a `q`. The part inside my owns is done: `typedText` is the typed `q` and `relevance` together (only `q` is a predicate), and `FeedQueryService.previewOrdered(ctx, input)` answers `{ items, relevanceApplied }` exactly as MKT-4H's Request A specifies (`preview` returns its items). Tests include MKT-4H's own gate fixture (c_plain, b_plain, a_topical: `c, a, b` with the topics, `c, b, a` without). What is left is two lines in `feed/index.ts`: Request 2.
10. **Low. /help/ranking overstated the wrong-title effect.** Confirmed (one mark moves the factor by 0.25 / 3 or 0.5 / 4, not by 0.25). Both texts reworded to state the change of each weight and how the factor is built; `rankingText.test.ts` checks the two real deltas against `affinityScore`, `pages.test.tsx` checks the sentence and refuses the old one.
11. **Low. Two red tests outside the owns.** Unchanged and unavoidable; listed under "Red tests for other bundles" and Request 4, with the `exceptSubsets` change as Request 5.

**Unowned edits: none reverted.** I checked each path against the rules of this wave and against every M4 bundle's owns (no other bundle owns any of them). Each is covered by a rule or by the item's own TESTS line, so none is an unowned edit:
- `components/features/marketing/__tests__/pages.test.tsx`: item 5 says "the marketing page tests are run and any text assertion on the old sentence is updated". It is the test of the two marketing files I own. Assertions were replaced and extended, none weakened.
- `i18n/staging/jobs.zh.json`, `i18n/staging/landing.zh.json`: the i18n rule ("GoApply-only Chinese copy also goes to `i18n/staging/<namespace>.zh.json`" for a namespace you own). One key each, both shown only on GoApply.
- `server/src/features/feed/__snapshots__/sql.test.ts.snap`: the stored output of the owned `sql.test.ts`; item 1 says which entry changes. Two entries differ from the base (`q`, and the source header through the M3 carry-over).
- `server/src/features/match/eval/suites/retrieval.suite.test.ts`: the unit test item 4 asks for, next to the owned suite.
- The handoff file: the HANDOFF rule.

If the orchestrator rules otherwise, each is one `git checkout -- <path>` (or one deleted file) in the worktree; the tests of that file then fail on the old sentences, the old rule counts or the old predicate, and belong under "Red tests for other bundles".

## Items

### 1. [P0] Three retrieval legs as SQL builders: done

- New `server/src/features/feed/hybridSql.ts`: `legPredicates`, `recencyLegSql` (leg A: `retrievalSql` itself), `lexicalLegSql(input, tsQuery)`, `denseLegSql(input, vectorLiteral, modelTag)`. The three statements share one block of scope and filter predicates (filter fields minus `q`) and differ only in the order clause, the `JOIN "RAJobEmbedding"` of the dense leg and the q rule (legs A and B add the wide predicate, leg C does not). Legs B and C take the list's age floor (`ageFloorSql`), not the 14-day window. The lexical query and the vector are bound parameters.
- `feed/sql.ts`: `wideQPredicateSql(q)` = `(j."searchTsv" @@ to_tsquery('simple', $all) OR qPredicateSql(q))`. `$all` is `allTokensTsQuery(q)`: the AND of the query's tokens, so a typed query filters on every word (review finding 1). `isShortLatinQuery` (under three characters, none of them Chinese, Japanese or Korean) and a query with no token use the narrow predicate alone. `predicateFor` case `q` returns it, so the list, counts, samples, alert candidates and the source header carry the same predicate.
- The OR of the tokens (`toTsQuery`) is leg B's own `@@` and its ORDER BY, nothing else.
- Tests: `hybridSql.test.ts` (14: inline snapshots for an empty set, a full RoboApply set and a GoApply set; identical shared block across the legs; the q rule, also for two words; the short-query rule; parameters; age floor), `sql.test.ts` (78).
- Snapshot file: two entries changed, `q` and the source header (the second because of the age-floor carry-over below). Every other snapshot is byte-identical.

### 2. [P0] Fusion by reciprocal rank in the feed; consent; never an error when a leg is missing: done, with one stated difference (Newest)

- `feed/ranking.ts` `fuseByReciprocalRank(legs, { k, cap, newer })`: score Σ 1 / (60 + rank), then newest, then id; cut at 400.
- `feed/FeedQueryService.ts` `retrieveHybrid`: legs A, B, C run together (`Promise.all`), 200 rows each. `listPlan` decides: Recommended and Best fit of a personalised list; and a list that is not personalised when the default order was asked for with a query text. Newest, Deadline, Highest pay, browse lists, counts, limiting filters, samples, alert candidates and the visitor list keep one statement.
- Query text of B and C: what the user wrote, the typed `q` and `relevance` together; with neither, for a personalised list, B takes `profileQueryText` (the most recent title, the names of the roles the record shows, eight skills; `toTsQuery` keeps 24 tokens) and C the stored user vector (`userVector` under `currentModelTag`).
- Query vector: `embedTexts(brand, [text], { purpose: 'query', carriesUserData: true })`, cached in process 10 minutes per (brand, model tag, text), waited for at most `FEED_QUERY_EMBED_TIMEOUT_MS` (800). No client, no key, `{ unavailable }`, a thrown error, a zero vector or a slow call all mean "no dense leg"; a call that outlives the wait fills the cache for the next request. Nothing above `info` is logged for an unavailable client. The dense leg joins on the vector's own model tag, so vectors of two models are never compared.
- A lexical or dense statement that throws is logged (`warn`) and left out. The recency leg failing fails the request, as before.
- Refill: later windows are recency-keyed below leg A's boundary and skip every job the session has already judged: its cards, the postings folded into them and the first-window rows the tier view hid (finding 2). When the 400 cut drops rows of leg A (always its oldest, which no other leg returned), the boundary moves up to the last row before the first dropped one, so a later window reads them again.
- `retrievalRank` on the candidate breaks ties under every sort: sort key, then date, then fused position, then id.
- Consent (GoApply): without 个性化推荐 no profile text, no user vector, no query vector, no fit. With a query text and the default order the list is legs A and B in fused order, `order: 'query_match'`; with none, or when asked for by date, it is one statement by date. A query vector is asked for only when `aiAllowed(userId)` holds.
- `FEED_HYBRID=off`: leg A alone with the old 400-row window.
- `feed/defaultService.ts`: `defaultFeedEmbeddings`, `defaultFeedRetrieval` (lazy imports), wired into `defaultFeedDeps`.
- Web: `JobsWorkspace.tsx` prints `jobs.order.queryMatch` where the by-date line is printed, from the response's `order`.
- Tests: `FeedQueryService.test.ts` (121), `personalization.cn.test.ts` (14, through the real router and the real consent rule), `seams.test.ts` (31), `defaultService.test.ts` (7), `ranking.test.ts` (53).

Decisions beyond the item text:

1. **GoApply reads a stored user vector only with both consents** (个性化推荐 and "Use AI"). The item requires the AI consent for an embedding call only. The vector is the output of a model call made under the AI consent, so the read is gated the same way.
2. **A list asked for by date is by date.** See review finding 3.
3. **Cards of a `query_match` list carry no "Why this job" line.** The only non-personalised headline says "Sorted by date posted and your filters", which would be false. See Request 8.
4. `FeedQueryResponse.sort` is `newest` for a `query_match` list (its later windows are by date).

### 3. [P0] The residual text ranks the list and is labelled as ranking, on both brands: done

- Server: `relevance` is part of the query text of legs B and C and is never a predicate. `preview` honours it, and `previewOrdered` says whether it took part (finding 9). `nlQuery.explanation` is "Ranked by closeness to: {terms}." then "Not checked as requirements: {phrases}." (`uncheckedPhrases` leaves out a phrase a ranking term was taken from).
- Web: `Explore.tsx` prints two lines from `rankedBy` and `unmatched` (`jobs.nl.rankedBy`, `jobs.nl.notChecked`; GoApply keeps its AI label on each). On Apply, `rankListBy` (`hooks/feed/useExplore.ts`) hands the terms to the list; `useListRelevance` gives them to `/jobs`; `useFeed` sends them as `relevance` with every page and keys the list by them; `JobsWorkspace.tsx` shows "Ranked by: {terms}" with Clear under Recommended and Best fit.
- A request that changes no filter but leaves terms offers to rank the list by them without saving anything (finding 7).
- The terms last until the search changes (any later version, or another search) or the person clears them. They live in memory for the visit.
- Tests: `FeedQueryService.test.ts` (order changes, predicates and count do not, GoApply flow, `q` and `relevance` together), `explore.test.tsx` (21), `feed.test.tsx` (49), `hooks/feed/feedHooks.test.ts` (17).

### 4. [P1] Retrieval suite: done

- New `server/src/features/match/eval/suites/retrieval.suite.ts`. It builds the feed's own statements with the feed's builders, runs them on `FakeFeedRepo` (the in-memory twin), and fuses with `fuseByReciprocalRank`, all loaded by path. Corpus: the synthetic postings of a market with no filter. Metrics: `recall_at_200_recency`, `recall_at_200_hybrid` (gated, reference handed over), `recall_at_200_worst_persona_delta`, per language subset in the language layer (printed, not gated), career changers apart.
- Vectors: `fixtures/retrieval/vectors.<market>.json` when it covers every text as it is now; otherwise proxy vectors (a hashed bag of tokens), and then the rows carry `status: 'no_fixture'` with the note "proxy vectors" and are not held against the gate.
- Live mode records the vectors (synthetic texts only, `carriesUserData: false`) and times the first-window statements read-only (`feed_p95_ms`, scope `live`). Offline the latency row says `skipped_offline`.
- Proxy run on the committed fixtures, unchanged by the review fixes (the suite has no typed query): intl 0.619 recency, 0.992 fused, worst persona +0.111; cn 0.833, 1.000, worst 0.000.
- Tests: `suites/retrieval.suite.test.ts` (28): the in-memory legs and the SQL builders agree on which fixture rows match a query; the fusion is the feed's function; proxy against recorded; live mode with fakes.
- `npm run eval:match -- --enforce M2` exits 0. `--enforce M4` in this worktree fails on INV-7 only (MKT-4E's).

A finding from writing that test: a stored `searchDoc` is not its own segmentation. `segmentForSearch(doc)` on an already segmented document adds tokens (a long Chinese word yields its bigrams again). PostgreSQL indexes the stored tokens. The in-memory twin therefore reads a document by splitting on white space, never by segmenting it again. Nothing in production segments a stored document twice today; the test pins the rule.

### 5. [P1] Freshness with a slow tail: done as specified; the last-seen rule has no real effect (Owner 1)

- `ranking.ts` `freshness`: 100 × (0.7 × e^(−h/48) + 0.3 × e^(−h/336)); with `lastSeenAt` older than 48 hours, the larger of the posting age and the hours since last seen. Values: 100, 51.76, 15.16, 1.72 at 0, 48, 240, 960 hours.
- `FEED_LIMITS.freshnessHalfLifeHours` is deleted; `FRESHNESS_CURVE` gains `staleAfterHours: 48`.
- Published text in `rankingText.ts`, the mirror comment in `catalog.ts`, `landing.ranking.freshness.body` staged.
- Tests: `ranking.test.ts`, `rankingText.test.ts` (9), `pages.test.tsx` (54).
- The item's ACCEPT line "posted yesterday and last seen 20 days ago scores as 20 days old" holds in the test and cannot happen on a row ingest wrote (review finding 8).

### 6. [P1] The same role in several cities collapses into one card: done

- `ranking.ts` `collapseSameRole`, `sameRoleKey`, `placeOf`; applied in `rankRows` after the tier view and the sort, before the company scatter. The session lists cards; a card's entry in `RAFeedSession.ranks` carries `g` (its group) and `also` (the folded ids). `totalEstimate` is cards plus what the tier view hid. `items()` sets `alsoIn` after `toFeedItem`.
- Web: new `AlsoInLocations.tsx`, rendered by `FeedList.tsx` under the card. Each place opens its own job page (the split view on a wide screen).
- `ORDERING_RULES` gains `same_role_collapse`; the help page prints `landing.ranking.sameRole` under Variety.
- Tests: `ranking.test.ts`, `FeedQueryService.test.ts` (11 in this block), `feed.test.tsx`, `repo.test.ts` (24).

Where this differs from the item:

1. **A posting is folded only when it names a place the card and the postings already folded do not.** A second posting for the same city, or one with no place, stays a card. Otherwise "Also in 2 more locations" could count one city twice. `count` is therefore the number of other places.
2. **`alsoIn.locations` has one name per job id, up to 10, not 3.** The control must name every link it offers.
3. **A card holds at most ten other postings.** The eleventh other place is a card of its own, so nothing is folded away where no card names it.
4. **A later window folds only into a card the session has not sent yet.** A role whose card is already on a delivered page gets a second card for its later places.
5. With "I need visa sponsorship" a posting that mentions it is the card and is never folded into one that does not, inside a window and across windows.

### 7. [P1] "Wrong title" as a title-level negative; seen and skipped; canonical skill keys: done, except the Ready weekly selection

- `affinity.ts`: `AffinityState.title`, event `wrong_title` (−0.25 on the role id and the title key; company and skills untouched), decay and pruning as the other maps. A title weight joins the score only when negative, and never raises a score that is already low (`min` with the mean of three). `affinityKeys` uses the first three `skillIds` when the job has them.
- `repo.ts`: `titleWeights` read and written (a missing or malformed value is an empty map), `impressionStates`, `ActionJob.titleNormalized` and `skillIds`, `recordImpressions` once per job and feed session.
- `FeedQueryService.hide`: `wrong_title` bumps affinity and still returns the filter proposal. Only for personalised users.
- Seen and skipped: 5 / 7.5 / 10 points off the Recommended rank at 3 / 4 / 5+ impressions with `viewedAt` null (`SEEN_SKIPPED`). An impression is one visit (one feed session), however often the card scrolls past.
- Both rules are in `ORDERING_RULES`, the catalog mirror and the help page with their numbers. The wrong-title text states the change of each weight (0.25) and how the factor is built from the weights; it no longer says the factor moves by 0.25. The exploration slot is not built and not mentioned.
- **Where the weight applies (corrected).** `agent/deps.ts` `feedPreview` does call `feedService.preview`, but the Ready weekly selection and its suggestions ask for `sort: 'best_fit'`, which orders by fit alone. So Ready does NOT get the weight. It applies in the feed's Recommended order, the Assistant's `search_jobs` (default order) and the precompute pick. Request 3.
- Tests: `affinity.test.ts` (15), `ranking.test.ts`, `rankingText.test.ts`, `FeedQueryService.test.ts`, `repo.test.ts`.

### 8. [P2] A thin saved search queues one targeted ingest: done

- `FeedQueryService.query`: when the first window of a saved search as saved (no browse, no cursor, no one-off override, no typed `q`) holds fewer than 60 rows, `requestIngest(profileId)` is called in the background, once per (profile id, version) in 6 hours. A failure is logged and never fails the feed. Default wiring: `ingestForProfile(id, 0)`.
- Tests: `FeedQueryService.test.ts` (6), `defaultService.test.ts`.

### Carry-over

| Entry | Result |
|---|---|
| M1 MKT-4F.1 (live recall variants in `eval/live/snapshot.ts`) | Left: the file has no owner. Request 6. |
| M1 MKT-4F.2 (career changers) | Reported apart in the retrieval suite, not gated. This suite measures recall, not the feed order, so it adds no order gate. |
| M1 MKT-4F.3 (latency suite) | Built inside the retrieval suite (live only). No fixture baseline changed. |
| M2 MKT-4F.1 | Done, every point (`toTsQuery` null, `vectorLiteral`, personalisation asked first, `purpose: 'query'`, the constant deleted). |
| M2 MKT-4F.2 (thin dense leg during a model change) | Done: a short or empty dense leg is not an error. |
| M2 MKT-4F.3 (sweep scan; per-row "refused" marker) | Left: `features/retrieval/` is not mine and the feed needs no marker. No schema request from this bundle. |
| M2 MKT-4F.4, .5 | Nothing to do (4); done (5: a zero vector is never a query). |
| M3 MKT-4F.1 (age floor) | Done in `sql.ts`: `AGE_FLOOR_BOARDS` = `AGE_EXPIRY_BOARDS` + `user_import` + `tw_open_data`; every other source passes at any age. The `sourceLine.ts` half is Request 7. |
| M3 MKT-4F.2 (`SqlScope.heldBoards`) | Kept, untouched. |

### Where an item and a document differ

- **Typed-query predicate.** Item 1 builds `$q` with `toTsQuery` (the OR). Built as the AND of the same tokens (review finding 1). The strategy asks for the OR only as the lexical leg's ranked query (SM-7), which it still is; the plan's contract row gives the SQL shape, which is unchanged. Request 1.
- **Newest.** Item 2 runs the legs "for newest only when a query text is present". Not built for an explicit Newest (review finding 3). Strategy 2.5 "Consent" (legs A and B with the typed query for a list that is not personalised) is met through `query_match`.
- **`q` and `relevance`.** Items 2 and 3 use `relevance` "when no q is typed". Built as both together (review finding 9; MKT-4H's Request A). Strategy 2.3 step 8 says only that the residual text becomes the lexical and dense query.
- **Freshness.** The research note (MATCH 4.11) says "the smaller of posting age and days since last seen"; the item says the larger, and its acceptance line and the published sentence need the larger. Built as the item says. Neither has a real effect (Owner 1).
- **Leg B without a query.** The research note (MATCH 4.9) has leg B ask for "target titles"; the item says the titles of the recent roles. Built as the item says.
- **Seen and skipped.** MATCH 4.11 says "shown in the first screen on three sessions". Built: any impression of the card (it left the screen), once per session. The first-screen condition is not applied.
- **Ready.** Item 7 and MATCH 4.11 want the wrong-title weight in the Ready weekly selection. Not met (Request 3).
- Item 1 says "nothing else in `sql.ts` changes"; the M3 carry-over changes `ageFloorSql` there. The carry-over is binding, so both are in.

## Files changed

New:
- `server/src/features/feed/hybridSql.ts`, `hybridSql.test.ts`
- `server/src/features/match/eval/suites/retrieval.suite.ts`, `retrieval.suite.test.ts`
- `server/src/features/match/eval/fixtures/retrieval/README.md`
- `components/features/feed/AlsoInLocations.tsx`

Changed:
- `server/src/features/feed/`: `FeedQueryService.ts`, `sql.ts`, `ranking.ts`, `rankingText.ts`, `affinity.ts`, `repo.ts`, `defaultService.ts`, `contract.ts`, `types.ts` (comment), `testkit.ts`, and the tests `FeedQueryService`, `sql`, `ranking`, `rankingText`, `affinity`, `repo`, `defaultService`, `seams`, `personalization.cn`, plus `__snapshots__/sql.test.ts.snap`
- `components/features/feed/`: `Explore.tsx`, `JobsWorkspace.tsx`, `FeedList.tsx`, `explore.test.tsx`, `feed.test.tsx`
- `hooks/feed/`: `useExplore.ts`, `useFeed.ts`, `keys.ts`, `index.ts`, `feedHooks.test.ts`
- `components/features/marketing/`: `catalog.ts`, `CompanyPages.tsx`, `__tests__/pages.test.tsx`
- `i18n/staging/`: `jobs.en.json`, `landing.en.json`, `jobs.zh.json`, `landing.zh.json`

The same set of files as before the review; the review changed no file outside it. No `*.prisma`, no `i18n/messages`, no new dependency, no CSS file (the new blocks use existing classes of `feed.module.css`).

## Tests run

All in the worktree, after the last edit.

| Command | Result |
|---|---|
| `npx vitest run --exclude ".claude/**"` (run twice) | 731 files: 730 passed, 1 failed. 18,541 tests: 18,528 passed, 2 failed, 1 skipped, 10 todo. The 2 are the red tests below. |
| Files I wrote or touched and their neighbours (feed server, eval suite test, feed web, feed hooks, marketing) | 33 files, 862 tests: 861 passed, 1 skipped |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| Server test files of the feed and the suite test, type-checked with a temporary tsconfig outside the repository (the server tsconfig leaves tests out) | exit 0 |
| `npm run check` | exit 0, all six checks green |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npm run eval:match -- --suite retrieval` | exit 0 (numbers under item 4) |
| `npm run eval:match -- --enforce M4` | exit 1, on INV-7 only (MKT-4E's) |

Base was 729 files and 18,343 tests: +2 files, +198 tests.

## Red tests for other bundles

Both in `server/src/features/match/eval/run.test.ts` (no owner in M4: orchestrator). MKT-4E lists the same two, MKT-4G the first.

1. `suite discovery > the shipped suites are taxonomy, ranking and language`: any new suite file breaks the exact list. After the merge it should be `['language', 'ranking', 'retrieval', 'scorer', 'skills', 'taxonomy']`.
2. `the shipped suites > ranking and language are not_built while the fit seam is missing`: it runs every suite except taxonomy and expects `not_built` from each. The retrieval suite does not read the fit seam and measures. The filter should name the two suites the test is about: `.filter((f) => /(ranking|language)\.suite\./.test(f))`.

## Pre-existing failures

None. Both full runs of this session show only the two red tests above. (Before the review, one of three full runs had six timeouts while sibling bundles ran on the same machine; none came back.)

## Requests

**Orchestrator**

1. **Confirm the typed-query contract before the M4 gate, and update its row.** `MARKET_TASK_PLAN.md`, section 3.3, row "Typed-query predicate", shape: `wideQPredicateSql(q)` in `feed/sql.ts`: `(j."searchTsv" @@ to_tsquery('simple', $all) OR qPredicateSql(q))`, where `$all` is `allTokensTsQuery(q)`, the AND of retrieval `queryTokens(q)`: a typed query filters on every word. The narrow predicate alone under 3 Latin characters or with no token. `predicateFor` case `q` returns it. The OR of the tokens (`toTsQuery`) is the lexical leg's own match and ORDER BY only. Also add a two-word case to the post-M4 check "the feed count and the list agree for a typed query" (Request 9).
2. **`server/src/features/feed/index.ts` (no owner): offer the ordered preview on the facade.** Needed for MKT-4H's item 2 (GoApply's planned search names an order only when the feed says so). The service half is built and tested.
   ```ts
   // interface FeedService
   /** As `preview`, and whether `input.relevance` took part in the order of the rows returned. */
   previewOrdered(userId: string, input: FeedPreviewInput): Promise<{ items: FeedItem[]; relevanceApplied: boolean }>;
   // feedService
   previewOrdered: (userId, input) => defaultFeedQueryService.previewOrdered(ctxFor(userId), input),
   ```
   `relevanceApplied` is true only for a hybrid list whose lexical or dense leg was asked with the text and returned rows. For a personalised list that means "took part" (candidates and ties), which is what MKT-4H's API text says. For a list that is not personalised the fused order is the list's order.
3. **`server/src/features/agent/service.ts` (no owner in M4; MKT-5C in M5): the Ready weekly selection.** Lines 527 and 632 call `deps.feedPreview(..., { sort: 'best_fit' })`. For the wrong-title weight to reach Ready (item 7, MATCH 4.11), either ask for `sort: 'recommended'` there, or have the feed seam expose the person's negative role and title weights so Ready can demote those jobs next to its own `applyDislikes`. Until then /help/ranking describes the list, not Ready.
4. `eval/run.test.ts`: the two assertions above.
5. `eval/gates.ts`: add `exceptSubsets: [CAREER_CHANGER_SUBSET]` to the two retrieval gates, before vectors are recorded. Until then the suite prints the career changers' fused recall under its own metric id (`recall_at_200_fused`), because the hybrid gate reads every subset of `recall_at_200_hybrid`.
6. `eval/live/snapshot.ts` `RETRIEVAL_VARIANTS` (no owner): add lexical, dense and fused variants so the live pool is not recency-only. The builders are `feed/hybridSql.ts`; the persona query is `personaQueryOf` and the persona vectors are `fixtures/retrieval/vectors.<market>.json`, both in `suites/retrieval.suite.ts`. Also `eval/README.md`: list the retrieval suite; say that a live run writes `fixtures/retrieval/vectors.<market>.json` (the one file a live run writes outside `.snapshots/`); describe the proxy rule and the latency baseline (Owner 3).
7. `feed/sourceLine.ts`: delete `NO_AGE_FLOOR_BOARDS` (nothing reads it now) and the test "the read side exempts exactly the boards …" in `sourceLine.test.ts`; `sql.test.ts` already compares `AGE_FLOOR_BOARDS` with `AGE_EXPIRY_BOARDS`. Then MKT-5C can delete `NO_DATE_EXPIRY_BOARDS` in `ingest/maintain.ts`. Also `feed/index.ts` and `feed/routes.ts`: the header comments still say `relevance` "changes the order from phase M4". It does now.
8. `features/compliance/explainMatch.ts` and `legal.explain.headline.*`: a third non-personalised headline for a list ordered by its search words, so the cards of a `query_match` list can carry a line again.
9. The post-M4 check "the feed count and the list agree for a typed query": under Newest, Highest pay and Deadline they agree exactly. Under Recommended and Best fit they agree on every job that matches the words; with a query vector the list can hold more, because the dense leg does not apply `q` (item 1's rule). A two-word case: `q = "product manager"` must list and count only postings that carry both words.
10. i18n: `landing.ranking.freshness.body`, `pointsNote`, `pointsNoteRules` and `cnNote` are changed English; the other locales keep the old sentence until the merge.
11. Optional, for the M5 owner of `FeedQueryService.ts` and `contract.ts` (MKT-5C) with `lib/api/contracts/feed.ts`: put `relevanceApplied` on the first page of `POST /feed/query` too, so the "Ranked by" strip can be hidden when no posting matched the words (Known gap 4).

**MKT-4H.** Your Request A: step 1 (`typedText` is `q` and `relevance` together), the service half of step 2 (`previewOrdered` on `createFeedQueryService`, `Window.relevanceApplied`, kept across the top-up) and step 3 (a test with your three rows) are in `FeedQueryService.ts`. The facade half is Request 2 above. Your gate test reads the service directly, so its second branch runs as soon as the two bundles are merged; with your fixture the order is `c_plain, a_topical, b_plain` and `relevanceApplied` is true.

**MKT-5C** (owns `FeedQueryService.ts`, `items.ts`, `contract.ts` and `agent/service.ts` in M5): `alsoIn` is set in `FeedQueryService.items` after `toFeedItem`; move it into `ItemContext` if you prefer. `publicList` does not collapse. `listPlan` is the one place that decides which lists run the legs. Rank entries flagged `h` are not cards. Request 3 is in your file.

**MKT-5F** (owns `sql.ts` in M5): `wideQPredicateSql` now needs every word; `allTokensTsQuery`, `isShortLatinQuery` and `AGE_FLOOR_BOARDS` are there to build on.

**MKT-5H**: the two env variables below go into `.env.example` and `deploy/cn/cn.env.example`.

**Owner**

1. **Freshness and "last seen" (review finding 8).** The rule as specified has no effect on real rows, and two published sentences name an effect ("counts from when it was last seen", "counts as older"). Choose one:
   - Give it an effect: in `ranking.ts` `freshness`, a row unseen for more than 48 hours counts its posting age plus the hours since it was last seen; reword both sentences to that.
   - Remove it: delete the `lastSeenAt` branch and `FRESHNESS_CURVE.staleAfterHours`, the clause after the semicolon in `RANKING_FACTORS` freshness, the same clause in the `catalog.ts` comment, the last sentence of `landing.ranking.freshness.body`, and the three test assertions (`ranking.test.ts` last-seen case, `rankingText.test.ts` frozen text, `pages.test.tsx` sentence).
2. Record the vectors once an embedding key is in place: `EVAL_LIVE=1 npm run eval:match -- --live`, then commit `fixtures/retrieval/vectors.intl.json` and `vectors.cn.json` (about 2 MB each). From then on the retrieval gate is evaluated. On the mainland fixtures (246 postings) the newest 200 already hold 83% of the relevant ones, so the gate needs a fused recall of 0.98 or more there.
3. Latency baseline: `FEED_HYBRID=off EVAL_LIVE=1 npm run eval:match -- --live --write-baseline` once (that is "today"), then a normal live run is held against it plus 150 ms.
4. "Ranked by closeness to: …" names an effect that is candidate selection plus tie-breaking (the design of MATCH 4.9). On a search that matches fewer than 200 postings the visible order changes only between otherwise equal postings. Say if the words should weigh more.
5. Confirm or overrule: a GoApply stored vector is read only with both consents; a list asked for by date never runs the legs; `q` and the ranking words are one query text; a card names at most ten other places and a role can have a second card; an impression is one visit.
6. The exploration slot is not built (it waits for you).
7. `RAJobUserState.impressions` in the dev database was counted per batch until now, so some jobs carry more "visits" than they had. If that matters before launch, the counter can be reset by you or the orchestrator (no statement was run by me).

## Schema requests

None. `RAUserAffinity.titleWeights`, `RAJob.searchTsv`, `RAJobEmbedding`, `RAUserEmbedding` and `RAJobUserState.lastImpressionAt` exist. The `h` flag lives in the `RAFeedSession.ranks` JSON.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `FEED_HYBRID` | `off` returns every list to the recency leg alone (one statement, 400 rows). Any other value is on. | on |
| `FEED_QUERY_EMBED_TIMEOUT_MS` | How long a request waits for the vector of a query text before it runs without the dense leg. | 800 |

## i18n keys added or changed

`i18n/staging/jobs.en.json`:
- new: `jobs.card.alsoIn`, `jobs.card.alsoInList`, `jobs.card.alsoInMore`, `jobs.order.queryMatch`, `jobs.nl.rankedBy`, `jobs.nl.notChecked`, `jobs.nl.rankOnlyTitle`, `jobs.nl.rankOnlyApply`, `jobs.nl.chip`, `jobs.nl.chipClear`, `jobs.nl.chipClearLabel`

`i18n/staging/landing.en.json` (only `landing.ranking.*`):
- new: `upToPointsLower`, `rules.wrongTitle.title`, `rules.wrongTitle.body`, `rules.seenSkipped.title`, `rules.seenSkipped.body`, `sameRole`
- changed: `freshness.body`, `pointsNote`, `pointsNoteRules`, `cnNote`

GoApply-only Chinese: `jobs.order.queryMatch` in `jobs.zh.json`, `landing.ranking.cnNote` in `landing.zh.json`.

Notes on the item's prescribed strings: `jobs.order.queryMatch` ends with a full stop (it is the intro sentence of the page). `landing.ranking.sameRole` adds "up to 10. Any further locations appear as another card." to the item's sentence. `rules.wrongTitle.body` is the reworded text of review finding 10. `jobs.card.alsoInMore` is kept for a response whose count is larger than its list; this server never sends one.

## Known gaps

1. **No SQL here has run against PostgreSQL.** `ts_rank_cd` with a `to_tsquery('simple', …)` of quoted tokens, the `&` form of the typed-query predicate, the `<=> $n::halfvec(1024)` order and the `ON CONFLICT … DO UPDATE … WHERE` of the impressions are tested as text and parameters and on the in-memory twin. They first run on the Neon branch.
2. **The UI was not looked at in a browser** (rule of this wave). The also-in control, the "Ranked by" strip and the new block in Explore use only existing classes and tokens; both brands, both themes and 375 px need an eye.
3. Under Recommended and Best fit, with a query vector, the list of a typed `q` can hold jobs that do not contain the words (Request 9).
4. The "Ranked by" strip is shown under Recommended and Best fit whenever words are stored, also when no posting matched them (no search documents yet, or `FEED_HYBRID=off`). The preview seam reports this; the list response does not (Request 11).
5. The words a list is ranked by are kept in memory: a reload shows the plain order.
6. Two places are "the same" when their text is the same apart from case and spacing: "Austin, TX" and "Austin, Texas" count as two.
7. A role can have two cards in one session: when its first card was already sent before a later window brought another place, or past ten other places.
8. With no search document and no vector in the index (before the backfill) the first window of Recommended and Best fit is 200 rows, not 400; later windows follow as before.
9. A lexical or dense statement that fails (a database without the vector extension) logs a warning on every request.
10. Impressions: with two lists open at once, a job shown in the older one after the newer one has shown it is not counted (an undercount, never an overcount). Counters written before this change were per batch (Owner 7).
11. The thin-search memory and the query-vector cache are per process.
12. The live half of the retrieval suite (recording, timing) has only run with fakes.
13. Before the review, one ad-hoc timing script (in the scratchpad, not in the repository) imported the feed modules with `tsx` outside the test runner. The server's own start-up code then loaded the worktree's `.env` and wrote one info line. The script ran in-memory code only: no query, no network call, no value printed. It was stopped and not repeated; nothing of the kind was run in this session.
