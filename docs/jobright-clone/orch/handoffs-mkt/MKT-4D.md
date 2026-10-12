# MKT-4D

Enrichment v3: canonical skill ids at write time, honest keywords, requirement lines extracted once per posting, the sponsorship source, nearest roles by title embedding (SM-6 write path, SM-8 job side, SM-2, JI-11). Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4D`, branch `wp/MKT-4D`. Nothing was committed. No command reached a database, a model, an embeddings endpoint or the network. Every edit is inside `server/src/features/jobs/enrich/`.

All six items are done. No item was rejected. This is the handoff after the independent review: all eight findings were real (each reproduced before it was changed), all eight are resolved, and none was rejected. Two of them (findings 2 and 4) are seams with a sibling bundle: my side is built, and the one change each needs in a file I do not own is under Requests, marked **merge-time**. The list is at the end, under "Review resolution".

Where I chose between two readings the choice is marked **Decision** under its item; please confirm or reject them.

**Where the documents win over an item.** Item 3 says the stored requirement list carries `contentHash: jobContentHash(job)`. That hash reads `RAJob.skills`, and ingest writes the provider's skill list back over the row on every refresh, so a list keyed that way is thrown away at the next refresh and extracted again inside a scoring call. MARKET_STRATEGY 2.3 step 7 says "requirements extracted once per job". The strategy wins: the key is the hash of the posting's title and requirement text with no skills (item 3, Decision (a)). Two other statements of the items do not match the code as built and are noted where they occur: 230 roles a model may be offered, not 307; jobs-maintain re-queues oldest enrichment first, not newest first.

## Items

### 1. [P0] Skills are written with canonical ids: done

What changed:

- `skills.ts` (new). The vocabulary port of enrichment: `vocabulary()`, `canonicalize(terms, { brand, write, requestId })` (one call per job), `countMentions(ids)`; `buildSkillMap(terms, results, vocabulary)` gives the map `term -> { skillId, kind, status, via, labels }` that reconcile reads. The default port (`createEnrichSkillsPort`) wires `canonicalizeMany` of `features/skills` with `embed = embedTexts(brand, texts, { purpose: 'skill', carriesUserData: false })`, and `nearest` and `create` of `skillStoreDeps(db, { model: resolveEmbeddingConfig(brand, env).modelTag })`. The skills area, the embeddings client and the database are imported on first use.
- `reconcile.ts` stays pure. Sources in order: the row's own strings (the provider field), entries an earlier pass stored (with their other spellings), then the model's strings that the posting names (`skillGrounded` unchanged). Two spellings with one id are one `skillsDetail` entry. `SkillDetail = { skill, kind, required, skillId, via, also? }`. `update.skillIds` = ids of hard skills and certifications, required first, at most 25. `update.skills` keeps every display string (both spellings stay searchable). A soft skill stays in `skillsDetail` and is never in `skillIds`. The vocabulary's kind wins when the skill is reviewed. Exports: `skillTermsOf` (the strings sent to the vocabulary: grounded ones only, so nothing is created for a string the posting does not name), `keywordSkillsOf`, `heldSkillIds`, `reconcileSkillColumns`.
- `service.ts`: `mapSkills` runs once per job on a model pass and on a rules-only pass, so a row that needs no model gets its ids too. `countMentions` after the row is saved. `remapSkills`: the skills-only pass (Decision (k)).
- `repository.ts`: `skillIds` is selected and written (`{ set }`).
- `schema.ts`, `index.ts`: the work-item payload takes `skillsOnly`; `enqueueJobSkillRemap(jobId, { generation, market })` and `skillRemapDedupeKey` are exported for the producer.

ACCEPT, each a test: "postgres", "PostgreSQL" and "communication" end as one PostgreSQL entry with `skillId: 'postgresql'`, `skillIds: ['postgresql']`, and `skills` holding both spellings; an unknown skill is stored as an unreviewed skill and shown; with no embedding key the alias path still fills ids; a string the posting does not name is not stored and never reaches the vocabulary.

**Decisions.**

- (a) **A user's own import is mapped by exact alias only.** Nothing of an import is embedded, no skill is created from it and it counts no mention. Reasons: an import is enriched inside its request (`jobs/import/service.ts` calls `enrichJob` inline), its text is its owner's data, and the vocabulary is shared by everyone (the rule the company industry already follows in this file). It also makes invariant I8 hold on every path: no import makes an embedding call, with or without the AI consent.
- (b) **When the embedding step cannot decide, only the exact-alias step counts and nothing is created.** That is the item's rule for "client unavailable" (no key, policy, budget), and I apply it also to a failed call, to a skills-table error, and to a table that holds no label vector for the model in use (`embed-labels` has not run: every unknown string would otherwise become an unreviewed copy of a skill the vocabulary already has). The last case is detected by the first neighbour query that answers nothing (the query has no threshold, so an empty answer means no label vector for that model), logs one warning per process and model, and **pauses the embedding step for that model for five minutes** (`LABEL_VECTOR_RETRY_MS`): a table without vectors costs one embedding request per pause, not one per job.
- (c) **Carry-over M2.2 (a throwing `embed`): enrichment finishes.** `{ unavailable }` and a thrown `EmbeddingsError` both end in the exact-alias answer. Reason: by then the model call is paid for, and a retried work item would pay for it again. The warning carries the request id of the work item (`job-enrich-<work item id>`) and the number of strings asked. A skill that was stored before a skills-table error part of the way is still answered as created (`via: 'new'`), so its first posting is not counted a second time.
- (d) **Carry-over M2.5a: `learn` is not passed.** A string mapped by an embedding neighbour is stored on the row with `via: 'embedding'`, and the alias is not written to `RASkill`, because the table cannot tell a learned alias from a reviewed one and `export-seed` would carry it into the committed seed. `canonicalizeMany` still puts the alias into the loaded vocabulary. So the port remembers, per loaded vocabulary, which keys it guessed, and while that vocabulary is in use: its answer for such a key stays `via: 'embedding'`, and the vocabulary it hands to the keyword list does not know the key (Decision (l)). A reloaded vocabulary (every ten minutes) has no such alias unless a reviewer stored it, and then it is a reviewed alias like any other. Cost: the same string is embedded again in another process or after a reload. The proper fix is in `features/skills` (Requests).
- (e) `required` and `kind` of this pass's model replace what an earlier pass stored (a forced pass is the newer reading of a changed posting). A skill is required when the model says so under any of its spellings. A stored entry the model does not list keeps what it said.
- (f) A string a reviewer ruled is not a skill (`isDropped`) is not stored at all, whoever listed it.
- (g) A mention is counted once per posting: only ids the row did not hold before, never a skill created on this pass (`create` already counts one).
- (h) `skillsDetail[].kind` can now be `'certification'`. Every reader I found treats anything but `'soft'` as hard (`match/preScore.ts`, `match/context.ts`, `jobs/detail/view.ts`, `retrieval/jobText.ts`, `feed/types.ts`).
- (i) `skillIds` carries unreviewed ids too (kind hard). A reader scores a skill only when `reviewed(id)` holds, so a later review takes effect without a re-enrichment.
- (j) **`also`: an entry names its other spellings.** `RAJob.skills` keeps every spelling and `skillsDetail` has one entry per skill, so a reader that lists a posting's skills from both would take "postgres" for a second skill and "team player" (an alias of the soft skill Teamwork) for a hard one. The entry therefore carries `also: ['postgres']` (absent when there is none): every string of `skills` is spoken for by one entry, without asking a vocabulary. That also covers a spelling only an embedding neighbour mapped, which the reader's own vocabulary cannot fold. An entry is marked a guess (`via: 'embedding'`) only when no spelling of it is a name the vocabulary knows. The readers are not mine (Requests).
- (k) **The skills-only pass.** A row is enriched once per version. A row mapped while the embedding step was off (no key yet, or `embed-labels` not run) is stamped version 3 and jobs-maintain never queues it again, so its unknown strings would keep no id until version 4. `{ jobId, skillsOnly: true }` is the way back: it maps the row's strings again, writes `skills`, `skillsDetail`, `skillIds`, `searchText` and the keyword row, counts the new mentions and queues `job.index`. No model call, no enrichment budget, no market hook, no other column (the version stamp, `enrichedAt`, `enrichModel`, the requirement list and the tags stay). When nothing changed the job row is not saved and nothing is indexed (the keyword row is rewritten either way, because it follows the vocabulary too). When the vocabulary cannot be asked the row keeps its ids. A row that is not at the current version gets the full pass instead. The keyword row keeps the model and the cost of the pass that paid for it. The producer is a Request to MKT-5C.
- (l) **A machine guess is never a name of the skill inside enrichment.** The vocabulary `vocabulary()` returns answers `idOf` with null for a guessed key, and `idsInText` finds a skill only where the text writes one of its other names. So another posting whose text happens to contain the guessed string gets no keyword from it. A caller that reads `features/skills` directly is not covered (Requests).

Tests: `reconcile.test.ts` (ids, kinds, required first, soft excluded, cap 25, dropped strings, machine guess, rules-only pass, `also`, the skill columns alone), `skills.test.ts` (15: the default port with a fake embeddings module and a fake database: the pause, the partial failure, the guesses), `service.test.ts` (one vocabulary call per job, imports, the real port with no key, failures, the skills-only pass), `workers.test.ts`, `index.test.ts`, `repository.test.ts`.

### 2. [P0] Keywords: only concrete, canonical terms: done

`keywords.ts` `buildKeywords(text, skills, vocabulary, limit)`:

- (a) a skill of the posting with a canonical id whose kind is hard or certification: `high` when required, `medium` otherwise;
- (b) a term of the text that names a reviewed hard skill or certification: `low`;
- everything else is dropped. `JobKeyword` gains `skillId`; one skill is one keyword.

`ZH_STOPWORDS` gained the requirement and preference wording and the generic qualities the item names, and the two-character halves the word segmenter cuts them into (相关经验 arrives as 相关 and 经验).

ACCEPT, each a test: the "Senior Backend Engineer" fixture gives python, postgres, sql, kafka, distributed systems, kubernetes, rest apis, each with a `skillId`, and none of "communication", "shared backend systems", "fast-paced", "software engineering", "go", "rest"; the Chinese fixture gives sql, 注册会计师, python, mysql, 数据分析, 机器学习, 分布式系统, 教师资格证 and no boilerplate; no skill appears twice.

**Decisions.**

- (a) An unreviewed skill the posting lists IS a keyword (it has a canonical id, as the item says). An unreviewed term found only in the text is not. Reason: the reader decides at read time with `reviewed(id)`, so a review decision takes effect without a model call. The cost: a generic word a model lists as a hard skill stays in the row until a reviewer drops it.
- (b) A text term is resolved with the vocabulary's own rule for words taken from a sentence (`skillIdsInText`), not with a bare `idOf`. Checked against the committed seed: a bare `idOf` reads "go" as Go, "rest" as REST and "work day" as Workday, so "go the extra mile" would put Go into the keyword check.
- (c) After the TF-IDF terms the builder adds the names those terms cannot hold, found by the same scan of the whole text: several words written once ("REST APIs"), and Chinese names the segmenter cuts in two (机器学习 arrives as 机器 and 学习). Without this a mainland posting yields its Latin tool names only. Still no model and no embedding call.
- (d) Without a vocabulary the stored keyword row is left as it is (an empty list written over a good one would be a loss).
- (e) **A machine guess is never a keyword.** A listed skill whose id came from an embedding neighbour (`via: 'embedding'`) is shown on the card from `skillsDetail` and is left out of the keyword row: the keyword check says "not in your resume" about its terms, and nothing may say that on the strength of a guess. When the text also writes a name the vocabulary knows, the skill is a keyword of the text (`low`), as for any posting.

Tests: `keywords.test.ts` (21), `service.test.ts`, `skills.test.ts`.

### 3. [P0] Requirement lines are extracted once per posting: done

- `schema.ts`: `requirements: [{ kind, text, importance }]`, parsed per item (a bad item is dropped), text at most 240 characters, an unclear importance is `preferred`, at most `ENRICH_REQUIREMENTS_MAX` (12).
- `agent.ts`: the prompt asks for the lines copied verbatim, one line each, never paraphrased, shortened, joined or split; says what is a must; leaves out location, pay, benefits, hours, visa and age. `maxTokens` 1500 to 3000 (`ENRICH_MAX_OUTPUT_TOKENS`): a reply cut off in the middle is not JSON.
- `reconcile.ts`: an item is kept only when it is a substring of the posting after `normalizeForQuote`; duplicates dropped; ids r1…rN in posting order; `update.requirements = { v: 1, contentHash, model, extractedAt, items }`. A rules-only pass writes none.
- `repository.ts`: `requirements` is selected and written.
- GoApply: 届别 and 学历 lines are requirements of kind education. The applicant's age is never part of a requirement; the posting's sentence is recorded as the market tag `age_limit_stated` (`ageLimit.ts`, new, by rule, so also on a rules-only pass). The tag is written for `market = 'cn'` only and is no input of any score or filter.

ACCEPT, each a test: "5+ years building backend services" and "Nice to have: Kubernetes" give two items with those texts, kinds experience and skill, importance must and preferred; a line that is not in the posting is dropped and counted (`report.requirements.notInPosting`, in the log line); a second pass over the same posting keeps the stored list; an age line gives the tag and no requirement.

**Decisions.**

- (a) **The key of a stored list is the posting's text, without its skill strings**: `contentHash = jobContentHash(requirementsHashRow(job))`, that is `{ title, qualifications, descriptionPlain, skills: [] }` (`requirementsHashRow` is exported from `jobs/enrich/index.ts`). It is therefore NOT `RAJob.contentHash`. Reasons: the lines are copied from the text and do not depend on the skill strings; `RAJob.skills` changes without the text changing (enrichment adds the skills the posting names, and ingest writes the provider's list back at the next refresh, `ingest/upsert.ts`); with the skills in the key, two people scored on either side of a refresh would be judged against different lists. Tested: a pass that adds a skill, a refresh that resets the list and a changed provider list all leave the stored list alone, on a model pass and on a rules-only pass; an edited text gets a new one. **The scorer must compute the same key: one line in MKT-4G's `MatchService.ts`, a merge-time Request.**
- (b) **First writer wins is enforced in the write.** `saveJob` writes `requirements` in a second statement that matches only while the row's list is still what enrichment read (`requirementsWhere`: `IS NULL`, or the same `contentHash`). A list the scorer stored while the model call ran is not overwritten.
- (c) A list of an earlier text is removed when this pass has none of its own (a rules-only pass on a changed posting, or a model that returned no line of the posting), so the scorer extracts anew.
- (d) **Work authorization.** A line about the applicant's own right to work is dropped as logistics by rule, as a backstop to the prompt. Wording about the applicant's status ("authorized to work", "require sponsorship", "we do not offer sponsorship") always is. The bare subject ("work authorization", "visa sponsorship", 工作签证, 工作许可) is logistics unless the line asks for skill in that work ("Experience with visa sponsorship processes", "Knowledge of employment authorization rules", 熟悉外籍员工工作许可办理流程, 负责外籍员工工作签证的办理): those stay requirements, as HR, mobility and immigration roles need. 办理 or 申请 alone do not make it the work: "公司可协助办理工作签证" is what an employer offers.
- (e) **Whose age: positive evidence only** (`ageLimit.ts`, rewritten after the review). A line is read clause by clause (cut at ， , ； ; 、 。). A clause may hold an age bound (a cap, a range, a lower bound, a birth-year bound; ages are two digits). The bound is the applicant's only when (1) the clause says so: 年龄 leads to it (not "用户年龄", "学员年龄", "服务对象年龄"; "招聘对象年龄" does), or in English "must be", "should be", "applicants", "candidates" lead to it, or it is labelled ("maximum age of 40", "age limit: 35"); or (2) the clause holds nothing but the bound, a heading, a gender note or "preferred" aside ("35周岁以下", "女性25-35岁", "Aged 22-35"), and nothing earlier in the sentence introduces an audience ("目标人群：大学生、18-35岁" is not a limit). A bound inside a longer clause with neither is left alone. So the ages of the people a job serves ("负责18-35岁女性护肤产品的市场推广", "产品主要面向35岁以下白领", "Experience caring for adults 65 and older") and a production year ("2018年以后生产的数控设备") are neither flagged nor dropped. I chose this over a longer list of audience words because such a list is never complete and cuts both ways: with 女性 on it, "女性，35岁以下" would no longer be flagged.
- (f) **A line that states an age and something else keeps the something else.** "年龄25-35岁，大专及以上学历，3年以上机械维修经验" is stored as "大专及以上学历，3年以上机械维修经验": the age clause is taken out, and each remaining run of the line is an item, still a verbatim piece of the posting. An age clause in the middle leaves two items. A leftover that says nothing ("男女不限", "Applicants", a list number) is not an item. `report.requirements.age` counts only lines that are about age and nothing else.
- (g) A line about the legal working age ("must be 18 or older", 年满18周岁) is an age clause (taken out of a requirement) and is not flagged as an age limit.

Tests: `schema.test.ts`, `reconcile.test.ts`, `agent.test.ts`, `repository.test.ts`, `ageLimit.test.ts` (8), `service.test.ts`, `index.test.ts`.

### 4. [P1] Version bump, gradual re-enrichment and re-index: done

- `ENRICH_VERSION` 2 to 3. The work-item key becomes `job.enrich:<id>:v3`.
- A row at version 2 is enriched again without `force`; at version 3 the same item answers `already_enriched`. `job.index` is queued once per finished enrichment (the MKT-2H hook is kept, tested on both paths).
- One log line per finished enrichment: `JOB_ENRICH enrichment finished { jobId, market, outcome, model, skills: { canonical, unreviewed, dropped }, skillIds, requirements, requirementsStored }`. A skills-only pass logs `JOB_ENRICH skills mapped again { jobId, market, changed, skills, skillIds }`.
- The budget default is unchanged.

**Order of the rollout (binding for the result, see Requests to the owner).** The version-3 pass maps each row once. Set the embedding key and run the skills CLI `embed-labels` on a database BEFORE the version-3 code runs there with jobs-maintain enabled. If the pass starts first, every row it touches gets ids for the seed skills only (273 today), no unreviewed skill is created and no mention is counted, so the review list SM-6 depends on stays empty for those rows. That is recoverable without a model call (the skills-only pass, item 1 (k)) once MKT-5C queues it, and not before.

**Expected model calls** (arithmetic, not a measurement: I did not query a database):

- Upper bound: one call per live row of a market. SEARCH_RETRIEVE_MATCH 3.1 counted 1,847 live rows on the clone index, all `intl`, none `cn`. The rows the M3 employer boards added since are not in that figure.
- In practice fewer. A row whose earlier pass completed taxonomy, seniority and five skills, whose title names its role and whose text has no visa, citizenship or clearance wording finishes rules-only (`needsLlm` is unchanged). It still gets its `skillIds` and keywords; its requirement list comes from the scorer's first call.
- **The pace is set by jobs-maintain, not by the model budget.** It queues at most 500 rows per run and market (`ENRICH_REQUEUE_PER_RUN`, daily at 03:30), so 1,847 rows take about four days; `ENRICH_DAILY_JOBS` (8,000 per market) is not reached. Raise the 500 if the owner wants it faster.
- A call's output is longer (up to 12 requirement lines), so a call costs more than at version 2.
- Embedding requests, public postings only: one per job that has a string no alias knows (none while the label vectors are missing, but for one request per five minutes), one per job with a weak title, and the role labels once per process and brand (460 short labels). A skills-only pass makes at most one.

**Does not match the item:** jobs-maintain selects `ORDER BY "enrichedAt" ASC` (oldest enrichment first); the item says newest first. `ingest/maintain.ts` is not mine (Requests).

Tests: `service.test.ts`, `workers.test.ts`.

### 5. [P2] Role candidates: the nearest roles by title embedding: done

- `roleNeighbours.ts` (new): `createRoleNeighbours()`. The English and the Simplified Chinese label of every role a model may be offered are embedded once per process and brand (`purpose: 'skill'`, no user data) and kept in memory; jobs enriched in parallel share the one request. Per job: one request for the title, then the cosine to every label; a role counts by the better of its two labels. Vectors of two models are never compared.
- `candidates.ts`: `selectTaxonomyCandidates(title, description, limit, held, extraIds)` stays synchronous. For a weak title (score under 0.9, or none) the first three `extraIds` join **after** the deterministic matches, the held role and the roles the title's head noun brings, and before the roles that only share words with the posting. The head-noun block stops at ten of fifteen, so the three always fit and never push the other reading of a head noun out ("Associate Architect" keeps `architect` and `software_architect` whatever the neighbours are). A title that names its role ignores them. `titleIsWeak`, `CANDIDATE_ROLES`, `MAX_NEIGHBOUR_CANDIDATES` are exported.
- `service.ts`: asked only for a public posting with a weak title, and only when the model is about to be called.
- Client unavailable: no neighbours, silently. A failed call: no neighbours, one warning, and the step is skipped for five minutes.

ACCEPT, each a test: the weak-title fixture gets three extra candidates and the exact-title fixture none; with no neighbours the list equals today's; the role vectors are requested once for many jobs (ten in parallel, then five more).

**Does not match the item:** it says 307 roles. The tree has 307 nodes, 230 of them at level 3, and only those can be picked, so 230 roles (460 labels) are embedded.

Tests: `roleNeighbours.test.ts` (new, 9), `candidates.test.ts` (17), `service.test.ts`.

### 6. [P1] Enrichment says where its sponsorship reading comes from: done

`reconcile.ts`, `repository.ts`:

- (a) a value written with a verified quote also writes `sponsorshipSource = 'posting_quote'`, over a stored `provider:<id>` reading too;
- (b) with no quote, a stored `provider:<id>` reading and its source are not touched;
- (c) a stored quote that no longer verifies is removed with its value and its source; a row whose source is `provider:<id>` loses only the quote.

No prompt change and no extra model call. The two strings are tested equal to the ones ingest uses (`ingest/upsert.ts`).

**One addition:** on a rules-only pass, a stored quote that still stands sets the source to `posting_quote` when the row did not say so (a row enriched before this item). Readers already treat a non-null quote as quoted; this only brings the column in line.

Tests: `reconcile.test.ts` (the three cases, the no-signal case, the addition), `repository.test.ts`, `service.test.ts`.

### Carry-over

- **waveM1, MKT-4D.1** (as MKT-2H.2): kept. `reconcile()` returns `{ update, report, companyIndustry }`, `setCompanyIndustry` is optional, the held role is the 4th argument (`extraIds` is the 5th), `agent.js` is imported before `service.js`. The industry cues were **not widened**: the note asks for real drops, and I have no database to read them from.
- **waveM1, MKT-4D.2**: informational, no code. The titles it lists ("A兼B", "Associate Architect", "<X>研发工程师") are weak titles, so item 5 now offers their nearest roles, without losing the roles the title itself brings.
- **waveM2, MKT-4D.1, .3, .4, .5, .6**: done as written (model tag, the mention increment, the posting's own string as display text, the status read from the vocabulary, the index hook).
- **waveM2, MKT-4D.2**: decided, item 1 (c).
- **waveM2, MKT-4D.5a**: done as far as my owns reach, item 1 (d) and (l). `via` is persisted, nothing learned is written, and enrichment's own keyword rows never read a guess as a name. Keeping learned keys apart inside the vocabulary and in `export-seed` needs `features/skills`, which nobody owns in M4 (Requests).
- **waveM3, MKT-4D.1**: done by item 6.
- **waveM3, MKT-4D.2, .3**: informational, no code.

## Files changed

All under `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-4D/server/src/features/jobs/enrich/`:

- New: `skills.ts`, `skills.test.ts`, `ageLimit.ts`, `ageLimit.test.ts`, `roleNeighbours.ts`, `roleNeighbours.test.ts`
- Changed: `schema.ts`, `agent.ts`, `reconcile.ts`, `keywords.ts`, `candidates.ts`, `repository.ts`, `service.ts`, `index.ts`
- Changed tests: `schema.test.ts`, `agent.test.ts`, `reconcile.test.ts`, `keywords.test.ts`, `candidates.test.ts`, `repository.test.ts`, `service.test.ts`, `workers.test.ts`, `index.test.ts`, `__tests__/fixtures.ts` (a synthetic fixture vocabulary and a fake port whose embedding step can be switched off)

No file outside that directory is touched (`git status` lists nothing else). The review found no unowned edit, so nothing was reverted.

Handoff: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-4D.md`

## Tests run

All on the final code, after the review changes.

| Command | Result |
|---|---|
| `npx vitest run server/src/features/jobs/enrich/` | 16 files, 317 passed (base: 13 files, 183; before the review: 292) |
| `npm run typecheck:server` | pass |
| the enrichment sources and test files under a temporary tsconfig outside the repository | pass (the server tsconfig excludes tests) |
| `npx next typegen && npm run typecheck:web` | pass |
| `npm run check` | pass (exit 0) |
| `npm run eval:match -- --enforce M2` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 732 files, 18,477 passed, 1 skipped, 10 todo, 0 failed (the final code; the same result in a run just before the last two small edits) |

Twenty-one temporary mutations of the rules this review round added or changed were run against the enrichment suite, and every file was restored (compared byte for byte). Twenty made between one and six tests fail: the audience veto, whose age, the owner of 年龄, a mixed line dropped whole, the key reading the skills, `also`, the guess mark of an entry, the permit-work exception, the unchanged check of a skills-only pass, the pause, the created mark after a partial failure, the vocabulary without guesses (two), the no-label-vector stop, neighbours before the head-noun roles, a guess as a keyword, a skills-only pass without a vocabulary, the skills-only branch, its index run, the kept model and cost. **One survived**: loosening the birth-year pattern back to a bare 生. The stricter pattern is what the reviewer asked for, but the clause rule alone already rejects "2018年以后生产的…" (the clause holds more than the bound), so no test can tell the two patterns apart. It is defence in depth, not a rule of its own.

## Red tests for other bundles

None.

## Pre-existing failures

None in the final runs. For the record: `server/src/features/jobs/import/directFetch.test.ts`, "a 2 MB page of "<li " is read, and its draft built, in milliseconds", is a wall-clock assertion (`read < 200 ms`) that failed in two full runs before the review while the machine's load average was 74 (the sibling bundles' suites). It passed in both runs now. The file and its subject import nothing of enrichment.

## Requests

**MKT-4G, merge-time (review finding 4): compute the key of a requirement list from the text only.**

1. `server/src/features/match/MatchService.ts`, the line `const textHash = hashOfPostingText(jobRow);` (found by symbol; line 689 in `wp-MKT-4G` when I looked). Change it to `const textHash = hashOfPostingText({ title: jobRow.title, qualifications: jobRow.qualifications, descriptionPlain: jobRow.descriptionPlain, skills: [] });`. The read (`readStoredRequirements(jobRow.requirements, { contentHash: textHash })`) and the write (`saveJobRequirements(jobId, { v: 1, contentHash: textHash, … })`) both use that one constant, so the line fixes both. It is the same value as `jobContentHash(requirementsHashRow(job))` of `jobs/enrich/index.ts`. The fit's own `jobContentHash` and `RAJob.contentHash` are untouched: they should go on reading the skills.
2. A test on the scorer's side: enrichment stored a list (key as above), `jobRow.skills` then changed (the provider's list written back), and the scorer still uses the stored list and does not extract.
3. **What happens if the line is not changed:** nothing breaks, and item 3 buys nothing. The scorer reads every list enrichment wrote as another text's, extracts the lines in its own call and stores them under its own key, which the next refresh invalidates again. So please treat it as part of the merge.
4. `readStoredRequirements(value)` and the type `StoredRequirements` are exported from `jobs/enrich/index.ts`. Item ids are `r1…rN` in posting order; texts are verified with `normalizeForQuote`, which differs from `normalizeForGuard` only in `′`, `` ` ``, `″`, `…` and bullets. Since this round an item's text can be a part of a posting line (the line without its age clause), still verbatim.

**MKT-4E (review finding 2): a second spelling is not a second skill.**

5. A version-3 row has one `skillsDetail` entry per skill and every spelling in `skills`. The base `jobSkillList` returns hard skills `['PostgreSQL', 'Python', 'Postgres', 'Team player']` for the row below (I ran it). `wp-MKT-4E`'s `jobSkillList`, as it stood when I read it, already takes the detail as the list when it carries ids, which resolves it. Please pin it with a test in `match/preScore.test.ts` and in the INV-7 spec, with a row as enrichment v3 writes it: `skills: ['postgres', 'postgresql', 'team player', 'teamwork', 'python']`, `skillsDetail: [{ skill: 'postgresql', kind: 'hard', required: true, skillId: 'postgresql', via: 'alias', also: ['postgres'] }, { skill: 'teamwork', kind: 'soft', required: false, skillId: 'teamwork', via: 'alias', also: ['team player'] }, { skill: 'python', kind: 'hard', required: true, skillId: 'python', via: 'alias' }]`. Expected: hard skills PostgreSQL and Python, the soft skill Teamwork, nothing twice.
6. Optional, and safer than asking the vocabulary: `context.ts` `skillsDetailOf` passes `also` through, and `jobSkillList` registers the entry's kind, id and guess mark under the key of every `also` spelling as well as of `skill`. Then the fold does not depend on what the reader's vocabulary knows (a spelling only an embedding neighbour mapped is in `also` too).
7. `skillsDetail[]` is `{ skill, kind, required, skillId, via, also? }`. `kind` may be `'certification'`. `via: 'embedding'` is a machine guess (never "Not shown" on its strength). `skillIds` and the keyword row may hold unreviewed ids: filter with `reviewed(id)`. Every keyword written at version 3 has a `skillId` and none is a guess; a row written before has none.
8. `match/repo.ts getKeywords` (MKT-4G's file) reads `keyword` and `importance` only; it needs `skillId` too.

**Orchestrator (`features/retrieval/` has no owner in M4), the same seam as finding 2.**

9. `retrieval/jobText.ts` `displaySkills` leaves soft skills out of the search document by the key of each soft entry's `skill`, and takes every other string of `row.skills` as a preferred skill. The other spelling of a soft skill ("team player" beside the soft entry "teamwork") is not in that set, so it enters the search document. Change: `readDetail` also reads `also`, and the `soft` set holds the keys of a soft entry's `skill` and of its `also` strings. The other spellings of a hard skill are welcome there (they are search text).

**MKT-5C (owns `jobs/ingest/maintain.ts` in M5) or the orchestrator.**

10. **Queue the skills-only pass (review finding 3).** In `runEnrichCatchUp`, after the two existing steps and inside the same cap: when the brand has an embedding model tag (`resolveEmbeddingConfig(brand, env).modelTag`) and `RASkill` holds a label vector for it (`SELECT 1 FROM "RASkill" WHERE "embedding" IS NOT NULL AND "embeddingModel" = $tag LIMIT 1`), select

    ```sql
    SELECT "id" FROM "RAJob"
    WHERE "market" = $1 AND "archivedAt" IS NULL AND "visibility" = 'public'
      AND "enrichVersion" = $2 AND "skillsDetail" @> '[{"via":"none"}]'::jsonb
    ORDER BY "postedAt" DESC NULLS LAST, "id" ASC
    LIMIT $3
    ```

    and queue `{ kind: 'job.enrich', payload: { jobId, skillsOnly: true }, options: { dedupeKey: skillRemapDedupeKey(jobId, modelTag), brand } }` (`skillRemapDedupeKey` and `enqueueJobSkillRemap` are exported from `jobs/enrich/index.ts`). The key holds the model tag, so the same state of the vocabulary never queues a job twice while the item exists. A user's own import is left out on purpose (it is mapped by exact alias only). A row whose remaining string cannot become a skill (longer than 60 characters) stays `via: 'none'` and is selected again once its finished item is pruned: that pass makes no model call and no embedding request, and saves nothing on the job row.
11. `buildStaleEnrichSql` orders by `"enrichedAt" ASC NULLS FIRST`. For "newest first" (MKT-4D item 4): `ORDER BY "postedAt" DESC NULLS LAST, "id" ASC`, with its header comment and test. Optional: raise `ENRICH_REQUEUE_PER_RUN` (500), which sets the pace of the version-3 pass.
12. Alternative to request 1, if the scorer cannot change: do not overwrite `skills` on a row enrichment has written (`ingest/upsert.ts`). I prefer request 1: the key should not read what the lines do not depend on.

**Orchestrator (`features/skills/` has no owner in M4): the rest of carry-over M2.5a.**

13. `SkillSnapshot` should keep learned keys apart (`learnedKeys`) and answer `via: 'embedding'` for them on every lookup until a reviewer keeps the alias; `export-seed` should leave them out unless the row is `reviewed`. Then enrichment can pass `learn` again (one line in `enrich/skills.ts`, `withEmbeddings`), stops embedding the same string twice, and its own bookkeeping of guesses can go.
14. Until then: `canonicalizeMany` puts an alias it accepted by embedding into the loaded vocabulary (`rememberAlias`) whether or not `learn` is passed. Until the vocabulary reloads (10 minutes), `current().idOf(term)` answers the reviewed skill for a machine guess. Enrichment's rows and keyword rows are protected (item 1 (d), (l)); another reader in the same process that asks `features/skills` directly (MKT-4E's estimate of a posting without ids) is not.

**Orchestrator: the age-limit flag has no reader yet.**

15. `AGE_LIMIT_TAG` (`'age_limit_stated'`, exported from `jobs/enrich/index.ts`) is written with its quote on GoApply rows. The card that flags the posting is in `features/cn/jobs/card.ts` and the web card, with copy in a GoApply namespace; none is in my owns. `mergePostingTags` already keeps the tag.

**MKT-5H.**

16. `ENRICH_REQUIREMENTS_MAX` for `.env.example` and `deploy/cn/cn.env.example` (below).

**Orchestrator, comments and the plan's "as built" rows.**

17. `server/prisma/schema/ra-jobs.prisma`, `RAJob.skillsDetail`, and `features/jobs/companies/contract.ts` line 100 still say `[{ skill, kind, required }]`; it is now `[{ skill, kind: 'hard' | 'soft' | 'certification', required, skillId, via, also? }]`. `ra-match.prisma`, `RAKeywordExtraction.keywords`: each entry also has `skillId`.
18. MARKET_TASK_PLAN 3.3, row "Requirement wire types": `RAJob.requirements.contentHash` is `jobContentHash({ title, qualifications, descriptionPlain, skills: [] })`, one list per text of the posting, not `RAJob.contentHash`. Row "Skill vocabulary": `skillsDetail[].also`. The `job.enrich` payload: `{ jobId, force?, skillsOnly? }`.

**Owner.**

19. **Before the version-3 code runs on a database with jobs-maintain enabled: set the embedding key for the brand and run the skills CLI `embed-labels` there.** Otherwise the one pass each row gets maps it by exact alias only (item 4, "Order of the rollout"). The warning `RASkill holds no label vector for the embedding model in use` in the log says it happened.
20. Confirm the decisions marked above, in particular item 1 (a) imports by alias only, item 1 (d) no learned aliases, item 1 (k) the skills-only pass, item 2 (a) unreviewed listed skills are keywords, item 2 (e) a guess is never a keyword, item 3 (a) the key without skills, item 3 (b) the guarded write, item 3 (e) whose age.
21. If every live row should get its requirement list from enrichment instead of from the scorer's first call, `needsLlm` needs one more reason ("no stored list"). I did not add it: it would make the version-3 pass one model call per live row, and a posting nobody is ever scored against would pay for a list nobody reads.

## Schema requests

None is needed. One optional, additive, for request 13:

```prisma
model RASkill {
  /// Comparison keys an embedding neighbour gave this skill (machine guesses). Never exported to the seed; a reviewer's `keep` moves a key to `aliases`.
  learnedAliases String[] @default([])
}
```

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `ENRICH_REQUIREMENTS_MAX` | Requirement lines kept per posting, also named in the enrichment prompt. A whole number from 1 to 24; anything else means the default. Read per process, not per brand. | `12` |

Not variables: `ENRICH_MAX_OUTPUT_TOKENS` (3000) is a constant in `agent.ts`; `LABEL_VECTOR_RETRY_MS` (five minutes) and `GUESSED_KEYS_MAX` (20,000) are constants in `skills.ts`. `SKILL_EMBED_MATCH_MIN`, `EMBED_*` and `ENRICH_DAILY_JOBS` are read as before.

## i18n keys added or changed

None.

## Known gaps

- **Nothing ran against a database or a model.** The guarded requirement write (`updateMany` with a JSON path filter on `requirements`), the neighbour query, the mention increment and the keyword upsert that keeps model and cost are tested against fakes. The first real enrichment at version 3 is the test of the prompt: how often a model copies a line exactly, and whether 3,000 output tokens are enough for a long Chinese posting, is not measured.
- **The embedding step has never run.** It needs `embed-labels` first (request 19) and an embedding key. Rows enriched before that keep the exact-alias answer until a skills-only pass is queued for them, and nothing queues one until request 10 lands.
- **Two seams are only half closed inside my owns.** Until request 1 lands, the scorer does not use the lists enrichment stores. Until the readers fold `also` (requests 5, 6 and 9), a reader that unions `skills` with `skillsDetail` by string lists a second spelling as a skill of its own.
- **A machine-guessed alias is embedded again** in every process that meets the string, and after every reload of the vocabulary, until request 13 lands.
- **The age rule is a set of patterns with a clause rule on top.** It reads two-digit ages in Chinese (Simplified and Traditional) and English. It does not read "90后", ages written in Chinese numerals, a limit split over two sentences, a bound inside a longer clause that neither says 年龄 nor "must be" ("退休返聘人员年龄可放宽至65岁以下", "We are looking for someone aged 25 to 40"), or an English bound with no age word ("Applicants must be under 35"). A posting it misses gets no flag, and an age clause it misses can stay inside a requirement line. One it flags shows its own sentence.
- **A mixed line without a separator is dropped whole.** "Must be 21 or older and have a valid driver's licence" has no comma to cut at: the whole line counts as an age line and the licence is lost from the checklist. The Chinese form with ， is handled.
- **Work authorization is judged per line, not per clause.** "3年以上经验，持有工作签证者优先" stays whole (经验 reads as doing the work), with the permit preference inside it. Logistics lines other than work authorization rest on the prompt alone: a model that returns a pay or location line verbatim keeps it as a requirement.
- **A reply cut off at the token limit is not salvaged**: it is retried like any unparsable reply, and the job finishes rules-only on the last attempt.
- **Two workers that create the same new skill at the same moment count one mention**, not two.
- **The mainland keyword list depends on the vocabulary.** The committed seed is tool-heavy and English-first (273 skills), so a Chinese posting yields few keywords until the review round trip has run on real postings. That is the honest state, and it is thinner than before.
- **`requirementsWere`** travels on the update object to the market hooks. It is not a column and no hook reads it.

## Review resolution

`undone`: none. `unownedEdits`: none (nothing to revert). Findings, in the reviewer's order. Each was reproduced first; none was rejected.

1. **High. The age rule dropped real requirement lines and wrote a false `age_limit_stated` tag. Resolved**, `ageLimit.ts` rewritten, `reconcile.ts` `verifiedRequirements`. Reproduced: all seven probe sentences were read as the applicant's age. (a) The birth pattern accepts 出生, or 生 followed by 人, 的 at the end, the end or punctuation. (b) Done differently from the proposal, and more strictly: instead of a longer list of audience words, a bound counts as the applicant's only on positive evidence (item 3 (e)); the birth branch goes through the same rule. Reason: a list is never complete, and 女性 or 产品 on it would hide real limits ("女性，35岁以下", "35岁以下，负责产品推广"), which the clause rule keeps. All five audience probes and the production-year probe are now neither flagged nor dropped. (c) A mixed line keeps its other clauses, each remaining run verbatim; `age` counts only lines with nothing left (item 3 (f)). (d) Every probe sentence is in `ageLimit.test.ts` and `reconcile.test.ts`, and the mixed line and the no-tag case also in `service.test.ts`. One honest note: the stricter pattern of (a) is not what stops the probe (the clause rule is), see "Tests run".
2. **Medium. A second spelling had no entry, so readers listed the skill twice and took a soft skill's alias for hard. Resolved on my side, reader change requested.** Reproduced with the base `jobSkillList` (hard skills `PostgreSQL, Python, Postgres, Team player`). The row shape is what item 1 asks for, so the entry now names its other spellings (`also`), an entry is a guess only when no spelling is a known name, and a later pass reads the entry back with its spellings (item 1 (j)). Requests 5 and 6 (MKT-4E: `wp-MKT-4E` already takes the detail as the list for such a row; a test with a version-3 row and INV-7 are asked for) and 9 (the search document has the same seam for soft skills).
3. **Medium. Rows mapped while the embedding step was off were stamped version 3 and never mapped again. Resolved.** (1) The rollout order is stated (item 4, request 19) and the two comments that promised "the next enrichment" are corrected (`skills.ts` header, `service.ts` `mapSkills`). (2) The skills-only pass exists (`{ jobId, skillsOnly: true }`, item 1 (k)) with its producer helper; MKT-5C is asked to queue it (request 10, with the SQL). (3) After a neighbour query answers nothing, the embedding step is paused for that model for five minutes; the first empty answer also stops the step at once instead of after every string was asked.
4. **Medium. The requirement list was keyed to a hash that reads `RAJob.skills`. Resolved on my side, one line requested of MKT-4G (merge-time).** The key is the text only (item 3 (a)); tests at the reconcile and the service level show the list surviving a pass that adds a skill, the refresh that resets it and a changed provider list. Request 1 is the matching line in the scorer, with what happens if it is left out (request 3).
5. **Low. Neighbour roles were picked before the head-noun family and could push the other reading out. Resolved**, `candidates.ts`: the neighbours are picked after the head-noun roles and outside their two thirds. Test: "Associate Architect" and "Java Backend Architect" with three unrelated neighbours still offer the whole family (`architect` and `software_architect` among them), the neighbours follow it, and the rest of the list goes on as before.
6. **Low. Embedding-step failures were logged without the job, and a partial create failure could count a mention twice. Resolved**, `skills.ts`: both warnings carry the request id of the work item and the number of strings; the ids stored before a failure are remembered and answered `via: 'new'`, which the service already leaves out of the mention count.
7. **Low. The work-authorization rule dropped lines where visas are the work. Resolved**, `reconcile.ts` (item 3 (d)). Both probe lines are in the test and stay requirements; the applicant-status forms and the bare nouns without such wording are still dropped. I left 办理 and 申请 out of the Chinese markers the reviewer proposed, because "公司可协助办理工作签证" is an offer, not work (tested).
8. **Low. A machine-guessed alias reached the keyword rows of other postings. Resolved**, `skills.ts`, `keywords.ts` (item 1 (d), (l), item 2 (e)). The vocabulary enrichment hands to its keyword list does not answer for a guessed key and finds a skill in a text only by a name that is not a guess; the probe ("pgsqldb" in a second posting's text) is a test with the real port. The guesses are now kept per loaded vocabulary instead of for the life of the process, so an alias a reviewer stores later is read as reviewed after the next reload. A guessed skill a posting lists is also no longer written to that posting's own keyword row. The lasting fix stays request 13.
