# MKT-1E

Role taxonomy precision, enrichment override and backfill; data quality (SM-2, SM-10; query labels of SM-11).
Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1E`, branch `wp/MKT-1E`. Nothing committed. All six items are done and the independent review is resolved (see "Review resolution"). Every edit is inside the bundle's owns.

Gate: 20 test files / 547 tests in the owned directories green; whole suite 651 files / 14,618 tests green (base: 645 / 14,292); `typecheck:server`, `typecheck:web` and `npm run check` green. No red test outside the owns, no pre-existing failure.

**One thing the orchestrator must decide at the M1 gate: Request 1.** Until `ingest/upsert.ts` keeps an enriched role on refresh, a model's override lasts only until the provider next lists the posting. The file has no owner in M1.

## Review resolution

All seven findings were checked against the worktree first (probe of every title the reviewer named, worktree against the base commit). All seven were real. None was rejected. No unowned edit existed and none was made.

1. **High, "Software Engineer, <team>" filed as Tech lead: fixed.** `buildModifierLexicon` skips a role phrase whose words before the head noun include a level word, so "lead software engineer" no longer gives "software" to the tech lead. The probe found the same fault in three more phrases the review did not list: "Smart Home Engineer" was a blockchain engineer (from "smart contract engineer"), "Power Generation Specialist" an SDR ("lead generation specialist"), "Data Specialist" a data-entry clerk ("data entry specialist"), "Tech Stack Engineer" a full-stack engineer. All four are unknown again, as on the base. A role phrase found in the title now wins a tie with a lexicon pick (`named` rank before id order), so the bare title no longer rests on the alphabet. Tests: the seven titles of the review plus "Software Engineer" and "Senior Software Engineer" → `software_engineer` with `tech_lead` not among the matches; "Lead Software Engineer" → `tech_lead` at 1; the four half-phrase titles; and the general statement for every phrase of every catch-all role (29 cases): alone it names its role with no other role at the same score, and beside an unknown word no other role outvotes it. `precision.test.ts` no longer tolerates a wrong role inside the right category: the titles filed under another role than their label are pinned by name (one per market), so a new one fails.
2. **Medium, ingest undoes a model override: not fixable inside my owns; Request 1, now with the exact change and one correction.** `upsert.ts` is MKT-3C's (M3) and nobody's in M1. The review's SQL compares a `real` column with `0.9`; a stored 0.9 reads back as 0.89999998 and fails `>= 0.9`, so the request says `>= 0.9::real`. Until it lands: do not run `rematch-roles --apply` (Request 6), and overrides do not persist on refreshed postings (Known gaps).
3. **Medium, industry guard was a length check: fixed.** New `INDUSTRY_TOPIC_CUES` in `quotes.ts` (one cue per industry id, English, Simplified and Traditional) and `reconcileIndustry`: the quote must be in the posting, say more than the employer's name, not describe a recruiter's client, and name the claimed industry's topic outside the employer's name. The name is taken out as the full name or the longest leading part the quote uses ("Acme Fintech" for "Acme Fintech Ltd", 某某能源 for 某某能源集团). The cues are as narrow as the list is: a bank is not Fintech and a hospital is not Healthtech unless the posting says so. `reconcile.test.ts` now expects null and `['industry:off_topic']` for the 某某能源集团 case and has the positive case 公司主营光伏与储能业务. Agency: `setIndustryFromPosting` selects `isAgency` and returns `'unchanged'` when it is true; a quote that speaks of a client ("our client", "on behalf of", 客户公司, 代招, 某知名…) is dropped as `industry:client`. The prompt says the same.
4. **Medium, bare Chinese synonyms matched by substring: fixed.** 行政, 人事, 新媒体, 客户服务, 运营专员 and 运营助理 are in `ALONE_ONLY_PHRASES` (whole title only, at 0.85); the full forms keep matching at 1. For 法律顾问 I used a general rule instead of a special case: a Chinese title ends on its role, so a phrase that another role's phrase follows is that role's modifier and does not score (新媒体销售 and 常年法律顾问销售 are sales, 行政司机 a driver, 数据分析产品经理 a product manager). A catch-all role's phrase displaces nothing (Java开发工程师 stays a back-end engineer). Every title of the review is back to its base answer or better. All ten are in `match.test.ts` and nine are in `labelledTitles.cn.json` with their real categories. Added `客户服务经理` and `客户服务主管` as synonyms of the customer-service manager so those titles do not fall to unknown.
5. **Medium, 开发工程师 lost inside longer titles: fixed.** 开发工程师 is no longer whole-title-only: inside a longer title it scores for `software_engineer` as on the base (0.66 to 0.71, under 0.9), and it is no longer counted by `oneWordRolesIn`, so the backfill leaves the stored role and queues the model. 研发工程师 stays whole-title-only, as the review asked. The fix needed one guard the review did not name: the phrase must never match through the filler rule, or every "X工程师" title would have become a weak software engineer (test: 机械工程师 and four others have no `software_engineer` match at any score). Tests for the five titles, 硬件开发工程师 still at 1, and the backfill.
6. **Low, a second model call for rows a model already decided: fixed.** The rematch reads `enrichModel`. A current-version row is queued only when its last pass was rules only (`RULES_ONLY_MODEL` / `RULES_CHECKED_MODEL`) or this run changed its role; the rest are counted as `decidedByModel` and printed. Test: six rows covering each case, and a re-run with an empty queue after the model has ruled queues nothing.
7. **Low, title-made role changes on a rules-only pass were not logged: fixed.** `finishRulesOnly` logs `'role changed by the title'` with the job id, the reason and `taxonomyOverridden`. Asserted in `service.test.ts` for the `no_model` case (moved and removed), and that nothing is logged when nothing changed.

Also changed while resolving, in files I own:

- `oneWordRolesIn` leaves out words that only became whole-title names in this bundle (`fe`, 行政, 人事, 新媒体, 客户服务, 运营专员, 运营助理). They never filed a longer title, so a role a model chose beside one of them is not a leftover of the retired rule and must not be cleared by the backfill.
- `providerQueryLabels` drops whole-title-only Chinese words as it already dropped the English ones (新媒体 is as poor a provider query as "pm").

## Items

### 1. [P0] Head nouns, modifier lexicon, alone-only words, alias layer: done

`server/src/features/jobs/taxonomy/match.ts` (rewritten core, `matchTitle` signature and `TitleMatch` unchanged), `taxonomy.v1.json` (146 synonyms added on 46 roles: 92 English, 54 Chinese; none removed; no node added, removed or renamed).

- **Rule 1.** `HEAD_NOUNS` (the nine English words) and `CJK_HEAD_WORDS` (设计师, 工程师, 顾问, 专员, 经理, 分析师). A role phrase that is exactly a head noun (`architect`, `developer`, `consultant`) scores only when it is the whole title after level words; inside a longer title it scores 0. 研发工程师 behaves the same (an R&D engineer of any discipline). 开发工程师 inside a longer title keeps a weak vote for the catch-all software role (under 0.9).
- **Rule 2.** The modifier lexicon is built at module load from the taxonomy (every role phrase ending in a head noun, except a phrase that needs a level word to name its role) plus `EXPLICIT_MODIFIERS`: software words (the old `SOFTWARE_CONTEXT`, plus 后端, 云, 数据) beside `architect` select `software_architect`; building words select `architect`; software words and languages beside `developer` select `software_engineer`. The role sharing the most modifier words scores `MODIFIER_MATCH_SCORE` 0.85; a catch-all role gives way to a specific one; a tie between two specific roles gives no pick; a role phrase found in the title wins a tie with a lexicon pick. The one-entry `CONTEXT_REDIRECTS` and its `namedOutright` pass are gone.
- **Rule 3, the alone-only list** (`ALONE_ONLY_PHRASES`, 35 words, each with a one-line reason in the code): `pm apm tpm cpo cmo cio ae sdr csm ba ea gp np pt cra crc fe rater controller trainer principal registrar clerk writer auditor correspondent producer server steward` and 行政, 人事, 新媒体, 客户服务, 运营专员, 运营助理. Reviewed and left matching: `buyer`, `trader`, `doctor`, `therapist`, `teacher`, `editor`, `programmer`, `estimator`, `secretary`, `chef` and the unambiguous abbreviations (`swe`, `sde`, `dba`, `sre`, `rn`, `cto`, `cfo`). Synonyms were added so the common longer titles of an alone-only word still match ("financial controller", "banquet server", "insurance producer", "grant writer", "school principal", "bus driver" ...).
- **Chinese titles end on the role.** A phrase that another role's phrase follows is its modifier and does not score; a catch-all role's phrase displaces nothing.
- **Exports added** (also from `taxonomy/index.ts`): `HEAD_NOUNS`, `CJK_HEAD_WORDS`, `ALONE_ONLY_PHRASES`, `EXPLICIT_MODIFIERS`, `TITLE_MATCH_TRUSTED` (0.9), `MODIFIER_MATCH_SCORE`, `headNounOf`, `headNounRoles`, `lexiconCandidates`, `oneWordRolesIn`.
- **Alias layer:** FE / fe工程师 / web前端工程师 / h5前端 (front end), 服务端 / 服务端工程师 / 后台开发 (back end), 运营专员 / 运营助理 (whole title only) / 平台运营 / 网站运营 / app运营 / 店铺运营 / 网店运营, 新媒体 (whole title only) and its variants, 业务员 / 业务代表 / 业务专员 / 销售业务员 / 客户代表 / 销售工程师 / 电话销售代表 / 医药销售代表.
- **Acceptance:** all architect cases pass (the three building titles at score 1); "Senior Developer" → `software_engineer`; "Sales Developer Representative" is a sales title and `software_engineer` is not among its matches; UX / Interior / Instructional Designer are three roles; 前端开发工程师 and 服务端开发 → front end and back end; `validateTaxonomy` returns no error.
- **Tests:** `match.test.ts` (292 tests), `idsFrozen.test.ts` (5 tests: the 22 / 55 / 230 ids in data order). `taxonomy.test.ts` (MKT-1C's) stays green.
- **Differential against the base matcher** over 28,280 titles (every base role phrase in 12 English or 10 Chinese shapes: with a team after a comma, level words, "Lead", "Associate", "- C++", 高级, 实习生, a class year, 助理, 主管): apart from the synthetic "<role phrase>销售" shape (a sales title under the new rule), two titles change role, both for the better (销售开发工程师 and 销售研发工程师 → sales engineer). 247 titles the base filed are now unknown: alone-only words inside a longer title ("pm II", "Associate Architect", "controller, Payments", 研发工程师主管) and long synthetic "<role phrase>销售" titles whose 销售 scores under 0.6.

Where I departed from the item text, and why:

1. **Four of the seven synonyms named for `software_architect` were not added.** "data architect" and "security architect" are the labels of their own nodes, and "solutions architect" / "cloud architect" are synonyms of `cloud_engineer`; `taxonomy.test.ts` forbids a phrase on two nodes. Added instead: ai / ml / microservices / java / backend / platform / integration / systems / it architect.
2. **管培生 is not an alias of a role.** No node is a management-trainee role, and filing it under one states a category the posting does not (D3). 管培生, 管理培训生 and 储备干部 are removed like level words, so "销售管培生" is a sales title and a bare 管培生 stays unknown. Class years ("2027届") are stripped the same way. This also departs from strategy 2.5, which names 管培生 in the mainland alias layer; the owner can overrule it with one line in the data file.
3. **A lexicon entry from a phrase with several modifiers counts only when the title has all of them.** Read literally, "Device Driver Engineer" became a biomedical engineer through "medical device engineer".
4. **A one-word role phrase beside a head noun is a modifier, not a match** ("Nurse Manager", "DevOps Consultant" go through the lexicon at 0.85), and of two one-word phrases with the same score the later one wins ("Physician Recruiter" is a recruiter).
5. **An alone-only word that is the whole title scores 0.85, not 1** ("PM", "Controller", 行政 are ambiguous even alone). Head nouns alone keep the full score, as the item says.
6. **Chinese:** 开发 / 研发 before 工程师 are filler (前端研发工程师 is the front-end role, at a 5% discount so 测试开发工程师 keeps its exact name); a mixed title closing on a Chinese head word in either script ("Machine Learning 工程師") is read with the English head noun; an English phrase inside a mixed title needs whole words.
7. **The matcher does not fold Traditional Chinese itself.** `features/boundary.test.ts` forbids `jobs/taxonomy` importing `jobs/normalize/zhVariants.ts`. The fold lives in `enrich/titleEvidence.ts`, which enrichment, the candidates and the backfill use; ingest folds on its own as before.
8. Results are cached for the last 4,096 titles. Uncached it runs at 0.19 ms per title against 0.23 ms on the base commit.

### 2. [P0] Enrichment may override a role scored under 0.9; the score is stored: done

- `enrich/titleEvidence.ts`: `titleReadings`, `titleMatches`, `titleEvidence` (best match over the title as written and its mainland reading), `titleIsDecisive` (score ≥ 0.9), `heldByRetiredWord`, `roleFromTitle` (the one ruling enrichment and the backfill share).
- `reconcile.ts`: the role is decided in this order: a decisive title names it on every pass, rules-only included; else the model's pick when it is one of the candidates; else a held role that only the retired one-word match explains gives way to what the title says today (or is removed when it says nothing); else the row keeps what it holds. `update.titleMatchScore` is written on every pass. `ReconcileReport.taxonomyOverridden: { from, to, by: 'model' | 'title' } | null`. An id outside the candidates still sets `taxonomyRejected`.
- `needsLlm`: reason `weak_title_match` when the title is not decisive, including a title with no match at all.
- `candidates.ts`: deterministic matches, the role the row holds (new optional 4th argument `held`), the roles the lexicon connects to the title's modifiers, then the rest of the head noun's roles when they fit in two thirds of the list (true for `architect` and `technician`; not for `engineer` with 61 roles, where "every role the lexicon lists" cannot fit in 15), then keyword overlap.
- `repository.ts`: `JOB_SELECT` gains `titleMatchScore` and `companyId`; `toJobUpdateData` writes `titleMatchScore`. `schema.ts`: `ENRICH_VERSION` 1 → 2. `service.ts`: passes the held role to the candidates; logs `taxonomyOverridden` on the model path with the existing line and on a rules-only pass with its own line.
- **Acceptance:** all four lines hold (reconcile and service tests).
- **Tests:** `reconcile.test.ts` 29, `candidates.test.ts` 12, `repository.test.ts` 9, `service.test.ts` 31 (mocked `EnrichLlm`), `titleEvidence.test.ts` 6, `index.test.ts` 3.
- **Expected model calls of the version bump.** jobs-maintain re-queues every live row with `enrichVersion < 2`. Upper bound: one call per live row, 1,847 on the clone index (all `intl`), zero for `cn` (no rows). My estimate is 1,400 to 1,500, inside one day of the default budget (`ENRICH_DAILY_JOBS` 8,000 per market). This is arithmetic on the figures of SEARCH_RETRIEVE_MATCH 3.1, not a measurement: I did not query the database.
- Also fixed, in a file I own: `enrich/index.ts` imported `service.js` before `agent.js`, so a process whose first feature import was the enrichment index died with "Cannot access 'CN_DOMESTIC_PROVIDERS' before initialization" (true on the base commit). Order swapped, with a test.

### 3. [P0] Labelled title sets and the 95% gate: done

- `taxonomy/__fixtures__/labelledTitles.intl.json` and `.cn.json`: 300 rows each, a bare JSON array of `{ title, categoryId, roleId, note? }`. SYNTHETIC: written by me from the role tree and common posting vocabulary, nothing copied.
- After the review, 14 `cn` rows and 8 `intl` rows of over-represented roles were replaced by the hard cases the review found (the count stays 300): the 行政 / 新媒体 / 法律顾问 / 运营专员 titles, the five "<X>开发工程师" titles, "Software Engineer, Payments" and its three siblings, "Lead Software Engineer", and the three half-phrase titles labelled unknown.
- `taxonomy/precision.test.ts` (18 tests): shape and ids; category precision ≥ 0.95 per market (misses are printed); the same gate on the raw title and in ingest's order; every head-noun row that is filed is filed right; every head noun appears in three categories and alone; no row labelled unknown is forced into a category; at least 90% of labelled rows are filed; the titles filed under a wrong role inside the right category are pinned by name.
- **Result:** `intl` 249 of 250 filed titles in the right category (99.6%), 250 of 264 labelled rows filed, 239 of 240 roles right. `cn` 264 of 266 (99.2%), 266 of 277 filed, 263 of 264 roles right.
- Known misses kept in the sets on purpose: "Hotel Front Desk Agent" and 酒店前台 (filed as office reception, not hospitality), 达人运营 (filed under creators). Role misses: "Sales Developer Representative" (account executive, not SDR), 游戏客户端开发工程师 (mobile, not game developer).
- The labels are mine, not a recruiter's.

### 4. [P1] Backfill: done

`server/src/features/jobs/backfill/`: `rematchRoles.ts`, `clearImplausiblePay.ts`, `run.ts`, `backfill.test.ts` (14 tests, fake db and fake queue).

```
npx tsx server/src/features/jobs/backfill/run.ts rematch-roles --market intl|cn [--apply] [--limit n]
npx tsx server/src/features/jobs/backfill/run.ts clear-implausible-pay --market intl|cn [--apply] [--limit n]
```

Without `--apply` it prints the counts and 20 sample changes and writes nothing. I ran neither task against any database (only the usage error path).

- **rematch-roles:** live rows (canonical, not archived) in keyset pages of 500 by id. Writes `titleMatchScore`; a decisive title moves the row to the role it names; any other title queues `job.enrich`, unless a model already decided the row's role at the current version and this run leaves the role as it is (counted as `decidedByModel`). Every change is reported as `{ jobId, from, to, score }` plus the action.
- **clear-implausible-pay:** non-archived rows with a figure that `payPlausible` refuses get `salaryMin`, `salaryMax`, `salaryAnnualMin`, `salaryAnnualMax` null and `salaryDisclosed` false; `salaryText`, currency and period stay. A second run finds nothing.
- **Acceptance:** dry run writes nothing; with `--apply` the "Java Backend Architect" row leaves the design category, a weak match is queued and not changed, the "$60,000,000 an hour" row ends undisclosed with its words kept; a second `--apply` changes nothing and queues nothing new.

Two points where the item could not be followed as written:

1. **Items 2 and 4 contradict each other on "Java Backend Architect".** Item 2 needs its score under 0.9; item 4 moves it on `--apply`, which its own rule allows only at 0.9 or more. Resolved with one extra rule, shared with enrichment (`roleFromTitle`): a stored role that only the retired one-word match explains is replaced by the role the title names today, or removed when it names none ("Principal Engineer" under school principals becomes unknown), and the row is still queued so the model has the last word. A weak match against any other stored role is left alone and queued.
2. **Queue keys.** A row still at an older `ENRICH_VERSION` gets the standard item (same dedupe key as jobs-maintain, no force), so it costs one model call, not two. A row already at the current version gets the forced item `job.enrich:<id>:v2:rematch-v2` (`enqueueJobRematch`, `REMATCH_GENERATION` in `enrich/index.ts`, `onConflict: 'keep'`), and only when no model has ruled on it yet or its role changed in this run.

Country-only locations: no change, as the item says.

### 5. [P1] Company industries: done

- `enrich/schema.ts`: `industry: { value, quote } | null`; the value must be an id of `ONBOARDING_INDUSTRIES` (case-insensitive, or its slug), a quote is required, anything else parses to null. `agent.ts`: the prompt asks for it only when the posting says what the employer does, with the closed list, the quote rule, and now "never from a line about a recruiter's client" and "a bank is not Fintech unless the posting says so".
- `quotes.ts` `reconcileIndustry` (new, see Review resolution 3): in the posting; more than the employer's name; not about a client; on the topic of the claimed industry outside the employer's name. Drop reasons in `report.droppedQuotes`: `industry`, `industry:company_name_only`, `industry:client`, `industry:off_topic`. Returned beside the update as `companyIndustry`.
- `companies/service.ts` `setIndustryFromPosting(db, companyId, { industry, sourceUrl, at })` with the three rules of the item, plus: a staffing agency (`isAgency`) is never changed. The first write is conditional on the row still having no industry. `companies/index.ts` `recordPostingIndustry` runs it on the application database.
- `companies/industryMap.ts`: `INDUSTRY_IDS`, `industryIdFor`, `mapIndustries` (exact, case-insensitive label or slug; an unmapped value is kept). `upsertCompanies` maps incoming provider and bank industries through it. Re-exported from `companies/contract.ts`.
- `enrich/service.ts`: optional `EnrichDeps.setCompanyIndustry`, called once after `saveJob`. A failed company write is logged and does not fail the job.
- **Departure:** a user's own import (private job) never writes a company industry.
- **Acceptance:** met for the three write rules and the quote rule. The last line (a scored industry dimension) follows from the data: both sides now hold the same ids. I did not write a test against `match/preScore.ts`, which MKT-1F is rewriting in this phase.
- **Tests:** `schema.test.ts` 9, `quotes.test.ts` 25 (six on the industry quote), `reconcile.test.ts` (three industry tests), `companies.test.ts` 24, `service.test.ts` (four industry tests), `agent.test.ts` 14.

### 6. [P1] Provider query labels: done

`taxonomy/queryLabels.ts`: `providerQueryLabels(roleId, { market, country })` → `Array<{ text, language: 'en' | 'zh-TW' | 'zh-CN' }>`, exported from `taxonomy/index.ts` with `queryLabelsFor`, `MAX_QUERY_SYNONYMS` and the two types. Matches the contract in MARKET_TASK_PLAN.

- `providerQueryLabels('backend_engineer', { market: 'cn' })` → 后端开发工程师, 后端, 服务端. `intl` → "Backend engineer", "backend developer", "server engineer". Taiwan adds one `zh-TW` item once `taxonomyLabel(id, 'zh-TW')` returns a Traditional label and none before; the Simplified label is never read for Taiwan. Unknown ids, categories and groups return `[]`.
- **Departures from "shortest first":** synonyms are ordered by fewest words, then the order of the data file. Left out: abbreviations of three letters or fewer, the whole-title-only words in both languages ("pm", 新媒体) and a synonym that is the label plus a level word. A label that joins two names ("Chef or cook") is replaced by a third synonym.
- **Tests:** `queryLabels.test.ts` (9 tests) over all 230 roles, with the glossary check of `scripts/check-zh-variants.mjs` as the Simplified-wording test for `zh-TW` items.

## Files changed

Modified:
- `server/src/features/jobs/taxonomy/match.ts`, `match.test.ts`, `index.ts`, `taxonomy.v1.json`
- `server/src/features/jobs/enrich/reconcile.ts`, `candidates.ts`, `repository.ts`, `schema.ts`, `agent.ts`, `service.ts`, `index.ts`, `quotes.ts`, `__tests__/fixtures.ts` and the tests `reconcile`, `candidates`, `repository`, `schema`, `agent`, `service`, `quotes`
- `server/src/features/jobs/companies/service.ts`, `index.ts`, `contract.ts`, `companies.test.ts`

New:
- `server/src/features/jobs/taxonomy/queryLabels.ts`, `queryLabels.test.ts`, `idsFrozen.test.ts`, `precision.test.ts`, `__fixtures__/labelledTitles.intl.json`, `__fixtures__/labelledTitles.cn.json`
- `server/src/features/jobs/enrich/titleEvidence.ts`, `titleEvidence.test.ts`, `index.test.ts`
- `server/src/features/jobs/companies/industryMap.ts`
- `server/src/features/jobs/backfill/rematchRoles.ts`, `clearImplausiblePay.ts`, `run.ts`, `backfill.test.ts`

Outside the worktree: only this handoff file. Read-only: the base-commit matcher in the clone worktree (for the differential probes) and MKT-1D's `eval/suites/taxonomy.suite.ts` (fixture shape).

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/jobs/taxonomy server/src/features/jobs/enrich server/src/features/jobs/companies server/src/features/jobs/backfill` | 20 files, 547 passed |
| `npm run typecheck:server` | pass |
| `npx next typegen && npm run typecheck:web` | pass |
| `npm run check` | pass (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 651 files; 14,618 passed, 1 skipped, 10 todo; 0 failed |

Not run: `npm run eval:match` (MKT-1D's harness is not in this worktree). The taxonomy suite's computation is reproduced in `precision.test.ts` in the harness's own order (raw title, else its mainland reading).

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

1. **Orchestrator, at the M1 gate (`ingest/upsert.ts` has no owner before MKT-3C in M3; `normalize/types.ts` and `normalizeProviderJob.ts` are MKT-1C's in M1). Without this a model override lasts only until the posting is next listed, and item 2 pays for calls whose result is lost.** `upsert.ts` rewrites the role on every refresh whenever ingest has any match, however weak, and the row is not enriched again because it already carries the current version.
   - `normalize/types.ts`, `NormalizedJob`: add `titleMatchScore: number | null`.
   - `normalize/normalizeProviderJob.ts`, `taxonomyIdsForTitle`: return `score` and take the better of the two readings (today the mainland reading is tried only when the raw title matches nothing; 前端工程師 scores 0.7 raw and 1.0 folded):
     ```ts
     const raw = bestTaxonomyMatch(title);
     const folded = /[㐀-鿿]/.test(title) ? bestTaxonomyMatch(foldTwToCn(title)) : null;
     const match = folded && (!raw || folded.score > raw.score) ? folded : raw;
     if (!match) return { ids: [], primary: null, score: null };
     return { ids: taxonomyAncestors(match.id).map((n) => n.id).reverse(), primary: match.id, score: match.score };
     ```
     and set `titleMatchScore: tax.score` on the returned job.
   - `ingest/upsert.ts`: add `titleMatchScore` to `JobUpsertRow`, `UPSERT_COLUMNS`, the row builder, `valuesTuple` (`${r.titleMatchScore}::real`) and the INSERT column list; in ON CONFLICT replace the two role lines with:
     ```sql
     "taxonomyIds" = CASE
       WHEN cardinality(EXCLUDED."taxonomyIds") = 0 THEN "RAJob"."taxonomyIds"
       WHEN "RAJob"."enrichedAt" IS NULL OR cardinality("RAJob"."taxonomyIds") = 0 OR EXCLUDED."titleMatchScore" >= 0.9::real THEN EXCLUDED."taxonomyIds"
       ELSE "RAJob"."taxonomyIds" END,
     "primaryTaxonomyId" = CASE
       WHEN EXCLUDED."primaryTaxonomyId" IS NULL THEN "RAJob"."primaryTaxonomyId"
       WHEN "RAJob"."enrichedAt" IS NULL OR cardinality("RAJob"."taxonomyIds") = 0 OR EXCLUDED."titleMatchScore" >= 0.9::real THEN EXCLUDED."primaryTaxonomyId"
       ELSE "RAJob"."primaryTaxonomyId" END,
     "titleMatchScore" = EXCLUDED."titleMatchScore",
     ```
     The column is `Float? @db.Real`: write `0.9::real`, never a bare `0.9` (a stored 0.9 reads back as 0.89999998 and would fail the comparison). `upsert.test.ts` holds the SQL snapshot.
   - One case this leaves open: a row a model cleared to unknown (`taxonomyIds` empty after "Principal Engineer") takes ingest's next match, which is right, since ingest runs the same matcher and would also say unknown.
2. **MKT-1C / MKT-3C, `normalize/zhVariants.ts`.** `foldTwToCn` lacks common title characters (內, 顧, 問, 講, 廚, 術, 門), so 室內設計師 and 顧問 stay unknown; `features/onboarding/zhFold.ts` holds a second, fuller table. One table should serve both.
3. **MKT-3E (Taiwan open data).** A role mapped from a provider's occupation code carries no stored marker, so enrichment treats it like any role: the model may overrule it when the title is not decisive. If official codes must win, the row needs to say where its role came from (see Schema requests), and `roleFromTitle` is the one place to honour it.
4. **MKT-3B (planner).** `providerQueryLabels` is ready as specified in MARKET_TASK_PLAN. It returns up to three texts per language and drops three-letter abbreviations and whole-title-only words.
5. **MKT-2H and MKT-4D (next owners of `enrich/`).** `reconcile()` returns `{ update, report, companyIndustry }`; `EnrichDeps.setCompanyIndustry` is optional; `selectTaxonomyCandidates` takes the held role as a 4th argument; title evidence lives in `titleEvidence.ts`; the industry quote rule is `quotes.ts` `reconcileIndustry`. Keep `agent.js` imported before `service.js` in `enrich/index.ts` (a test guards it).
6. **Orchestrator / owner, after the M1 deploy.** Run `clear-implausible-pay` per market as a dry run, read it, then `--apply`: it does not depend on anything else. Run `rematch-roles` as a dry run at any time, but **`--apply` only after Request 1 has landed**: before that, the roles its queued model calls decide are put back by the next ingest refresh. `--apply` makes no model call itself; it queues work items that the queue drains inside the daily budget, and it skips rows a model already decided.
7. **MKT-1F and any reader of `RAJob.titleMatchScore`.** It is a 4-byte float: compare with `>= 0.9::real` in SQL, or with a small tolerance in TypeScript, never with a bare 0.9. Enrichment and the backfill work the score out again from the title and do not read the column.
8. **MKT-1G / orchestrator (documents):** ARCHITECTURE.md §4.5 still says the deterministic taxonomy always wins and the skip rule has three conditions. It should state the 0.9 rule, `titleMatchScore`, the `weak_title_match` reason and the industry field with its quote rule.
9. **MKT-1D (owner of `package.json`), optional:** script aliases `backfill:roles` and `backfill:pay` for the two commands above.
10. **Carry-over item 1 (`'linkedin'` literal) names `companies/service.ts`: left as it is.** The `API_BOARDS` set there is plain strings used to label stored rows whose `sourceBoard` is `linkedin`; it does not reference the `JobProvider` union, so it does not block removing the literal, and dropping the entry would relabel stored LinkedIn rows as employer boards. The removal itself is JI-2 (MKT-3B).

## Schema requests

None required. Optional, additive, for request 3 and to replace the retired-word heuristic of the backfill with a stored fact:

```prisma
// ra-jobs.prisma, model RAJob
/// Who set the role: 'title' (deterministic match), 'model' (enrichment), 'provider' (an occupation code of the source).
taxonomySource String?
```

## Env variables added or redefined

None.

## i18n keys added or changed

None. The bundle has no namespace and adds no user-facing copy; industry ids are data from the existing closed list.

## Known gaps

- **Until Request 1 lands, a model's role override does not persist on a posting its provider lists again**, and the version bump still pays for those calls (jobs-maintain re-enriches at deploy whatever the backfill does). This is the one open point that touches the purpose of item 2.
- The labelled sets are engineer-written and synthetic. GoApply relevance on a real mainland corpus is still unmeasured (strategy 2.5).
- The "a later phrase wins" rule for Chinese titles reads "A兼B" and "A/B" titles (会计兼出纳) as B. Neither reading is right for a double role; both score under 0.9, so the model decides.
- A head noun or an alone-only word after "Associate" is unknown ("Associate Architect", "Associate PM"): "associate" is not a level word because it is part of role names ("clinical research associate", "sales associate").
- "<X>研发工程师" with an X the tree does not know (系统研发工程师) is unknown at ingest, and the backfill removes a stored software role from such a row before queuing the model. The review asked for this; for mainland internet employers it will often be a software job, which the model pass restores.
- The industry cues are narrow by design. A hospital, a bank, a law firm or a general "energy" company gets no industry rather than a near one, so the industry dimension stays "not stated" for many employers. A posting that states its business in words outside the cue lists is dropped as `industry:off_topic` (logged, so the lists can be widened from real drops).
- The raw `matchTitle` does not read Traditional Chinese. Callers outside ingest, enrichment and the backfill (feed title filters, the estimate, SEO paths) behave as before for Taiwan titles; MKT-3E's Traditional labels are the real fix.
- A provider-mapped role can be overruled by the model (request 3).
- Candidate selection by description overlap is as coarse as before; only the title side improved.
- The model-call figure for the version bump is an estimate from the research note, not a measurement.
