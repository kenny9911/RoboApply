# MKT-4E

Canonical skills in the estimate, the three-state keyword check, the fit-card checklist UI and the skills gate (SM-6 read path, SM-3, SM-8 web side). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4E`, branch `wp/MKT-4E`. Nothing was committed. No command reached a database, a model, an embeddings endpoint or the network. Every edit is inside the bundle's owns (two temporary files I made for measuring and type-checking, and a reporter output folder, were removed again). Nothing was checked in a browser (not allowed in this phase): the UI is covered by component tests on both brands and by the design and copy gates.

This is the handoff after the independent review. All four items are done. The review's one open ACCEPT line and its findings 1 to 8 are fixed in code with tests; findings 9 and 10 need files outside my owns and are Requests. No finding was rejected. The list is at the end under "Review resolution". Two tests outside my owns are red because a new suite file exists (listed below). Points that differ from the item text or go beyond it are marked **Differs**; please confirm or reject them. Precedence: only Differs (m) sets an item's wording aside for a plan document (SEARCH_RETRIEVE_MATCH 4.6, "`RAJob.skills` keeps display strings"); I found no other place where the documents overrule an item.

## Items

### 1. [P0] The estimate compares canonical hard skills; the vocabulary is loaded first: done

- `defaultService.ts`: `registerMatchPreparer(loadSkillVocabulary)` (`() => skills.ready()`), registered once at import. `MatchService.userContext` already awaits the hook, so the first estimate of a process reads the table. When `RASkill` cannot be read the estimate runs on the committed seed (the loader's own rule).
- `context.ts` `toMatchJob`: `MatchJob.skillIds` (only when the row has ids), `skillsDetail[].skillId`, `skillsDetail[].via` (only next to an id), `MatchJob.lang`. `UserMatchInputs.locale` → `MatchUser.locale` (only when given).
- `preScore.ts`:
  - `userSkillIdSet(user)` = `userSkillIds(user.skills, user.resumeTextNorm)`, memoised per person object and vocabulary snapshot.
  - `jobSkillList(job, locale?)` returns `{ skill, skillId, required, kind, term, also?, guessed? }`, one entry per skill.
    - **A row whose `skillsDetail` carries ids (enrichment v3): `skillsDetail` is the list.** Enrichment writes one entry per skill and keeps every spelling in `RAJob.skills`. A string of `skills` with no entry of its own is another spelling: it joins the entry whose skill the vocabulary says it names (`also`), takes that entry's kind (a soft skill stays soft) and is never a skill of its own. A known name also ends a machine guess. A string the vocabulary cannot place on an entry is left out.
    - A row without ids: the list is what it always was (every string of `skills`, the `termKey` rule).
    - An id merged into another skill resolves through `idOf`. Labels: `label(id, locale)` when reviewed, else `displayTerm`.
  - `jobSkillCheck(user, skill)`: state and credit come from one answer, so the number, its evidence lines, `splitSkills`, top overlap and top gap never disagree about a skill.
    - reviewed id: the person's canonical skills. Shown 1, related 0.5 (`RELATED_SKILL_CREDIT`), not shown 0, `unscored` when the resume's only trace is a word with another reading (below);
    - any other id (not reviewed, not held by the vocabulary, or `via: 'embedding'`): `unscored`, in neither sum, never called missing;
    - no id: the string rule, for the state and the credit alike, exactly as MKT-1F computed it. The vocabulary is not asked.
  - `skillsDimension`, `splitSkills` (also `related` and `unchecked`), `overlapAndGap`, `preScore` use it. New evidence ref `skill_related`.
  - `mentions()` now answers "no" from a plain substring test before it builds a pattern (same result, less work).
- ACCEPT, each a test in `preScore.test.ts`:
  - "relational databases" (required) with PostgreSQL listed scores 50, is in `aligned` and `related`, not in `missing`.
  - "Postgres" and "PostgreSQL" count one skill, **on the exact row MKT-4D's reconcile writes** (`skills: ['postgres','postgresql','communication']`, one PostgreSQL entry with its id, one soft Communication entry): one hard skill listed, 100 for a person who lists PostgreSQL (it was 67), no duplicate chip, nothing unchecked. Also with three skills under two spellings each (it was 57 with "Communication skills" as the gap; now 100, and the soft skill stays soft), and with each spelling as its own entry.
  - An unreviewed skill changes no score.
  - A posting without ids gives the same estimate under any vocabulary (score, tier, coverage, confidence, limit, every part with its evidence, top overlap, top gap, the split).
  - The first estimate after a cold start sees a skill that exists only in the table (`defaultService.test.ts`, the table faked behind the Prisma module).
- Measured against the base commit's `preScore` (a temporary copy, removed): the 100 skills pairs taken without ids, each posting against three resumes, 300 estimates. 291 are identical in score, tier, coverage, confidence, limit, the score and status of every part, the aligned and missing lists, top overlap and top gap. The other 9 are Chinese resumes that write a Latin tool name next to a Chinese character (Differs (d)); the number rises there.
- Ranking is unchanged: `ranking ndcg_at_10` 0.9515 (intl) and 0.9418 (cn), `ndcg_at_20` 0.9638 and 0.9598, equal to the stored baseline. The baseline file was not touched.
- Speed, 400 postings of 10 skills against one person with a 10,000-character resume, one script for all three numbers: 0.18 ms per posting with ids, 0.39 ms without, the base commit 0.52 ms on the same rows without ids (and the same 400 scores). The numbers of the first handoff came from another script.

**Differs (a): "shown" also reads a full everyday word from a sentence.** `userSkillIds` leaves out a name that is also an ordinary word when it stands in a sentence ("built services in Go"). With it alone, a resume that writes Go, React or Excel in a sentence and not in its skill list would read "Not in your resume", which the string rule never did. So a reviewed hard skill is also shown when the resume text names it under such a word (`skillIdsInText(…, { listOnlyWords: true })`, each find confirmed by the name as written, whole word). Such a find is never evidence for a broader skill ("I react quickly" does not show frontend frameworks).

**Differs (b): a word with another reading is neither claimed nor denied (`unscored`).** Two cases, one rule (`canonicalCheck`):
- a certificate named only under any such word ("Cut CPA by 20%");
- a hard skill named only under an abbreviation with another reading: the keys of `LIST_ONLY_KEYS` (ML, PS, node, TS, AI…) and every word of three letters or fewer outside `SHORT_NAMES_WITH_ONE_READING` (NLP, EMR, BI…). "Administered 500 ml of saline", "PS: available at once" and "a 5-node cluster" no longer show Machine learning, Photoshop and Node.js.

Exceptions: the skill is listed or written out (shown); a more specific skill of the person shows it (related, checked first); the posting itself writes the skill as that abbreviation and the resume writes it too (shown: what the string rule always counted). An `unscored` skill is in neither sum, so the part is decided by the skills that were compared. The nurse of the test (the review's three sentences plus "Kept the ward rota in Excel", against a posting that asks for Machine learning, Photoshop, Node.js, TypeScript, Excel and Go) scores 33: Excel of the three compared skills. The string rule on the same strings gives 17 (Excel of six). Before the fix it was 67.

**Differs (c): a skill without an id is compared by its string also inside a re-enriched posting.** The item says so; I state it because MKT-4D built "no unreviewed skill is created until label vectors exist", so most skills of a posting outside the seed keep no id for now. Leaving them out would let one mapped skill decide the whole part.

**Differs (d): `mentions()` treats a Chinese, Japanese or Korean character next to a Latin name as a word boundary.** "使用Go开发" and "熟悉Java和Python" were not found before. This is the one change that moves the number of a posting without ids: 9 of the 300 estimates above, all upward, all Chinese resumes that name a tool in a sentence and not in the skill list. On GoApply that is a common way to write a resume, so expect it there. The ranking values did not move.

**Differs (e): for a skill without an id, the number and the card are the string rule; the keyword check and a bare term also read the vocabulary.** The review found the earlier form mixed (the card said "your resume mentions K8s" above 0 / 100). I took its option (a), the one the ACCEPT line "same inputs, same number" requires: `jobSkillCheck` gives one literal answer, so a posting that has not been re-enriched keeps the estimate MKT-1F computed, words and number. The keyword check asks `listedSkillCheck` (string rule, then the person's canonical skills) and `userShows` asks `termCheck`: they must not tell a person they lack a skill they list under another name. One wording differs from MKT-1F on such a posting: a skill shown through a named technology has the evidence line `skill_related` ("your resume shows a related skill") and still counts its whole weight there, as the string rule always counted it. See Known gaps and Owner 5 for what this leaves.

**Differs (f): labels follow `MatchUser.locale`, else the posting's language when it is English or Chinese, else the market's.** `RAJob.lang` holds `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `other`. Only `en` and `zh…` name a language a label exists in; `ja`, `ko` and `other` (a short or mixed text) fall through to the market (`zh` on GoApply, `en` on RoboApply). `label(id, 'zh-TW')` never returns a Simplified label. The request language does not reach the estimate yet (Requests).

**Differs (g): a title that shows a practice is related evidence** for a reviewed skill too ("software engineering" for a Software Engineer), as the string rule had it.

**Differs (m): in a row that carries ids, `skillsDetail` alone is the list** (the bold point above). The item says "de-duplicated by skillId when there is one, else by the existing termKey rule", which reads every string of `skills` as a skill. On the row enrichment v3 really writes that made a second spelling a second skill, so a string of `skills` is now only ever a spelling there.

### 2. [P0] Keyword check with three states: done

- `contract.ts`: `KeywordItem = { term, state: 'shown' | 'related' | 'not_shown', found, skillId, via?, quote, required? }`, `KEYWORD_QUOTE_MAX = 160`, `KeywordRow.unchecked?`, `KeywordCheckResponse.vocabularyAsOf?`. `found` stays (true for shown and related).
- `keywordRows.ts` `buildKeywordRows`:
  - A posting that carries ids: its reviewed hard skills and certificates, once per id, under the canonical label, each by `jobSkillCheck`. A skill nobody has reviewed, a machine guess and a string with no id are not listed; `unchecked` counts them. A second spelling in `skills` is not a skill and is not counted.
  - A posting without ids: every hard skill, by the string rule and the vocabulary (`listedSkillCheck`); two spellings of one skill are one item.
  - Keywords: only a term that names a reviewed hard skill or certificate, never one the skills row lists or withheld, never a string a reviewer dropped. A keyword with the id enrichment v3 stored is that skill. **A keyword without one is read like the words of a sentence (`skillIdsInText`), never by a bare `idOf`**: "postgres", "k8s" and "mysql databases" name a skill; "go", "rest", "express", "spring", "swift", "shell", "oracle" and "work day" do not.
  - Soft skills are never listed (carry-over M1.3).
  - Nothing is listed for a skill whose only trace is a word with another reading (Differs (b)); `unchecked` counts it.
  - `quote`: the resume sentence the term was found in, verbatim, markdown markup removed, at most 160 characters. A sentence is preferred to a skills line. Null when the term comes from the skill list only, and for every other state. **Only a sentence that shows the skill by the rule of the check is quoted** (`textShowsSkill`): "Administered 500 ml of saline per shift." is never the proof of Machine learning, also not for a person who lists the skill.
  - Row status: shown 1, related 0.5 (`ratioStatus`). `found` = shown + related.
- ACCEPT, each a test in `keywordRows.test.ts` (44): the three states; "relational databases" related via PostgreSQL with no quote; "Node.js", "node", "NodeJS" one item; the exact MKT-4D row is one PostgreSQL item with nothing unchecked; a shown item carries its sentence, in English and Chinese (and for a Traditional resume); de-duplication across the two rows; items without reviewed ids omitted; the nurse case in both rows and in the quotes; legacy keywords ("shell", "express", "go" and seven more); the path for postings without ids (INV-7's case); the status arithmetic.

**Differs (h): a row status `not_checked` and the count `unchecked`.** A row that lists nothing because nothing in it could be checked would otherwise read "Not stated in the post" or "Met 1 of 1", both false. Skills row: status and count. Keywords row: status only (a posting with high or medium keywords of which none is a reviewed skill, such as "wound care" and "patient assessment"); a count of loose keywords would say nothing. Additive.

**Differs (i): `vocabularyAsOf` is added by `defaultService.ts`**, which wraps `keywordCheck` of the production service (`MatchService.ts` assembles the response and is MKT-4G's). See Requests.

**Differs (l): a legacy keyword that names two skills gives two items, and one that names a skill inside a longer phrase gives that skill** ("mysql databases" is listed as MySQL). That follows from reading it as a sentence.

Also changed: the title row no longer shows the saved search's title as "your recent title" when the record has none (carry-over M1.2).

### 3. [P0] Skills gate: done

- `eval/fixtures/skills/pairs.json`: 100 synthetic pairs, 530 hand-labelled skills (248 shown, 71 related, 211 not shown): 45 English, 27 Simplified Chinese, 12 Traditional Chinese, 16 cross-language. `"_synthetic": true`, `"_labels": "authored"`. Each pair names the MKT-1D role group and role it is built on. Unchanged by the review.
- `eval/fixtures/skills/vocabulary.extension.json`: 68 skills of those role groups that the seed does not hold. Read by the suite only.
- `eval/suites/skills.suite.ts`: **`postingSkillRow` builds each posting as MKT-4D's `reconcileSkills` writes it**: the strings grouped by canonical id, one `skillsDetail` entry per group under the skill's own label when the posting uses it (else the first spelling), `required` when one spelling is, the vocabulary's kind, `via`; `skills` with every spelling in lower case; hard ids in `skillIds`, required first; one keyword per skill with its id. Reports:

| Metric | Value | n |
|---|---|---|
| `precision_not_shown` (gated, at least 0.95) | **0.9671** | 213 answers |
| `recall_not_shown` | 0.9763 | 211 |
| `precision_shown` / `recall_shown` | 0.9714 / 0.9714 | 245 / 245 |
| `precision_related` / `recall_related` | 1.0000 / 0.9155 | 65 / 71 |
| `duplicate_items` | 0 | 100 pairs |
| `soft_items_listed` | 0 | 100 pairs |
| `unlisted_items` (neither claimed nor denied) | 4 | 527 |
| `precision_not_shown_without_ids` (the same pairs, ids taken off) | 0.9671 | 213 |

  By market: intl 0.9635, cn 0.9737. By language: English 94.8% (91 of 96), Simplified 96.7%, Traditional 100%, cross 100%.
- `eval/enforced.test.ts`: `registerInvariants({ enforce: 'M4' })`; all ten run in `npm test` and pass. INV-7 holds on its own posting (no ids).
- `eval/suites/skills.suite.test.ts` (18): the shape test, the arithmetic, the row builder against the MKT-4D shape, and the gate itself in `npm test` (precision at or above 0.95 overall and per market, zero duplicates, zero soft items, "a posting skill that is word for word in the resume's skill list is never not shown").
- `npm run eval:match -- --enforce M4` exits 0 in this worktree (the other M4 layers print `not_built`).

**Differs (j): the seven misses are real, and I left them in.** "fine-tuned" for Model fine-tuning; "Elastic Search" for Elasticsearch; Excel named in a sentence for Spreadsheets; Illustrator for Design tools and Salesforce for CRM (no parent edge in the seed); 大模型 for 大语言模型 (no alias); 注会 inside a sentence. Nothing was tuned to them. The four unlisted skills are the price of Differs (b): "CPA" in a marketing sentence, "BLS certified", and since the review "NLP Engineer" for Natural language processing and "EMR" for Electronic health records. The labels are mine, not a recruiter's.

**Differs (k): `duplicate_items` is information in the harness table**, because `gates.ts` is not mine. Zero is enforced in `npm test`. See Requests.

### 4. [P1] Fit card UI: done

- `KeywordCheck.tsx`: one line per term with its state in its own words: "Your resume shows it" with the quote, "Related: your resume shows {term}", "Not in your resume". Counts "{shown} shown, {related} related, of {total}". An answer in the old shape reads the same way (`keywordState`). A row with status `not_checked` reads "Not checked yet"; the skills row adds how many ("The 2 skills from the post are not checked yet." when it lists nothing else, "2 more skills…" otherwise). When a row holds a related or missing term: one note and one LINK to the person's resume for this job. No button, nothing is edited.
- `RequirementChecklist.tsx` (new): "What the post asks for", must-haves then preferred, each with Met / Partly / Not shown in your resume, the posting line verbatim and the resume quote verbatim; `not_applicable` lines are not listed; the AI label (GoApply only) and a check-it line. Rendered by `JobFit.tsx` and `FitAnalysisCard.tsx` for an AI fit that carries requirements; nothing otherwise.
- `DimensionList.tsx` (carry-over M1.4, M2.7): a part that was not compared says what that means. `labels.ts`: `skill_related`.
- `WhyYouFit.tsx`: **`skillCounts(skills)` counts on the web**: compared = the server's aligned plus missing; unchecked = what is left of `listed` (the same number as the server's `unchecked` list when it is sent). It reads the server's own lists, never the lists merged with the model's terms, so the count works before and after MKT-4G adds the list. When no skill of the posting was compared, the gap section prints only "The 2 skills in this post are not checked against your resume yet." (never "shows every skill we compared"), and the overlap section prints "The skills this post lists are not checked against your resume yet." (never "None of the skills this post lists show up").
- Tests in `match.test.tsx` (60): the three states and the quote, counts, the old answer shape, unchecked in both rows, the add link, both brands, checklist grouping, quotes, `not_applicable`, empty checklist, GoApply label, no visa wording, `skillCounts`, the count without the server's list, a posting with nothing compared (both sections, both cards), postings with everything compared read as before.

### Carry-over

- M1 MKT-4E.1 (INV-7), .2 (title row), .3 (soft skills), .4 (by-filters wording and the split by fit kind): done. .5: no file of the ranking baseline's hash changed, so the baseline was not rewritten; `fixtures.test.ts` is green.
- M2 MKT-4E.1 to .5 and .7: done. .3 ("decide per skill kind"): a full everyday word counts for a hard skill; an abbreviation counts only when the posting writes it; nothing of the kind counts for a certificate. .6: informational. .8 (move `fitFixture` to the test kit): left; it is optional and the six imports to repoint are in other areas.
- M3: no section for this bundle.
- Handoff MKT-4D request 6 (`skillsDetail` shape, `certification`, guesses, unreviewed ids in `skillIds`): matched by the code and tests, now including one entry per skill.

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4E/`. Files touched after the review are marked (R).

- `server/src/features/match/`: `preScore.ts` (R), `keywordRows.ts` (R), `context.ts` (R, comment), `contract.ts` (R, comments), `defaultService.ts`, `testkit.ts`; tests `preScore.test.ts` (R), `keywordRows.test.ts` (new, R), `inputs.test.ts`, `terms.test.ts`, `defaultService.test.ts` (new)
- `server/src/features/match/eval/`: `enforced.test.ts`, `suites/skills.suite.ts` (new, R), `suites/skills.suite.test.ts` (new, R), `fixtures/skills/pairs.json` (new), `fixtures/skills/vocabulary.extension.json` (new)
- `components/features/match/`: `KeywordCheck.tsx` (R), `RequirementChecklist.tsx` (new), `FitAnalysisCard.tsx` (R), `JobFit.tsx` (R), `WhyYouFit.tsx` (R), `DimensionList.tsx`, `labels.ts`, `index.ts` (R), `match.module.css`, `match.test.tsx` (R)
- `hooks/match/useKeywordCheck.ts` (comment only)
- `i18n/staging/fit.en.json` (R)
- `server/src/features/match/terms.ts`: unchanged (no table removed).
- Handoff: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4E.md`

## Tests run

All on the final code.

| Command | Result |
|---|---|
| `npx vitest run` on the eight owned test files | 410 passed: preScore 134, keywordRows 44, inputs 29, terms 64, defaultService 4, enforced 57, skills.suite 18, match.test.tsx 60 (plus the untouched `hooks/match` 7 and `competitiveness.test.tsx` 14) |
| `npm run typecheck:server` | pass |
| `npx next typegen && npm run typecheck:web` | pass |
| owned server test files and the suite with a temporary tsconfig (removed) | clean |
| `npm run check` | pass (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npm run eval:match -- --enforce M4` (also `--market intl`, `--market cn`) | exit 0 |
| `npx vitest run --exclude ".claude/**"` (twice) | 732 files: 731 passed, 1 failed. 18,465 tests: 18,452 passed, 2 failed, 1 skipped, 10 todo |

## Red tests for other bundles

Both in `server/src/features/match/eval/run.test.ts` (MKT-1D's file; no owner in M4, so the orchestrator). MKT-4F and MKT-4G add suites too and hit the same two. The reviewer confirmed both.

1. `suite discovery > the shipped suites are taxonomy, ranking and language` (line 154): asserts the exact list `['language', 'ranking', 'taxonomy']`. It should assert the list after the merge (with `skills`, and `retrieval` and `scorer` when they land), or `expect.arrayContaining(['language', 'ranking', 'taxonomy'])`.
2. `the shipped suites > ranking and language are not_built while the fit seam is missing` (line 477): runs every suite except taxonomy and expects `not_built` from each. The skills suite does not read the fit seam and measures. The filter should name the two suites the test is about: `.filter((f) => /ranking|language/.test(f))`.

## Pre-existing failures

None. Both full runs of this round show only the two tests above.

## Requests

**MKT-4G (`fit.ts`, `MatchService.ts`, `repo.ts`).**
1. `MatchService.ts` `toCard`: `requirements: view.requirements ?? []`. `FitAnalysisCard.requirements?` is in the contract and the card renders it.
2. `MatchService.ts` `keywordCheck`: add `vocabularyAsOf: vocabularyAsOf()` (from `./keywordRows.js`). Then the wrapper in `defaultService.ts` can go (it keeps a value the service already set).
3. The request language for labels: `userContext(userId, variantId, locale?)` passing `locale` into `buildMatchUser` (`UserMatchInputs.locale` exists), from `scoreJob` / `fitAnalysis`, from `keywordCheck` and from `GetFitsOptions`. Until then labels follow the posting's language.
4. `repo.ts` `getKeywords`: pass `skillId` through (`KeywordInput.skillId` exists; MKT-4D request 7). Not blocking: without it a keyword is read as words.
5. Optional now: `fit.ts` `assembleFit` `skills.unchecked: split.unchecked`. The web counts the same number from `listed`; the list would only let a later screen name the skills.

**MKT-4D.** No change asked. I rely on the row shape of `reconcileSkills`: one `skillsDetail` entry per skill, and every string of `skills` belongs to an entry. Please keep both; a reader can no longer tell a second spelling from a new skill otherwise.

**Orchestrator.**
1. The two red tests above.
2. Review finding 10: a test process that reads a fit through `createMatchService` after importing `match/index.ts` runs the registered loader, which tries `RASkill` at the closed test port (refused, the seed stays, nothing fails). To keep such tests off the Prisma client: in `__tests__/setup.ts`, `beforeEach(async () => { await (await import('../server/src/features/skills/index.js')).loadVocabulary({ repo: null }); })`. It has to run per test, because `resetVocabularyForTests()` forgets the loader; the cleaner change is in `features/skills/vocabulary.ts` (no owner): let `resetVocabularyForTests()` leave a seed-only loader behind. `defaultService.test.ts` fakes the table and is not affected.
3. `routes.ts` (no owner): `GET /match/jobs/:id/keyword-check` should pass `locale: await requestLocale(req)` once `keywordCheck` takes it (request 3 to MKT-4G).
4. `eval/gates.ts` (no owner): `{ layer: 'skills', metric: 'duplicate_items', rule: { kind: 'below', threshold: 1 } }` and the same for `soft_items_listed`, so the table gates what the tests already enforce.
5. `eval/README.md` (no owner): line 50 ("it enforces `M2`, so nine of the ten") is now M4 and ten; "The suites shipped here" gains `skills`; the fixtures table gains `fixtures/skills/`.
6. `features/skills/` (no owner). What the gate found: alias 大模型 for `llm`; parent edges Salesforce and HubSpot to CRM, Illustrator, Photoshop and InDesign to design tools; "Elastic Search" written as two words; a verb form of a skill name ("fine-tuned"); a two-character Chinese name inside a sentence (注会, 一建). Since Differs (b): decide whether `nlp` and `emr` have one reading in a resume (`SHORT_NAMES_WITH_ONE_READING`); today "NLP Engineer" neither shows nor denies Natural language processing. I second MKT-4D's request for learned keys kept apart: in a process that has just guessed an alias, `idOf` answers the guessed skill for up to ten minutes, and the keyword check of a posting without ids would then label that string as the guessed skill.
7. MARKET_TASK_PLAN 3.3, row "Skill vocabulary", a new "as built" note: `skillsDetail` is the list of a row that carries ids and `skills` holds spellings; the per-skill rule of item 1 including `unscored` for a word with another reading; a skill without an id keeps the string rule in the estimate; `KeywordItem`, `not_checked`, `unchecked`, `skill_related`, `MatchUser.locale`.
8. OT-2: translate the keys below. No longer read by any component (left in place): `fit.keywordCheck.count`, `.mentioned`, `.notMentioned`, `.shownBy`, `.via`, `fit.missing.empty`.
9. For whoever owns ingest next: `upsert.ts` replaces `RAJob.skills` when a provider sends a non-empty list. After that a row can hold a skill string that has no `skillsDetail` entry until its next enrichment; this reader treats it as a spelling (Known gaps).

**Owner.**
1. After re-enrichment the keyword check lists only skills the vocabulary has reviewed. The committed seed is 273 skills, mostly software. A nursing or sales posting will list few or none and read "Not checked yet" until the review round trip of MKT-2G is run on real postings. The estimate keeps comparing unmapped strings by the string rule, so no score depends on this.
2. Once label vectors exist, unknown skills become unreviewed ids and leave the number by design. A posting whose skills are mostly unreviewed then has its skills part decided by the few that are reviewed, or not compared at all (prior 39).
3. The 100 labelled pairs are authored by the engineer of the check. A recruiter's pass over `pairs.json` would make the gate a measured one.
4. Confirm Differs (a) to (m).
5. A decision the review left open (its option (b)): let the NUMBER of a posting without ids follow the vocabulary too. Today such a posting keeps MKT-1F's estimate, so a person who lists Kubernetes still scores 0 for "k8s" there and the card calls it missing, while the keyword check on the same page says the resume shows it. Option (b) removes that difference at once instead of at re-enrichment, at the price that numbers move for postings nobody re-enriched and that the ACCEPT line "same inputs, same number" no longer holds. It is a change of a few lines in the last branch of `jobSkillCheck` plus a ranking check through the harness. I did not take it without your word.

## Schema requests

None.

## Env variables added or redefined

None.

## i18n keys added or changed

All in `i18n/staging/fit.en.json`, English only (nothing GoApply-only). No existing key was reworded or removed. Keys added after the review are marked (R).

- `fit.keywordCheck.countStates`, `.state.shown`, `.state.related`, `.state.relatedPlain`, `.state.not_shown`, `.quote`, `.unchecked` (plural), `.uncheckedAll` (plural, R), `.status.not_checked`, `.add.note`, `.add.action`, `.add.resume`
- `fit.requirements.title`, `.intro`, `.must`, `.preferred`, `.count`, `.status.met`, `.status.partly`, `.status.not_shown`, `.note`
- `fit.compared.notComparedEstimate`, `.notComparedAi`, `.byFilters`, `.evidence.skill_related`
- `fit.missing.emptyCompared`, `.unchecked` (plural), `.noneChecked` (plural, R)
- `fit.why.notChecked` (R)

## Known gaps

- **Not seen in a browser.** Light and dark, 375 px and 1280 px are covered by tokens only (`check:design` clean, no literal colour) and by jsdom tests on both brands.
- **A posting without ids: the card and the keyword check can differ** (Differs (e), Owner 5). The card and the number say what the string rule says; the check also knows two names are one skill. It ends when the posting is re-enriched.
- **`unscored` takes a skill out of both sums.** A resume whose only trace of a skill is ambiguous is scored on the other skills of the posting, which can read higher than counting it as not shown would (33 against 17 in the example of Differs (b)).
- **Short abbreviations nobody has cleared are not read from a sentence** when the posting writes the skill out: NLP, EMR, BI and the like. The check says nothing about them; listing the skill, or writing it out, shows it.
- **In a row that carries ids, a string of `skills` the vocabulary cannot place on an entry is left out.** For a row enrichment wrote that is right (it is a second spelling). When a provider refresh adds a new skill string afterwards, that skill is not compared until the next enrichment.
- **No producer yet** for `FitAnalysisCard.requirements` and the request language (Requests to MKT-4G). The web reads each with a safe default. `MatchFitView.requirements` is filled by MKT-4G's scorer v4; the checklist was tested with hand-written requirements.
- **In a re-enriched posting the keyword check omits a string with no id while the card still lists it by the string rule.** The check declines to say; the card says what the words say.
- **The keywords row of a re-enriched posting is usually empty** and reads "Not stated in the post": enrichment v3 keeps a posting's skills as its high and medium keywords, and the skills row already lists them.
- **False "shown" for an ordinary word that is also a tool name**: "go-to-market" (Go), "express checkout" (Express), "spring sale" (Spring), "I sketch" (Sketch). The same as the old string rule. The quote under the item lets the reader see what counted.
- **"Spring Boot" on a resume reads Spring as shown**, where a person would say related. Both count as found.
- **English alone is at 94.8%** on "not shown" (5 misses in 96); the gate reads all pairs (96.7%) and each market (96.4%, 97.4%).
- **The vocabulary read in tests** (Orchestrator 2).
- **The memo of `jobSkillList` and `splitSkills`** is keyed by the posting and person objects and checks the arrays and their lengths. An in-place edit that keeps the length of `skills` would be missed; nothing in the code does that.
- **`mentions()` and Thai, Lao or Khmer**: only Han, Hiragana, Katakana and Hangul are treated as scripts without spaces.

## Review resolution

Each finding was reproduced first with a scratch script against the worktree code (same numbers as the review), then fixed, then measured again.

- **Item 1, ACCEPT "Postgres and PostgreSQL count one skill" (not done) and finding 1 (high): fixed.** `jobSkillList` builds the list from `skillsDetail` when it carries ids and folds the other strings of `skills` into the entry they name. On the exact MKT-4D row: list `[PostgreSQL(id), Communication(soft)]`, skills part 100 (was 67), `aligned ['PostgreSQL']`, keyword check one item and no "not checked yet". On the six-string row: 100 (was 57), no "Communication skills" gap. Tests: two in `preScore.test.ts`, one in `keywordRows.test.ts`, three in `skills.suite.test.ts`; `skills.suite.ts` now builds its rows that way (`postingSkillRow`).
- **Finding 2 (medium): fixed with option (a).** For a skill without an id `jobSkillCheck` returns the literal state that sets the credit; `splitSkills`, the evidence lines, top overlap and top gap follow it. "k8s" and "ReactJS" against Kubernetes and React: 0 / 100, evidence `skill_missing` only, top overlap null. The vocabulary union stays in `termCheck` and in the keyword check (`listedSkillCheck`). Tests rewritten: the two that pinned the mixed form. Option (b) is put to the owner (Owner 5).
- **Finding 3 (medium): fixed.** `isAmbiguousAbbreviation`, `ambiguousTraceOf`, `canonicalCheck`: a find confirmed only by a key of `LIST_ONLY_KEYS` or by a word of three letters or fewer outside `SHORT_NAMES_WITH_ONE_READING` is `unscored`, unless the posting's own string is that abbreviation; full everyday words (Go, React, Excel) keep counting; real related evidence is checked first. The quote finder quotes only a sentence that passes `textShowsSkill`, in the scan and in the fallback by name. Nurse case: Machine learning, Photoshop and Node.js unscored and unchecked, no quote of the three sentences. Tests: one in `preScore.test.ts`, four in `keywordRows.test.ts`.
- **Finding 4 (low): fixed.** In `splitSkills` the string rule answers only for a skill that is not compared by id; a reviewed skill the check withheld goes to `unchecked`. The marketer's CPA: not in `aligned`, top overlap not "CPA". Test extended.
- **Finding 5 (low): fixed.** `keywordSkillIds`: a keyword without a stored id is resolved with `skillIdsInText`. Courier posting: no item, status `not_checked`. Three tests, including "shell", "express" and "go".
- **Finding 6 (low): fixed.** `labelLocaleFor` uses `job.lang` only for `en…` and `zh…`; GoApply with `other` gives 关系型数据库, 机器学习. Both comments name the real tag set. Test extended.
- **Finding 7 (low): fixed.** `skillCounts` on the web from the server's own lists; nothing compared prints only the "not checked" lines in both sections, on `JobFitView` and `FitAnalysisView`. Six tests (one of them rewritten).
- **Finding 8 (low): fixed.** The keywords row is `not_checked` when it lists nothing and at least one high or medium keyword was left out for want of a reviewed skill; `not_stated` only when the posting has no such keyword. Three tests, and the web test for the row.
- **Finding 9 (low): Request** (Orchestrator 1, 4, 5). `run.test.ts`, `gates.ts` and `README.md` are not mine.
- **Finding 10 (low): Request** (Orchestrator 2). `__tests__/setup.ts` and `features/skills/` are not mine; production code gets no test switch.
- **Unowned edits:** none were reported and none exist (`git status` shows owned paths only).
- **Found while fixing:** the estimate of a posting without ids had become slower than the base on long resumes (0.84 ms per posting against 0.52 ms); a substring test in `mentions()` before the pattern brings it to 0.39 ms with the same answers. The share of estimates Differs (d) moves is now measured (9 of 300) instead of assumed to be none.
