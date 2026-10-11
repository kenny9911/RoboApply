# MKT-1D

Evaluation harness, fixtures and the ten invariant specs, written first (SM-1). Branch `wp/MKT-1D` on base `54fa08d`, nothing committed. All five items are done, and all nine review findings are resolved (list at the end).

## Items

### 1. [P0] Runner, command and report: done

- `package.json`: one line, `"eval:match": "tsx server/src/features/match/eval/run.ts"`.
- `vitest.eval.config.mts`: node environment, the aliases and closed-port database URLs of `vitest.config.mts`, includes only `server/src/features/match/eval/**/*.eval.ts`, an offline setup file. `npm test` does not collect these specs.
- `eval/run.ts`: `--live`, `--enforce M1|M2|M4|all` (default all), `--market intl|cn|all`, `--suite <name>`, `--json <file>`, `--write-baseline`, plus `--export-audit` and `--import-audit <csv>` for item 5. It installs the offline guard unless `--live`, runs the invariant entry through the Vitest node API, runs every `eval/suites/*.suite.ts` found on disk, prints one table (layer, metric, value, gate, status) and exits 1 when an invariant due at or before `--enforce` fails or a suite with fixtures misses its gate. Exit 2: bad argument or refused `--live`.
- `eval/README.md`: the two commands, the status values, the invariant table, the gate table, the ranking baseline, how to add a suite and a fixture folder, the synthetic rule, live mode.
- Tests: `run.test.ts` (37).

**On the base commit** `npm run eval:match` needs no network and no database, prints the table and exits 1:

| Invariant | Due | Base commit | Reason printed |
|---|---|---|---|
| INV-1 | M1 | fail | `SeamMissing: server/src/features/match/fit.ts#getFits` |
| INV-2 | M1 | fail | `SeamMissing: server/src/features/match/fit.ts#getFits` |
| INV-3 | M2 | fail (pending under `--enforce M1`) | `SeamMissing: …fit.ts#getFits`, and each of the nine surfaces by name |
| INV-4 | M1 | fail | `SeamMissing: server/src/features/match/fit.ts#getFits` |
| INV-5 | M1 | pass | |
| INV-6 | M1 | pass | |
| INV-7 | M4 | fail (pending under `--enforce M1` and `M2`) | `"relational databases" has state undefined (expected related…)`; `PostgreSQL is listed 2 times (PostgreSQL, Postgres)` |
| INV-8 | M1 | fail | `SeamMissing: server/src/features/feed/ranking.ts#fitForRank` |
| INV-9 | M1 | pass | |
| INV-10 | M1 | fail | `SeamMissing: server/src/features/match/fit.ts#getFits` |

None is skipped. Suites on the base commit: ranking and language `not_built` (the same missing seam), taxonomy `no_fixture`, every other layer `not_built`.

### 2. [P0] Metric functions and the gate table: done

- `eval/metrics.ts`: `recallAtK`, `ndcgAtK`, `weightedKappa` (quadratic), `icc` (two-way random, absolute agreement, single measure), `spearman`, `precisionRecallByClass`, `tierFlipRate`, `reliabilityCurve`, `shareEstimateGreatAiBelowPossible`, `percentile`. A metric that is undefined for its input answers null, never 0.
- `eval/gates.ts`: data only, every gate of strategy 2.6 with its threshold; one comparison function (`compareWithGate`), one status function (`rowStatus`), one function that says whether a gate reads a subset (`gateReads`), and the judge-trust rule (`judgeDistrust`).
- Three suites: `taxonomy.suite.ts`, `ranking.suite.ts`, `language.suite.ts`.
- **Changed after review.** Career changers are outside the gated ranking value. The ranking suite reports them on their own rows (`ndcg_at_10 [intl] [career_changer]`, gate column `not gated`, status `info`); the gates carry `exceptSubsets: ['career_changer']`; a baseline never stores them. Reason: their labels follow the wanted role, the only place that wish reaches the matcher is a Role chip, and INV-2 says a chip changes no fit.
- **Changed after review.** `fixtures/baselines.json` is committed (see "The ranking baseline" below).
- Tests: `metrics.test.ts` (29), `gates.test.ts` (16).

### 3. [P0] Synthetic personas, postings and constructed labels: done

- `eval/fixtures/`: 40 personas per market; 326 postings (intl: 216 English, 98 Traditional Chinese, 12 Japanese) and 246 (cn); `labels.constructed.<market>.json` with one grade per pooled pair (1,566 and 1,660 pairs). Every file starts with `"_synthetic": true`; the labels carry `"_kind": "constructed"`.
- intl: 26 English, 9 Traditional Chinese, 5 cross-language. cn: 35 Simplified Chinese, 5 English-resume cases. Three levels, 4 and 5 new graduates, 3 and 4 career changers, 15 role groups in both markets.
- Hard negatives as before (internships, no skills and no level, country-only, the head-noun cases, one implausible pay line per market).
- Every persona has a pool of at least 36, at least 5 graded 2 or 3 and at least 18 graded 0.
- **Changed after review.** Every seed role now has its own skill list and its own work sentences (`seed/groups.json`: per role eight positions of the group's vocabulary, the most characteristic first, and two work phrases per language; 38 skills added to the vocabularies). A posting requires the first skills of its own role and describes that role's work. Example, regenerated: "is hiring an iOS Engineer. You will be responsible for the customer iOS app. … Required: Swift, SwiftUI, UIKit, Xcode." and "is hiring a Pharmacist. You will be responsible for prescription checks in the hospital pharmacy. … Required: Medication dispensing, Drug interaction review, Prescription verification, Compounding." The generator refuses a seed where the two roles of a group lead with the same skills or share a work phrase. English text uses the right article (`indefiniteArticle`: "an iOS Engineer", "an HR Generalist", "a UX Designer"). `constructedGrade` is unchanged. All six files were regenerated (fixtures hash `5b4aa710cea8…`).
- Tests: `fixtures.test.ts` (22).

### 4. [P0] The ten invariants as executable specs: done

- `eval/invariants.eval.ts`, `eval/invariants.entry.eval.ts`, `eval/seams.ts`, `eval/seamRegistry.ts`, `eval/invariantList.ts`, `eval/invariantSpecs.ts` as before.
- **Changed after review.** INV-8 now runs both branches of the ranking input. Without a map: the two inequalities at 21 quality levels, and an unscored row's input equals its estimate (the old formula under the new export name now fails by its value, not only by the missing export). With a calibration map: the same inequalities under the identity map, a step map that is the identity at the tested points, and a map that compresses the estimate scale (the scored row has the AI score the map gives its estimate). Checked on a scratch copy of MKT-1F's `ranking.ts`: "estimate minus 5", a clamped scored row and an unscored row mapped upward each make INV-8 fail with a sentence that names the case.
- Tests: `seams.test.ts` (13).

### 5. [P1] Live mode: done

- `eval/live/snapshot.ts`, `judgePrompt.ts` (`judge_v1`), `judge.ts`, `audit.ts`, `stability.ts`, `report.ts`, `index.ts`, `eval/.gitignore`.
- Without `--live` and `EVAL_LIVE=1` nothing reads a database or the network. With both, everything written goes under `eval/.snapshots/`.
- **Changed after review.**
  - A market is measured as its brand: model resolution, every judge call and every scorer call of `cn` run inside `runWithBrand('goapply')`, of `intl` inside RoboApply's. The scorer model is resolved per market and the judge is refused per market when it is that market's scorer (the other market is still judged). The scorer gets the persona's locale. The report records the scorer model of each market.
  - Scorer stability and estimate against AI are measured per market on 100 pairs each, and reported per market (no `all` row). The 100 pairs are a fixed draw over all pooled pairs: every persona gives one pair before any gives a second.
  - An audit is tied to its judge: `audit.key.json` and `audit.json` store the judge model, the prompt version and the market of every sampled pair. A judged value is trusted only when the audit is of the same model and prompt version, holds at least 30 graded pairs (`JUDGE_TRUST_MIN_PAIRS`), reaches kappa 0.6 and holds pairs of the value's market. The untrusted row says which of these failed. The audit sample is 10% of every market.
  - The judge cache key is sha1(prompt version, persona id, persona content hash, posting content hash); the posting hash covers every field the prompt shows (title, employer, location, pay, description, requirements).
  - The audit CSV has a `persona_resume` column (the resume the judge graded on). A cell that starts with `=`, `+`, `-`, `@`, a tab or a return gets a leading apostrophe.
  - `EVAL_LIVE` is shell-only and the refusal says so. After the switch is accepted `run.ts` loads `server/.env` and `.env` itself (shell wins), so `EVAL_JUDGE_MODEL` may be in either place.
- Tests: `live/live.test.ts` (22), mocked LLM and fake query function.
- Not run against a real database or a real model, by rule.

## The ranking baseline (new)

`fixtures/baselines.json` is committed with this bundle. It was measured on the base commit from the list read that exists before the fit contract (`MatchService.preScoreMany` behind the `getFits` signature), by `eval/baselineBeforeFit.ts`. The script refuses once `features/match/fit.ts` exists. The file records `source` and the hash of the fixtures; a baseline for other fixtures is not compared (the runner says so, and `fixtures.test.ts` fails until it is written again).

| Value (career changers left out) | Base commit (stored) | Trial merge with MKT-1E and MKT-1F as of 10:23 today |
|---|---|---|
| NDCG@10 intl (n=37) | 0.942745 | 0.9515 pass |
| NDCG@20 intl | 0.953438 | 0.9638 pass |
| NDCG@10 cn (n=36) | 0.939621 | 0.9418 pass |
| NDCG@20 cn | 0.951689 | 0.9598 pass |
| Career changers NDCG@10, intl / cn (not gated) | 0.9574 / 0.9398 | 0.3843 / 0.3420 |

The trial merge was a scratch copy (my worktree plus the changed files of the two sibling worktrees, read-only, since deleted). On it `npm run eval:match -- --enforce M1` exits 0: INV-1, 2, 4, 5, 6, 8, 9, 10 pass, INV-3 and INV-7 pending, ranking and language rows pass, taxonomy precision 0.996 (intl) and 0.9925 (cn). The six harness test files pass there too (139 tests). The siblings were still being finished, so this is a snapshot.

## Where I followed the documents over the item, or chose

1. **Read-only transaction.** `SET TRANSACTION READ ONLY` as the first statement, not the session-level setting the item names (that one would stay on a pooled connection).
2. **INV-1 confidence.** Asserted "never great" on three postings and "confidence low" on two; on the third the two wordings of the strategy give different answers.
3. **Language gate is one-sided**: a subset that scores above English passes.
4. **"Estimate Great, AI below Possible"** is gated as the share among Great estimates.
5. **The 15 largest role groups** are the largest of taxonomy v1 by number of roles.
6. **Career changers** are outside the gated ranking value and the language comparison, in fixture mode and in live mode.
7. **`JUDGE_TRUST_MIN_PAIRS = 30`** is my number. The strategy gives the kappa (0.6) and the sample (10%), not a minimum. One line in `gates.ts`.
8. **An offline run sets `VITEST`** in its own process when unset, so `lib/prisma.ts` loads no local `.env`.
9. **Files beyond the item's FILES lines**, all inside `eval/`: `invariantList.ts`, `invariantSpecs.ts`, `world.ts`, `offline.ts`, `offline.setup.ts`, `suite.ts`, `fitOrder.ts`, `baselineBeforeFit.ts`, `fixtures/schema.ts`, `fixtures/load.ts`, `fixtures/baselines.json`, `testdata/`.

## Files changed

- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1D/package.json` (one script line)
- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1D/vitest.eval.config.mts` (new)
- `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-1D/server/src/features/match/eval/` (new, 50 files):
  - `README.md`, `.gitignore`
  - `run.ts`, `gates.ts`, `metrics.ts`, `suite.ts`, `fitOrder.ts`, `seams.ts`, `seamRegistry.ts`, `world.ts`, `offline.ts`, `offline.setup.ts`, `baselineBeforeFit.ts`
  - `invariantList.ts`, `invariantSpecs.ts`, `invariants.eval.ts`, `invariants.entry.eval.ts`
  - `suites/taxonomy.suite.ts`, `suites/ranking.suite.ts`, `suites/language.suite.ts`
  - `fixtures/build.ts`, `fixtures/schema.ts`, `fixtures/load.ts`, six generated JSON files, `fixtures/baselines.json`, `fixtures/seed/{groups,text,geo,companies,specials}.json`
  - `live/{index,snapshot,judge,judgePrompt,audit,stability,report}.ts`
  - `testdata/fitShim.ts`, `testdata/fitUnbound.ts`
  - tests: `run.test.ts`, `metrics.test.ts`, `gates.test.ts`, `seams.test.ts`, `fixtures.test.ts`, `live/live.test.ts`
- Handoff: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-mkt/MKT-1D.md`

No path outside the owns was edited (`git status`: `package.json`, `vitest.eval.config.mts`, `server/src/features/match/eval/`).

## Tests run

| Command | Result |
|---|---|
| `npx vitest run server/src/features/match/eval` | 6 files, 139 tests passed |
| `npm run typecheck:server` | clean |
| `npx next typegen && npm run typecheck:web` | clean |
| `npm run check` | all checks clean |
| `npx vitest run --exclude ".claude/**"` | 651 files passed; 14,431 tests passed, 1 skipped, 10 todo (base: 645 files, 14,292 tests) |
| `npm run eval:match` | prints the table, exit 1 (expected on the base commit; table above) |
| `npm run eval:match -- --enforce M1` | exit 1 on the base commit: INV-1, 2, 4, 8, 10 fail; INV-3 and INV-7 pending |
| `npm run eval:match -- --live` | exit 2, "Refusing --live: set EVAL_LIVE=1 in the shell … It is not read from .env … Nothing was read." |
| `npx tsx server/src/features/match/eval/fixtures/build.ts --check` | no stale file |
| `npx tsx server/src/features/match/eval/baselineBeforeFit.ts` | wrote the four values above; a second run gives the same values |
| Scratch trial merge, `run.ts --enforce M1` | exit 0 (not a gate of this worktree; see the table above) |

## Red tests for other bundles

None.

## Pre-existing failures

None.

## Requests

**Orchestrator**

1. `fixtures/baselines.json` is already committed with this bundle: do not write a baseline before the M1 gate. After `npm run eval:match -- --enforce M1` exits 0 on the merged tree, run `npm run eval:match -- --write-baseline` and commit the file, so later phases are held against the merged order (expected about 0.9515 / 0.9638 intl and 0.9418 / 0.9598 cn).
2. If a `ranking` row fails at the M1 gate, the merged fit order ranks the synthetic pools worse than today's list read did. The narrowest margin in the trial was NDCG@10 cn, 0.9418 against 0.9396. That is a finding for MKT-1F, with the persona-level numbers from `--json <file>`. Accepting a lower value is the owner's decision and is done by `--write-baseline`, never by editing the file.
3. If a `language` row fails, that is a finding about Traditional Chinese or cross-language resumes, not about the harness.
4. MKT-1F's `fit.ts` must keep one way to bind the three functions to in-memory dependencies: `createFitService(deps | service | { service })`, or the functions as methods of what `createMatchService(deps)` returns.

**MKT-1G** (owns `.env.example` and `deploy/cn/cn.env.example`)

5. Word the `EVAL_LIVE` entry as a shell switch, not an `.env` entry. Proposed comment: "EVAL_LIVE: set to 1 in the shell for one command (EVAL_LIVE=1 npm run eval:match -- --live). It is not read from this file." Remove a `# EVAL_LIVE=` assignment line if there is one. `EVAL_JUDGE_MODEL` may stay as an `.env` entry: "model id of the relevance judge for --live; must differ from the scorer model of the market being judged".

**MKT-2F** (owns `eval/seamRegistry.ts` and `eval/enforced.test.ts` in M2)

6. A registry read is `read(userId, jobId, ctx)` with `ctx = { world, scenario }`. Build each surface on the fakes of `ctx.world` so all readings come from one world. INV-3 runs twice: `estimate` and `ai`.
7. Keep every name of `REQUIRED_FIT_SEAMS`; add `onboarding_result` as a tenth entry.
8. `enforced.test.ts` is one call: `registerInvariants({ enforce: 'M2' })` from `./invariants.eval.js`.

**MKT-4E**

9. INV-7's posting carries no `skillIds`, lists `Relational databases`, `PostgreSQL`, `Postgres` and `TypeScript`, and the resume lists PostgreSQL. The literal path must report `state: 'related'` with `via` PostgreSQL and treat the two spellings as one skill.

**MKT-4F, MKT-4G**

10. A live value carries `scope: 'live'`. Retrieval variants for the live pool are `RETRIEVAL_VARIANTS` in `eval/live/snapshot.ts`; that file has no owner after M1.
11. A suite that measures the feed order (where the stated goal may count) is the place to gate career changers. Until then report them with `subset: CAREER_CHANGER_SUBSET` and they print as information. A new gate that should not read them needs `exceptSubsets`.
12. A suite that changes or adds fixtures under `eval/fixtures/` (the six generated files) must write the ranking baseline again in the same change; `fixtures.test.ts` fails otherwise.

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `EVAL_LIVE` | `1` allows `npm run eval:match -- --live` to read the database (read-only) and call models; anything else refuses. Read from the shell only, never from `.env`. | unset |
| `EVAL_JUDGE_MODEL` | Model id of the relevance judge for `--live`; must differ from the scorer model of the market being judged (the resolved `LLM_MATCHING_MODEL`, or GoApply's own). Shell or `.env`. | unset: nothing is judged |
| `EVAL_ENFORCE` | Internal: how `run.ts` hands `--enforce` to the Vitest worker. Not for `.env.example`. | set by the runner |

## i18n keys added or changed

None.

## Known gaps

- **The M1 gate cannot be run in this worktree.** `--enforce M1` exits 0 only on the merged tree. It did on a scratch trial merge with the siblings' files as they were at 10:23.
- **The cn NDCG@10 margin is small** (0.0022 in the trial). A late change in MKT-1F's estimate can turn that row red at the merge. That is the gate doing its job; see Request 2.
- **No retrieval, estimate-against-AI, scorer, skills or latency suite in fixture mode yet**: they print `not_built`. Later bundles add them.
- **Career changers have no gate.** Seven personas are measured and printed only. A leak of filter chips into the fit is caught by INV-2, not by a ranking number.
- **Live recall of hybrid against recency** needs the lexical, dense and fused variants added to `eval/live/snapshot.ts`, which no M4 bundle owns.
- **`spearman_human`** has a metric and a gate and no producer.
- **Live mode has never touched a real database or model.** The owner's first `--live` run is its first real run. The audit, the choice of `EVAL_JUDGE_MODEL` and the minimum of 30 graded pairs are the owner's to confirm.
- **Fixture size.** The generated files are about 1.1 MB and ship inside `server/**`.
- **Employer names** are invented and marked, but were not compared with the live index (no database access by rule).
- **The constructed labels are my rule**, not a recruiter's judgment. With per-role skills and duties a grade 3 and a grade 2 posting now differ in content, not only in title; the release gate for GoApply relevance stays the live run on a real corpus.
- **Two personas** have a recent title today's matcher cannot place (`初階業務代表`, `フルスタックエンジニア`).

## Review resolution

All nine findings were verified against the code and are real. None rejected. `undone` and `unownedEdits` were empty.

1. **Career-changer labels in the gated ranking value (medium): fixed.** Career changers are out of the gated value in `suites/ranking.suite.ts` and in `live/index.ts`, reported as `ndcg_at_10 [career_changer]` / `ndcg_at_20 [career_changer]` with gate `not gated` and status `info`. The rule is data in `gates.ts` (`CAREER_CHANGER_SUBSET`, `exceptSubsets`, `gateReads`); a baseline never stores those rows. Measured: 0.957 / 0.940 on today's chip-reading order, 0.384 / 0.342 on the trial merge, as the reviewer found. Tests: `run.test.ts` "career changers are printed and never gated or stored as a baseline", `gates.test.ts`.
2. **No ranking baseline for M1 (medium): fixed.** `fixtures/baselines.json` is committed, measured on the base commit by `eval/baselineBeforeFit.ts` (today's list read through the stand-in). NDCG@10 and NDCG@20 both pass on the trial merge (table above). The baseline is stamped with its source and the fixtures hash. Tests: `run.test.ts` (three baseline cases), `fixtures.test.ts`.
3. **Stability sample on two personas of one market (medium): fixed.** `stabilitySample` draws round-robin over every persona in hash order, 100 pairs per market; scorer and estimate-against-AI measures carry the market. The first hash-ordered version clustered on 11 of 40 personas because FNV-1a keeps similar ids together; `hash32` now ends with an avalanche step and the draw is round-robin, so all 40 personas are in it. Tests: `live.test.ts` "draws its pairs over every persona…" and the two-market run (pools of 50, 40 personas per market in the sample, both markets).
4. **Mainland market under RoboApply's context (medium): fixed.** Per market: `runWithBrand`, scorer model, judge refusal, scorer and judge calls, persona locale; both scorer models in the report. Test: a fake resolver that answers `vendor/cn-scorer` inside GoApply; the judge named that model is refused for `cn` only, and `cn` pairs are scored with it inside `goapply`.
5. **Audit not tied to the judge; cache key ignores persona content (low): fixed.** Judge model, prompt version and per-market counts in `audit.key.json` and `audit.json`; `judgeDistrust` in `gates.ts`; `JUDGE_TRUST_MIN_PAIRS = 30`; persona hash in the cache key; employer, location and pay in the posting hash. A key file without its judge is refused at import. Tests: `gates.test.ts`, `run.test.ts` "an audit trusts only the judge it audited…", `live.test.ts` "judges again when anything the prompt shows has changed".
6. **Audit CSV without the resume; raw cells (low): fixed.** `persona_resume` column; formula-leading cells get an apostrophe; the round trip includes a posting that begins with "- 5+ years". Tests: `live.test.ts` "never writes a cell a spreadsheet would read as a formula" and the round trip.
7. **Second role of every group is a title swap (low): fixed for all 15 groups**, not only the five named: per-role skills and work in `seed/groups.json`, the generator draws from the role, the article is right, fixtures regenerated. Tests: `fixtures.test.ts` "a posting reads as its own role…" and "English postings and resumes use the right article…".
8. **INV-8 never runs the map branch (low): fixed.** Three maps, plus "an unscored row's input equals its estimate" without a map. Verified by three mutations on a scratch copy.
9. **`EVAL_LIVE` read before `.env` (low): fixed.** The switch stays shell-only; the refusal, `assertLive` and the README say so; `run.ts` loads the `.env` files explicitly after the switch, so `EVAL_JUDGE_MODEL` no longer depends on which module happens to load them. Request 5 goes to MKT-1G. Test: `run.test.ts` "live mode loads the local .env files itself…".
