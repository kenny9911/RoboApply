# MKT-2G

Canonical skill vocabulary: table access, aliases in three scripts, the related-evidence graph, the seed and the review tooling (SM-6, foundation). Worktree `wp-MKT-2G`, branch `wp/MKT-2G`. Nothing was committed. No command reached a database, a model, an embeddings endpoint or the network. No consumer was changed: nothing in the product reads the vocabulary yet (MKT-4D and MKT-4E wire it in M4).

This is the handoff after the independent review. All four items are done, every review finding is resolved (list at the end: nine fixed, one expected value of one test sentence rejected with the reason). Six points differ from the item text; each is marked **Differs** under the item it concerns ((b), (e) and (f) changed in the review round). Please confirm or reject them.

## Items

### 1. [P0] Vocabulary module: done

`server/src/features/skills/`:

- `types.ts`: `SkillRecord`, `SkillVocabulary` (exactly the seven members of the contract row), `SkillSnapshot` (the vocabulary plus `record`, `ids`, `idOfKey`, `idOfPhrase`, `keysOf`, `isDropped`, `asOf`, `source`, `conflicts`, `everydayWord`), `SkillEvidence`, `CanonicalSkill`, `SKILL_STATUS_DROPPED`, `SKILL_STATUS_SEED`.
- `keys.ts`: `aliasKey(term)` = `termKey` after `foldTwToCn`, so "Node.js", "nodejs", "NodeJS" are one key and 機器學習 / 机器学习 are one key. `isListOnlyWord`, `LIST_ONLY_KEYS`, `SHORT_NAMES_WITH_ONE_READING`, `slugOf`.
- `phrase.ts` (new after review): the one tokenizer that cuts both a sentence and a skill name into words.
- `vocabulary.ts`: `buildVocabulary(records)` (pure, order-independent), `mergeOverSeed`, `createVocabularyLoader`, the process-wide `loadVocabulary()`, `ready()`, `current()`, and the test seams `setVocabularyForTests(records | vocabulary | null)` and `resetVocabularyForTests()`.
- `repo.ts`: `createPrismaSkillRepo()` (scalar columns only; the Prisma client is imported inside the first call) and `createMemorySkillRepo()` with the same contract.
- `index.ts`: the public surface. Importing it opens no database connection (a test counts imports of `lib/prisma.js`: zero).

Behaviour worth knowing:

- `current()` before the first load is the committed seed (273 skills), never empty. `ready()` never rejects: when `RASkill` cannot be read, or a row breaks the merge, the last good snapshot stays (at worst the seed), a warning is logged, and the read is tried again after 30 seconds.
- The cache is 10 minutes. The match preparer hook runs once per process, so `current()` starts the refresh itself, in the background, once the snapshot is older than the cache time.
- **Merge of table rows over the seed** (changed after review). A row is a review decision only when its status is `reviewed`:
  - a `reviewed` row's kind, parent, status and identifiers win; a label the row lacks comes from the seed; alias keys are the union;
  - a `seed` row (the row an automatic step made for a seed skill) and an unreviewed row that carries the id of a seed skill decide nothing: kind, labels, parent and status are the seed's as it is now; only the alias keys and the ESCO / O*NET identifiers the row holds count;
  - a `seed` row whose skill the seed no longer has is not a skill;
  - a `dropped` row removes the skill and blocks its keys;
  - an unreviewed row whose string the seed lists as dropped is not a skill.
- One key claimed by two skills goes to one of them deterministically (reviewed before unreviewed, a label before an alias, then by id) and is reported in `conflicts`. The committed seed has none (a test).
- A parent that does not exist, a skill that is its own parent and a loop are ignored, not followed.
- `label(id, locale)`: `zh-TW`, `zh-Hant`, `zh-HK`, `zh-MO` read `labelZhHant`, else `labelEn`, never `labelZh`. **An empty string means "show the posting's own string"**: an unreviewed skill made from a Chinese posting has that string in the English column, and Taiwan gets it only when it was written in Traditional script.

**Differs (a).** `SkillRecord` has two optional fields beyond the item's list: `aliasKeys` (comparison keys taken as they are, which is what the `RASkill.aliases` column stores) and `everydayWord`. Reason, measured: `aliasKey` is not idempotent ("Amazon AWS" → `amazonaws` → `amazonaw`), so a stored key must never be keyed again.

**Differs (b).** Two more values of the `RASkill.status` column, both written by this bundle's tooling only. `dropped` (by `review-import`): without it a reviewer's `drop` cannot last. `seed` (after review): the row an automatic step makes for a seed skill that has none (`embed-labels`, `attach-ids`, a learned alias, the target of a merge). It holds a label vector, learned keys and identifiers, has no alias keys of its own, and is never read as a decision. The column is a free `String`, so no schema change; the schema comment still names two values (see Requests).

Tests: `keys.test.ts` (12), `vocabulary.test.ts` (41), `repo.test.ts` (7).

### 2. [P0] Seed and the related-evidence graph: done

- `seed/build.ts` (deterministic generator), `seed/sources.ts`, `seed/skills.seed.json` (generated), `seed/index.ts`, and three committed input files written by `export-seed`: `seed/reviewed.json` (`[]`), `seed/additions.json` (`[]`), `seed/dropped.json` (`{ "ids": [], "keys": [] }`).
- The seed: **273 skills** (260 hard, 6 soft, 7 certification), 119 with a parent, 34 with a Simplified label, 30 with a Traditional label, 171 further aliases. Every entry is `reviewed`, `esco` and `onet` are null. The file now also carries `"dropped": []` (keys that are never a skill).
- `related.ts`: `evidenceFor(skillId, haveIds, vocabulary?)` → `{ state: 'shown' | 'related' | 'not_shown', via }`, and `narrowerSkills`. A narrower skill shows the broader one, never the reverse; siblings say nothing about each other.
- The seed test reads `SHOWN_BY`, `EVERYDAY_WORDS`, `displayTerm` and `SKILL_ALIASES` at test time and compares the committed file with the generator output byte for byte. After a change to one of those tables or to an input file: `npx tsx server/src/features/skills/seed/build.ts --write`.

**Differs (c): `features/match/terms.ts` is not a two-line edit.** `server/src/features/boundary.test.ts` (FND-5) lets an area import another area only through its `index.ts` or `contract.ts`. The item tells `features/skills/` to import the tables from `features/match/terms.ts`, which that test rejects (11 violations when tried). `match/index.ts` is MKT-2F's in this phase, and importing it from the vocabulary would create an import cycle once MKT-4E makes the estimate import the vocabulary. So the dependency is turned round, inside my owns:

- `features/skills/terms.ts` holds the comparison key, `EVERYDAY_WORDS`, `SHOWN_BY`, `termParts`, `dedupeTerms`, `displayTerm`, moved character for character (the only change is the word `export` on the two tables).
- `features/match/terms.ts` re-exports those names from `../skills/index.js` and keeps what only the match uses (`showingTerms`, `titleShows`). Every caller imports what it imported before. `terms.test.ts` is unchanged and passes (64 cases).

If you prefer the item as written, the alternative is one line in `boundary.test.ts` (`SEAM_TARGETS.add('match/terms.ts')`) and moving the file back.

**Differs (d): five pairs of `SHOWN_BY` are not represented.** `RASkill` has one key per id and one parent per skill:

- "rest apis" and "restful apis" are listed as broader terms and are also the names of the tool REST. The key goes to the tool, so GraphQL, gRPC, OpenAPI and Swagger do not show "REST APIs" (4 pairs). They still show "API design".
- CloudFormation is listed under cloud infrastructure and under infrastructure as code. Its one parent is `infrastructure_as_code` (1 pair lost).

The test asserts exactly these five and no other, over 500+ pairs.

Parent edges beyond the table, each stated by the two names themselves: `sql → relational_databases`, `linux → unix`, `machine_learning_frameworks → machine_learning`, `deep_learning → machine_learning`, `spring_boot → spring`.

Labels the owner should look at (D3): the English labels of three mainland certificates are descriptions, not official titles; the four mainland certificates carry their own name in Traditional script; CPA has no Traditional label (Taiwan names its own licence differently). ELT and SEM are left out on purpose.

Tests: `seed.test.ts` (25), `related.test.ts` (8).

### 3. [P0] `canonicalize()`, `canonicalizeMany()`, `userSkillIds()`: done

`canonicalize.ts`: `canonicalize(term, deps?)`, `canonicalizeMany(terms, deps?)`, `userSkillIds(skills, resumeText, vocabulary?)`, `skillEmbedMatchMin(env)`, and the database side for MKT-4D: `nearestSkills`, `writeSkillEmbedding`, `embeddedSkillIds`, `otherModelSkillIds`, `rowOfRecord`, `missingRowOf`, `skillStoreDeps(db, { model })`.

- Order: exact alias → strict embedding neighbour (cosine ≥ 0.86 and runner-up ≥ 0.03 lower) → new unreviewed skill → `{ skillId: null, via: 'none' }`.
- One `embed` call per `canonicalizeMany`. Never embedded: a one-character string, an everyday word, a short abbreviation with more than one reading, a string a reviewer dropped, and a string over 60 characters.
- `embed` returning null, a short answer or a non-finite vector skips the step. Nothing throws, nothing is made up.
- A neighbour the vocabulary does not hold is no neighbour at all (it no longer hides the real one behind it).
- A new skill made from a Chinese string gets that string as the label of its own script (`labelZh` or `labelZhHant`), never of the other.
- The id of a new skill is its comparison key, so two workers that meet the same new string create the same row.
- `deps.learn(skillId, aliasKey)` stores a learned alias. For a seed skill, `learn` first writes its `seed` row (`missingRowOf`), then adds the key.
- `nearestSkills` reads `ORDER BY "embedding" <=> $1::halfvec`, only rows whose `embeddingModel` equals the given model and whose status is `reviewed` or `seed` (every seed skill is reviewed). No `SELECT *`.

**Differs (e): `userSkillIds` does not call `mentions()`.** `text.ts` (`skillIdsInText`) reads the text once. Reasons: the table stores keys, not spellings; cost follows the text, not the vocabulary (0.76 ms for a 10,600-character resume against the seed); `mentions()` does not find a Latin name next to a Chinese character; importing `preScore.ts` from the vocabulary would be the cycle of (c).

The whole-word rule after review, which is the rule of `mentions()` (a name is found only where the text writes it):

- **One word** is looked up by its comparison key ("NodeJS", "nodejs", "Node.js" are one name; "java" is not found in "javascript").
- **Several words** are looked up by their phrase, the words in order, and match only a name that is itself written as those words: "REST APIs", "Spring Boot", "CI/CD", "pl/sql", "scikit-learn". Two ordinary words whose letters spell a tool are not that tool: "I am" is not IAM, "in design" is not InDesign, "work day" is not Workday, "sales force" is not Salesforce. The same holds across "-", "/" and "_" ("air-flow", "re-act").
- A name with an inner dot is also found with a space or a hyphen there ("Node JS", "Node-JS", "React JS").
- A stored alias key that has no spelling (a learned alias) is found as one word only. A key with Chinese in it is its own spelling.
- A word that is also something else is not taken from a sentence: the everyday words of `terms.ts`, `LIST_ONLY_KEYS`, and **any word of three letters or fewer that is not listed in `SHORT_NAMES_WITH_ONE_READING`**. Such a word counts from a person's skill list, and from `skillIdsInText(text, { listOnlyWords: true })`.
- Chinese: a name of three characters or more is found anywhere in a run; a shorter one must be the whole run; characters on two sides of a space are two words (数据 库存 does not name 数据库).

Tests: `canonicalize.test.ts` (50).

### 4. [P1] Owner tooling: done

`cli.ts`, `cluster.ts`, `csv.ts`, `__fixtures__/*.synthetic.*` (invented strings, counts and identifiers).

`npx tsx server/src/features/skills/cli.ts <command> [--apply]`, seven commands, each a dry run unless `--apply`:

| Command | What it does |
|---|---|
| `export-strings --market intl\|cn\|all` | Read-only count of distinct `RAJob.skills` / `skillsDetail` strings over public, canonical, live postings. `--apply` writes the local CSV. |
| `propose [--with-model --top N]` | Deterministic clusters → `skills-clusters.csv`. The model is called only with `--apply`; its output goes to `proposed…` columns. |
| `review-export [--top 1000] [--clusters file]` | The review sheet, from the clusters file or from `RASkill` by mention count. Only a row a reviewer already kept is pre-set to `keep`. |
| `review-import <csv>` | `keep`, `merge-into:<id>`, `drop`. All or nothing. |
| `attach-ids --esco f --onet f` | Sets an identifier only on an exact, case-insensitive label match. |
| `embed-labels [--replace-model]` | Label vectors for reviewed skills that lack one for the current model. Refuses to write over vectors of another model unless `--replace-model`. |
| `export-seed` | Carries the table's decisions into the four seed files. |

- `review-import` rehearses the sheet on a copy of the rows and refuses a sheet that would make one alias key point at two ids.
- Nothing is ever deleted: a dropped or merged row stays as a `dropped` row.
- `attach-ids` assumes no column names. Two identifiers matching one skill are skipped, a skill that already has another identifier is left alone. No file is downloaded, no Lightcast data is read.
- Clustering goes beyond the item in three guards: a one-letter difference never joins across a digit, never joins two keys the vocabulary already knows as two skills, and never applies to Chinese.
- The CSV files write a cell that a spreadsheet would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) with a single quote in front, and read it back as it was.

**Differs (f): `export-seed` writes four files and adds to them.** The item wants a deterministic generator and also a command that writes reviewed rows into the same file. Both hold this way: the generator's output stays `skills.seed.json`, and `export-seed` writes its three inputs:

- `reviewed.json`: reviewed rows that differ from the generated seed (a decision about the skill);
- `additions.json`: alias keys and identifiers the table added to a seed skill (the skill itself stays generated, so a later change to `sources.ts` or `terms.ts` applies);
- `dropped.json`: dropped seed skills (left out of the seed; a skill under one loses its parent, as it does at run time) and the keys of dropped strings that no live skill holds.

The command reads the three committed files first and puts this table's decisions over them, so a decision made in another database (the other market's) is kept unless a row of this table says otherwise. Running it against an empty table changes nothing.

`embed-labels` is wired with a safe default: `loadLabelEmbedder` loads `platform/embeddings/client.ts` by path at run time and reads it by the contract (`resolveEmbeddingConfig`, `embedTexts` with `purpose: 'skill'`, `carriesUserData: false`). A missing module, a missing key or `{ unavailable }` all mean "not available".

Tests: `cli.test.ts` (58). `fetch` is stubbed to throw and is asserted never called.

### Carry-over

`waveM1-carryover.md`, section MKT-2G: "Nothing from M1." `wavePAR-carryover.md`, "Market waves": no entry names a file in my owns.

## Files changed

- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2G/server/src/features/match/terms.ts` (re-exports the primitives; keeps `showingTerms`, `titleShows`). Not touched in the review round.
- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-2G/server/src/features/skills/` (new): `types.ts`, `keys.ts`, `terms.ts`, `phrase.ts`, `vocabulary.ts`, `repo.ts`, `related.ts`, `text.ts`, `canonicalize.ts`, `cluster.ts`, `csv.ts`, `cli.ts`, `index.ts`
- `server/src/features/skills/seed/`: `build.ts`, `sources.ts`, `index.ts`, `skills.seed.json`, `reviewed.json`, `additions.json`, `dropped.json`
- `server/src/features/skills/__fixtures__/`: five synthetic files
- Tests: `keys.test.ts`, `vocabulary.test.ts`, `repo.test.ts`, `seed.test.ts`, `related.test.ts`, `canonicalize.test.ts`, `cli.test.ts`
- `server/src/features/match/terms.test.ts`: unchanged
- Handoff: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-2G.md`

New in the review round: `phrase.ts`, `seed/additions.json`, `seed/dropped.json`. Changed: `keys.ts`, `text.ts`, `types.ts`, `vocabulary.ts`, `canonicalize.ts`, `csv.ts`, `cli.ts`, `repo.ts` (one comment), `index.ts`, `seed/build.ts`, `seed/index.ts`, `seed/skills.seed.json` (regenerated: one new field, the skills are byte-identical), and five test files. `git status` shows only `server/src/features/match/terms.ts` (modified) and `server/src/features/skills/` (new).

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/skills/` | 7 files, 201 tests passed (was 155) |
| `npx vitest run server/src/features/match/terms.test.ts server/src/features/boundary.test.ts` | passed (terms: 64, file unchanged) |
| `npm run typecheck:server` | pass |
| `npx next typegen && npm run typecheck:web` | pass |
| `npm run check` | pass (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` | 682 files, 15,903 passed, 1 skipped, 10 todo, 0 failed |
| `npm run eval:match -- --enforce M1` | exit 0 |
| `npx tsx server/src/features/skills/seed/build.ts` | "skills.seed.json is up to date (273 skills)." |

The test files are outside `typecheck:server` (the server tsconfig excludes `*.test.ts`); I type-checked them with a temporary config that I removed again: clean.

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

**MKT-4D (enrichment write path).**
1. Wire `canonicalizeMany(terms, { embed, ...skillStoreDeps(prisma, { model }) })`. `model` must be the tag `embed-labels` stored: `resolveEmbeddingConfig(brand, env).modelTag`. `embed` returns `number[][] | null`; map `{ unavailable }` to null.
2. `create` already sets `mentionCount: 1` on a new skill; your per-job increment is `createPrismaSkillRepo().incrementMentions(ids)`.
3. A new skill's id is its comparison key. Ids are not display text: use `label(id, locale)`. **When it returns an empty string, show the posting's own string** (an unreviewed skill from a Chinese posting, read under another script). For an unreviewed skill the posting's own string is the right text in every locale.
4. A string a reviewer dropped comes back as `{ skillId: null, via: 'none' }`.
5. `RASkill.status` has four values: `reviewed`, `unreviewed`, `dropped`, `seed`. Read a skill's status from the vocabulary (`reviewed(id)`), never from the row: a `seed` row is a reviewed seed skill.

**MKT-4E (estimate and keyword check).**
1. `registerMatchPreparer(() => skills.ready())` is enough; `ready()` never rejects.
2. Fixture vocabulary: `setVocabularyForTests(records)`, and `resetVocabularyForTests()` in `afterEach`.
3. `evidenceFor` returns `{ state, via }`, `via` being a skill id.
4. `userSkillIds` never takes from prose an everyday word or a short abbreviation that has another reading (ML, AI, PS, CPA, GCP, LLM, NLP, dbt and every word of three letters or fewer that is not in `SHORT_NAMES_WITH_ONE_READING`). For "the posting asks for X and the resume says X in a sentence" use `skillIdsInText(text, { listOnlyWords: true })` and look for that one id. With that switch "500 ml" does name ML: decide per skill kind whether that is good enough (I would not use it for a certification such as CPA).
5. `current().asOf` is the snapshot time for `vocabularyAsOf` (null while only the seed is loaded).
6. An id a job row still carries after its skill was merged resolves with `current().idOf(oldId)`.
7. `terms.ts` is yours in M4 and re-exports from `features/skills/terms.ts`. No bundle owns `features/skills/` in M4: a change to a table there is a Request.

**MKT-3C (owner of `jobs/normalize/` in M3), optional.** `foldTwToCn` covers job-title characters only. 溝, 註, 冊, 聯, 團, 隊, 決, 題, 細, 節, 責, 續 are not folded, so 溝通能力 and 沟通能力 are two keys. The seed lists both scripts as aliases, but an unreviewed skill met in both scripts becomes two rows until a reviewer merges them, and a Traditional string made only of such characters is taken as Simplified when a new skill is labelled (Taiwan then gets the empty label, which is the safe side).

**Orchestrator.**
1. Confirm or reject Differs (c): the move of the term primitives.
2. Comment only, `server/prisma/schema/ra-skills.prisma`, `RASkill.status`: `/// 'reviewed' | 'unreviewed' | 'dropped' (a reviewed non-skill: never shown, never scored, never created again) | 'seed' (the row an automatic step made for a seed skill: carries a vector, learned keys and identifiers, decides nothing).`
3. `package.json` has no owner after M1. Optional script: `"skills": "tsx server/src/features/skills/cli.ts"`.
4. `seed/sources.ts` holds a character-for-character copy of `SKILL_ALIASES` (`features/search/skills.ts`), because `search/index.ts` does not export it. `seed.test.ts` fails when the two differ.
5. Contract row "Skill vocabulary" of MARKET_TASK_PLAN 3.3: add "`label` may return an empty string, which means show the posting's own string".

**Owner.**
1. Approve ESCO and O*NET as sources and supply the two files for `attach-ids` (decision 6 of SEARCH_RETRIEVE_MATCH section 8).
2. Run the review round trip once `RAJob` rows carry skills: `export-strings`, `propose`, `review-export --clusters`, hand review of the top 1,000, `review-import`, `export-seed`, commit the four seed files.
3. Review the certificate labels above and name a Taiwan-native reviewer for `labelZhHant`.
4. Decide on the names that count from a person's skill list only, never from a sentence. `LIST_ONLY_KEYS`: node, .NET, TS, NATS, ML, PS, AI, PY, CPA, RAG, SOX, IAM. By the short-abbreviation rule, also: GCP (good clinical practice), dbt (dialectical behaviour therapy), LLM (the law degree; "LLMs" is found), NLP (neuro-linguistic programming), CPP (Canada Pension Plan; "C++" is found), JAX, IFR ("IFRS" is found). Cleared for prose (`SHORT_NAMES_WITH_ONE_READING`): aws, ecs, eks, gke, iac, vpc, dns, cdn, tls, ssl, sso, jwt, sqs, sre, sql, css, xml, php, js, vue, git, svn, npm, api, ios, oop, tdd, etl, crm, erp, seo, ppt, cfa, pmp, ui, ux, qa. A short alias a reviewer adds later counts from the skill list only until it is added to that list in code.

## Schema requests

None is needed for this bundle. Two optional, additive ones for the owner:

1. Before a mainland embedding model is set (`CN_EMBED_MODEL`): `RASkill` holds one label vector per skill and `nearestSkills` filters on `embeddingModel`. With two models in use, only the market whose model wrote the vectors gets the embedding step. `embed-labels` now refuses to overwrite and says so.

```prisma
/// One label vector per skill and embedding model (raw SQL only, like RAJobEmbedding).
model RASkillEmbedding {
  skillId   String
  model     String
  embedding Unsupported("halfvec(1024)")
  updatedAt DateTime @updatedAt

  @@id([skillId, model])
}
```

2. To find a multi-word alias of a skill that exists only in the table (see Known gaps):

```prisma
model RASkill {
  /// Aliases as written ("google analytics 4"), beside the comparison keys in `aliases`. The text scan needs the words.
  aliasSpellings String[] @default([])
}
```

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `SKILL_EMBED_MATCH_MIN` | Cosine at or above which an unknown skill string is mapped to its nearest canonical skill. Clamped to 0.8 at the low end and 1 at the high end; not a number means the default. | `0.86` |

The 0.03 margin is the constant `SKILL_EMBED_MARGIN` (overridable per call, no variable). Nothing was added in the review round.

## i18n keys added or changed

None. Skill labels are data, not bundle copy.

## Known gaps

- **Nothing was run against a database.** `querySkillStrings`, `nearestSkills`, `writeSkillEmbedding`, `embeddedSkillIds` and `otherModelSkillIds` are checked for their text and parameters against fakes only. The first owner run of `export-strings` (a dry run reads but writes nothing) is the real test of that SQL.
- **`embed-labels` reads the embeddings client by the contract text**, not by a compiled import: MKT-2H builds it in parallel. Run `embed-labels` (dry run) once after the M2 merge.
- **`propose --with-model` was never run with a real model.**
- **A multi-word Latin alias of a skill that exists only in the table is not found in a sentence.** The table stores keys, and a key has lost its spaces, so only the skill's labels and one-word forms are found ("Google Analytics" yes, the alias "google analytics 4" no). Seed skills are not affected (the seed keeps spellings), and Chinese aliases are not affected. Schema request 2 closes it.
- **A one-word name written with a hyphen or a space is not found** ("No-SQL", "Git-Hub", "Elastic Search"), because that is the same shape as "air-flow" and "sales force". A reviewer adds such a spelling as an alias where it is common.
- **A dot name read with a space can meet ordinary prose**: "our next JS project" names Next.js. I kept it because "Next JS", "Node JS", "React JS" are how many resumes write these names.
- **Names of people and ordinary words outside the tables still count from prose**: Jenkins, Cassandra, Kafka and Django as surnames or titles; "maven", "confluence", "selenium" as ordinary words. `EVERYDAY_WORDS` is the table of `terms.ts`, which the item says not to change; `LIST_ONLY_KEYS` can take them if the owner wants precision over recall there.
- **The scan does not read meaning**: "no SQL experience" names SQL, as it does for `mentions()`.
- **A key cannot be taken away from a seed skill by a table row alone** (keys are the union). `review-import` refuses the sheet that would cause a collision that way; a key in `additions.json` is removed by editing that file.
- **The seed is tool-heavy and English-first**: 273 skills from the repository's own tables. Mainland and Taiwan coverage comes from the review round trip on real postings.
- **Singular folding collides in places** ("pandas" and "panda" are one key; "postgres db" has the key `postgredb`).
- **The skills gate (precision of "Not shown" ≥ 95%) is not measured here.** It is MKT-4E's suite. The stricter rules above lower recall from prose for short abbreviations; the gate will show whether the lists need tuning.
- `cli.ts` is one file of about 1,180 lines because the item names one file; the pure planners (`planReviewImport`, `planAttachIds`, `reviewedOverlay`, `seedAdditions`, `droppedDecisions`, `mergeSeedDecisions`, `clusterSkillStrings`) are exported and tested apart from the command line.

## Review resolution

I verified each finding before changing anything (a script ran every sentence of the review against the committed seed; all reproduced).

1. **Undone item 3 and finding 1 (high), the scan finds skills in ordinary word pairs: fixed.** Several words now match by phrase and only a name written as those words (`phrase.ts`; the snapshot keeps a phrase index of every label and alias spelling; a stored key with no spelling is one word only). Every sentence of the review is a test and gives no skill. Two points where I did not follow the proposed fix to the letter:
   - **Stricter:** the fix allowed the collapsed key for words joined by "-", "/" or "_". That still gives "air-flow" → Airflow, "sales-force" → Salesforce, "snow-flake" → Snowflake. Those windows also go by phrase. "CI/CD", "scikit-learn", "pl/sql", "T-SQL" are found because the names are written that way; "Node-JS" is found through the dot rule.
   - **Rejected, one expected value:** the review asks for `[]` on "The colour red is used; no SQL experience; managed a sales force of 20". The test asserts `['sql']`. Redis, NoSQL and Salesforce are gone, but the whole word SQL is in the sentence, and `mentions()`, which the item names as the rule, finds it too. Reading "no" is not a whole-word question.
2. **Finding 2 (medium), short abbreviations from prose: fixed, as a rule.** `LIST_ONLY_KEYS` gains ml, ps, ai, py, cpa, rag, sox, iam. Beyond the list, a word of three letters or fewer counts from a sentence only when it is in `SHORT_NAMES_WITH_ONE_READING`; the rule looks at the word as written, so "IFRS" and "LLMs" are found and "IFR" and "LL.M." are not. Tests: a bank of ordinary sentences (units, marketing metrics, "P.S.", sports teams, GCP, DBT, LL.M., NLP, CPP, IFR) against the seed expects no skill, in `seed.test.ts` and `canonicalize.test.ts`; a second test pins the exact list of short seed names that count from the skill list only, so a new short alias forces a decision; a third checks that every name of the seed is still found where a sentence writes it.
3. **Finding 3 (medium), a table row always overrides the seed: fixed.** The automatic copies have the status `seed` and no alias keys of their own (`missingRowOf`); `mergeOverSeed` reads the skill from the seed for a `seed` row and for an unreviewed row that carries a seed id; `nearestSkills` reads `status IN ('reviewed', 'seed')`; `reviewedOverlay` skips them; what they add goes to `additions.json` as a patch on the generated entry, not as a copy of it (a copy in `reviewed.json` would freeze the skill again one level up, at scale once `attach-ids` runs over the seed). `review-export` no longer pre-sets `keep` on such a row. Tests: an unreviewed row with a seed id leaves the seed skill reviewed with its parent; `embed-labels`, then a seed change, then `export-seed` keeps the change.
4. **Finding 4 (low), `embed-labels` for a second model overwrites silently: fixed.** The vector store returns the rows that carry a vector of another model; the command prints the count per model and refuses (dry run and `--apply`) unless `--replace-model`. Tests for the refusal, the dry-run line and the replacement.
5. **Finding 5 (low), a sentence over 60 characters is embedded: fixed.** `embeddable()` has the cap; the test asserts the sentence is not sent and that 60 characters still are.
6. **Finding 6 (low), `ready()` can reject: fixed.** One `.catch` covers the read and the merge; a reporter that throws is caught too. Test with a row whose `aliases` is null: `ready()` resolves, `current()` is the seed, the error is reported, the read waits for the retry time.
7. **Finding 7 (low), formula injection in the CSV files: fixed.** `guardCell` / `unguardCell` in `csv.ts`; a cell that already starts with quotes and a formula character gets one more, so the round trip is exact. Tests on the cells and on the three files of a whole round.
8. **Finding 8 (low), drop decisions do not travel: fixed.** `seed/dropped.json` (ids of dropped seed skills, keys of dropped strings no live skill holds), carried by the generator into `skills.seed.json`, passed as `droppedKeys` to the seed snapshot and to `mergeOverSeed`. An unreviewed row of a string the seed lists as dropped is not a skill either, so the decision also reaches a deployment that created the row earlier. Tests: a dropped string and a dropped seed skill stay dropped with an empty table; a seed skill merged into another seed skill exports without a key collision.
9. **Finding 9 (low), `label(id, 'zh-TW')` returns Simplified text: fixed.** A new skill gets its string as `labelZh` or `labelZhHant` by script; `label` for the Traditional script returns `labelZhHant`, else `labelEn` only when it has no Chinese characters, else an empty string, stated in the contract comment and in the Requests to MKT-4D.
10. **Unowned edits:** none were reported and none exist.

Found while fixing, not in the review, and fixed: `export-seed` rebuilt `reviewed.json` from the table alone, so a run against another database (or an empty one) would have erased committed decisions. It now adds to the committed files (Differs (f)).

Decisions for the owner that follow from the review: the names that count from the skill list only (Requests, Owner 4), and whether to add the two optional schema changes.
