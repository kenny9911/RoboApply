# FIX-3 handoff (after review)

All 15 original findings and all 8 review findings are fixed in `/Users/kenny/code/RoboApply/.claude/worktrees/wp-FIX-3` (branch `wp/FIX-3`); nothing is committed. All gates are green, with one flaky-test hazard that needs a one-line change outside my owns (first Request). Nothing was checked in a browser, so the CSS changes at 375px and in dark mode are unverified.

## Review resolution

1. **[high] Drawer comboboxes 320px tall: fixed.** The width rule moved off the shared `.combo` onto a new `.searchCombo` class that only `SearchTypeahead` carries. Test in `FilterBar.test.tsx`.
2. **[medium] Everyday words counted as technologies: fixed.**
   - A name that is also an ordinary word (rest, excel, swift, react, oracle, sketch, shell, lambda, aurora, ruby, perl, bash, go and similar) now shows a broader skill only from the skill list, never from a sentence.
   - Unmistakable forms ("REST API", "Oracle Database", "React.js", "AWS Lambda", "shell scripts") still count from text.
   - A one-character term ("C", "R") counts only from the skill list.
   - `termParts` no longer splits inside "C++" or "A+", and splits on 和/及 only when each side has two or more characters.
   - The reviewer's probe sentences are tests in `terms.test.ts`.
   - Side effect: "api design" on the report resume is now shown via "REST API" instead of "REST".
3. **[medium] Rewrite re-scores the job: fixed on both sides.**
   - Server (`MatchService.scoreJob`): a rewrite keeps the stored score, components, keywords and scored date, and saves only the new summary, strengths, gaps and locale.
   - Over the daily cap, or when the model fails, it returns the stored AI fit still flagged, never a quick estimate.
   - Client (`useRewriteFitText`): any answer that is not an AI fit in the asked language fails the mutation, so the "couldn't rewrite" message shows and the cached fit stays.
   - Tests: two new cases in `MatchService.test.ts`, new `hooks/match/useJobFit.test.tsx`.
4. **[low] Composite taxonomy names in people search: fixed.** `searchRole` uses the taxonomy name only when it names one role; otherwise the cleaned title head ("Barista"). Test in `detail.test.ts`.
5. **[low] Stopwords remove real terms: fixed, differently from the suggestion.**
   - Removing the words outright would bring back "remote" and "benefits" as keywords, so there are now two tiers.
   - Hiring boilerplate is still dropped everywhere.
   - Words such as paid, growth, office, identity, benefits, lead, build, deep and vision are never a keyword alone but are kept inside a repeated pair with the word truly next to them ("paid search", "Microsoft Office", "deep learning", "compensation and benefits").
   - "net", "law" and "laws" are plain words again.
   - On a score tie the pair now sorts before its single word, so "microsoft office" covers "microsoft".
   - Tests in `keywords.test.ts`, including the reviewer's sentence and a repeated equal-opportunity statement.
6. **[low] Tracker page and server zones differ: fixed for the CSV, server-ready for the weekly card.**
   - `GET /export.csv?tz=<IANA>` prefers a valid browser zone over the stored one.
   - The toolbar link now sends it, via `withTimeZone` in `components/features/tracker/shared.ts`.
   - `core.weeklyFacts(userId, weekStart, tz?)` takes the same override; the insights route does not pass it yet (see Requests).
   - Tests in `routes.test.ts`, `service.test.ts`, `tracker.test.tsx`.
7. **[low] Card deadline shows a passed date: fixed.** `statedCloseAt(tags, now)` returns the earliest date on or after today in China, and the latest past date only when all have passed. Test in `card.test.ts`.
8. **[low] `displayTerm` upper-cases ordinary words: fixed.** An everyday word inside a phrase is re-spelled only when the phrase also names another technology ("html, css and less" becomes "HTML, CSS and LESS"; "less supervision" stays "Less supervision"). Tests in `terms.test.ts`.

Unowned edits: none, nothing to revert.

## Per-finding result (original 15)

1. **[HIGH] Country-only location as "same city": fixed.** A country with no city now filters on `locationCountry` (server and client), shown as one "Anywhere in United States" chip. Tests: `feed/sql.test.ts`, `FilterBar.test.tsx`, `feed.test.tsx`, `filterModel.test.ts`.
2. **[HIGH] Quick-estimate fit not honest: fixed.**
   - Seniority now comes from the resume.
   - There is no score when neither role nor skills could be compared.
   - The score is capped when only part was compared.
   - `preScoreMany` overlays the stored AI score, so every list shows one number.
   - Tests: `preScore.test.ts`, `MatchService.test.ts`, `detail.test.ts`.
3. **[MEDIUM] Second filter change dropped on 409: fixed.** Writes are queued per profile and rebased; a field-level patch is retried once on a 409. Tests: `useApplyFilters.test.tsx`, `FilterBar.test.tsx`.
4. **[MEDIUM] Absurd or non-pay text shown as pay: fixed.** `payPlausible` and `statesAmount` apply on write and on read. Tests: `salary.test.ts`, `items.test.ts`, `ranking.test.ts`, `detail.test.ts`.
5. **[MEDIUM] Tracker dates are UTC: fixed.** The page uses the reader's zone; the server uses the browser zone when sent, else the stored one (review item 6). Tests: `tracker.test.tsx`, `facts.test.ts`, `service.test.ts`, `routes.test.ts`.
6. **[MEDIUM] Keyword check is literal: fixed, except "eventsaday".** Equivalents, de-duplication and display spelling live in `match/terms.ts`, tightened by review items 2 and 8. I believe "eventsaday" is a resume-parse artefact outside this group. Tests: `terms.test.ts`, `inputs.test.ts`, `keywords.test.ts`, `match.test.tsx`.
7. **[MEDIUM] Explore "Design" lists software architects: fixed for new classification.** Stored rows keep old ids (see Requests). Test: `taxonomy/match.test.ts`.
8. **[MEDIUM] "Needs sponsorship" shown for a No: fixed.** Test: `FilterBar.test.tsx`.
9. **[MEDIUM] GoApply currency, visa wording, salary format: fixed.** Tests: `tracker.test.tsx`, `match.test.tsx`, `preScore.test.ts`, `card.test.ts`.
10. **[LOW] Alert does not list its jobs: fixed.** Test: `notifications.test.tsx`.
11. **[LOW] Job-function chips and stale-language fit text: fixed, pending translation of 230 role names.** The rewrite button now keeps the score (review item 3). Tests: `filterModel.test.ts`, `FilterBar.test.tsx`, `match.test.tsx`, `useJobFit.test.tsx`.
12. **[LOW] Enrichment ERROR per job: fixed.** A missing system user is logged once and skipped for an hour. Test: `repository.test.ts`.
13. **[LOW] People search uses the raw title: fixed.** Refined by review item 4. Test: `detail.test.ts`.
14. **[LOW] GoApply import details: fixed.** This covers the deadline (refined by review item 7), fraud quotes, the 12 s import wait, punctuation, the undo header and Greenhouse titles. "Duplicated meta lines" was not changed: the repeated lines are the pasted text itself. Tests: `card.test.ts`, cn `keywords.test.ts`, `extract.test.ts`, `JobImport.test.tsx`, `job.test.tsx`, `normalizeProviderJob.test.ts`.
15. **[LOW] Jobs and tracker polish: fixed.** The search-box width is now scoped correctly (review item 1).

## Files changed since the previous handoff

- **Server:**
  - `match/`: `terms.ts`, `preScore.ts`, `MatchService.ts`
  - `jobs/detail/view.ts`, `jobs/enrich/keywords.ts`
  - `tracker/`: `service.ts`, `routes.ts`
  - `cn/jobs/card.ts`
- **Web:**
  - `components/features/filters/`: `filters.module.css`, `SearchTypeahead.tsx`
  - `components/features/tracker/`: `shared.ts`, `ApplicationsToolbar.tsx`
  - `hooks/match/`: `useJobFit.ts`, `index.ts`
- **Tests:**
  - New: `hooks/match/useJobFit.test.tsx`
  - Extended: `terms.test.ts`, `MatchService.test.ts`, `detail.test.ts`, `enrich/keywords.test.ts`, `tracker/routes.test.ts`, `tracker/service.test.ts`, `cn/jobs/__tests__/card.test.ts`, `FilterBar.test.tsx`, `tracker.test.tsx`

Everything listed in the previous handoff is still changed.

## Tests run

- `npx vitest run --exclude ".claude/**"`: 587 files, 12,029 passed, 1 skipped, 10 todo on the final run.
- Two earlier full runs failed on one test only, `__tests__/lib/i18nStaging.test.ts` ("every string still in staging renders…"), which timed out at 6.3 s and 8.2 s against the 5 s limit while machine load was above 40. It passes alone in about 4.5 s.
- `npm run typecheck:server`: clean.
- `npx next typegen && npm run typecheck:web`: clean.
- `npm run check`: all six checks clean.
- Tracker, cn/jobs, match and filters suites (32 files, 665 tests) pass under `TZ=UTC`, `America/Los_Angeles` and `Pacific/Kiritimati`.
- Not re-run this session: the two `job.test.tsx` tests reported last time as failing under `TZ=America/Los_Angeles` (they assert a machine-zone date in code this group did not touch).

## Requests

- **Orchestrator / owner of `__tests__/lib/i18nStaging.test.ts` (do this first):** the test re-parses a locale bundle for every staged string and locale. My 230 staged role names (of 247 staged strings in total) put it within about half a second of its 5 s timeout, and it will get slower as other groups stage strings. Either cache `bundle(locale)` in a `Map` in that test, or run `npm run i18n:merge` before the suite.
- **Orchestrator / i18n owner:** merge and translate the staged keys below. `jobsCn.zh.json` carries the GoApply Chinese for `jobsCn.fit.logistics`.
- **Owner of `lib/api/tracker.ts`:**
  - Give `trackerExportCsvUrl` an optional `timeZone` argument that adds `?tz=`; the toolbar can then drop its local `withTimeZone`.
  - Give `getWeeklyInsight` and `refreshWeeklyInsight` a `tz` argument.
- **Owner of `server/src/roboapply/v2/routes/insights.ts` and `RAInsightService`:**
  - Read `tz` on the weekly GET and the refresh, and pass it as the third argument of `tracker.weeklyFacts`.
  - Let the refresh take the same `weekStartUtc` as the GET.
  - Until then, an account with no stored zone still gets UTC-bucketed weekly counts.
- **Owner of `components/v3/pipeline/PipelineCard.tsx`:** `formatShort(entry.followUpAt)` shows the previous day west of UTC; format date-only values in UTC as `dayKeyOf` in `components/features/tracker/shared.ts` does.
- **Owner / OPS (needs DML, not run):**
  - Re-classify stored jobs with `primaryTaxonomyId = 'architect'`.
  - Re-normalise pay on stored rows.
  - Re-run keyword extraction for stored jobs; the new stopword rules apply only to new enrichment.
- **OPS-A2:** set `RA_SYSTEM_USER_ID` and `CN_RA_SYSTEM_USER_ID` to real user ids.
- **G2 (onboarding writer):** `{ label: <code>, country: <code>, radiusKm: 0 }` now means the whole country in the feed.

## i18n keys added or changed

No keys changed in this pass. From the first pass, still staged:
- `filters.chips.anywhereIn`, `.sponsorshipNotNeeded`, `.cleared`, `.undo` (new)
- `fit.keywordCheck.shownBy`, `.via` (new); `fit.keywordCheck.count` (changed)
- `fit.otherLanguage.note`, `.rewrite`, `.rewriting`, `.failed` (new)
- `inbox.alertJobs.label`, `.item`, `.more` (new)
- `jobs.card.firstSeen` (new)
- `jobImport.list.status.rejected` (changed to "Rejected")
- `jobsCn.fit.logistics` (new, en and zh)
- `taxonomy.roles.*` (new, 230 names)

## Known gaps

- A job that asks for an everyday-word skill by name ("Excel", "React") is still matched by a whole-word mention in resume prose ("I excel at…"). The resume text is compared in lower case, and requiring the skill list there would miss real mentions.
- A rewrite still runs the full scorer and discards its numbers; a prose-only prompt would be cheaper but the agent is outside this group.
- When a rewrite fails because of the daily limit, the message still says "Try again".
- For a composite taxonomy role the people search falls back to the title head, which can be generic ("Sr. Manager, Strategic Finance - EMEA" gives "Manager").
- The client rule for a country-wide location needs the label to name the country.
- Typeahead suggestion labels still come from the server in English for locales other than zh.
- Fraud and tag quotes are still cut from the folded (half-width) text.
- The "undo keeps In your applications" case could not be reproduced from the logs.