# Match evaluation harness

The evaluation harness of search, retrieve and match (`MARKET_STRATEGY.md` 2.6, requirement SM-1). It was written before the matching fixes, and every later change to matching is accepted by its numbers.

It has two parts:

- **Invariants.** Ten sentences that must always be true, as executable specs against the target contract. They fail until the phase that builds what they describe has merged.
- **Suites.** One per layer of the gate table. A suite measures; the runner compares each value with its gate.

## The two commands

```bash
npm run eval:match                 # fixtures only: no network, no database
EVAL_LIVE=1 npm run eval:match -- --live   # against the real index (the switch is set in the shell)
```

Arguments:

| Argument | Meaning |
|---|---|
| `--enforce M1\|M2\|M4\|all` | Invariants due at or before this phase must pass. Default `all`. |
| `--market intl\|cn\|all` | Which market's fixtures and gates. Default `all`. |
| `--suite <name>` | One suite only. `invariants` runs the invariants only. |
| `--json <file>` | Also write the report as JSON. |
| `--write-baseline` | Store this run's values as the "no regression" baseline. |
| `--live` | Read the real index (read-only) and call models. Refuses without `EVAL_LIVE=1` set in the shell (it is not read from `.env`). |
| `--export-audit` | With `--live`: write the 10% recruiter audit sample as CSV. |
| `--import-audit <csv>` | Read the recruiters' grades back and store the judge-human kappa. |

The command prints one table (layer, metric, value, gate, status) and exits:

- `0` when nothing fails,
- `1` when an invariant due at or before `--enforce` fails, or a suite that has fixtures misses its gate,
- `2` for a bad argument or a refused `--live`.

Status values:

| Status | Meaning |
|---|---|
| `pass` / `fail` | The value was held against its gate. |
| `no_fixture` | Nothing to compare: the fixture file is not on disk, no baseline is stored yet, or the reference subset is not in this run. Does not fail. |
| `not_built` | The code the row needs does not exist yet (a missing seam, or no suite for the layer). Does not fail. |
| `untrusted` | Computed from LLM-judge labels with no passing recruiter audit. Does not fail and proves nothing. |
| `skipped_offline` | Only measurable with `--live`. |
| `pending` | An invariant due after `--enforce` that does not hold yet. Reported, does not fail. |
| `info` | A value no gate reads (the English reference subset, the share of titles with a deterministic match, the career-changer rows of the ranking layer). |

After the M1 merge the orchestrator runs `npm run eval:match -- --enforce M1`; after M2 `--enforce M2`; after M4 `--enforce M4`. The stage names are the phase names of the market wave.

The harness specs (`*.eval.ts`) are **not** part of `npm test`. `vitest.eval.config.mts` collects them; the default config collects `*.test.ts` only. The invariants of finished phases run in `npm test` through `enforced.test.ts`, which calls `registerInvariants({ enforce })`: since phase M2 (MKT-2F) it enforces `M2`, so nine of the ten run there (INV-7 is due M4), together with the per-seam tests and the completeness test described under `seamRegistry.ts` below.

## The ten invariants

| Id | Due | Invariant |
|---|---|---|
| INV-1 | M1 | A job with no listed skills and no stated level is never great and its confidence is low. |
| INV-2 | M1 | Changing a filter chip changes no fit; a location, pay or sponsorship answer changes the logistics dimension only. |
| INV-3 | M2 | Every surface returns the same score, tier and kind for one user and one job. |
| INV-4 | M1 | A senior resume against an internship is at most possible. |
| INV-5 | M1 | "Java Backend Architect", "Lead AI Architect" and "Principal Architect - Machine Learning" are not in Design; "Landscape Architect" is. |
| INV-6 | M1 | A location entry with a country and no city filters by country. |
| INV-7 | M4 | The keyword check reports PostgreSQL as related evidence for "relational databases" and lists no skill twice. |
| INV-8 | M1 | An AI-scored job never ranks below an unscored job of equal quality solely because it was scored. |
| INV-9 | M1 | A pay value that cannot be pay for its period is not sorted as pay. |
| INV-10 | M1 | On GoApply without the AI consent, `getFit`, a feed query and the precompute cron make zero model calls. |

Files:

- `invariantList.ts`: the ten as data (id, due phase, sentence). No imports.
- `invariantSpecs.ts`: the executable specs. They use `node:assert`, the MATCH test kit and the counting fakes of `world.ts`.
- `invariants.eval.ts`: `registerInvariants({ enforce })` declares them as Vitest cases. It registers nothing at import.
- `invariants.entry.eval.ts`: the entry the runner executes.
- `seamRegistry.ts`: the surfaces INV-3 reads, wired since phase M2 (MKT-2F). Ten seams, each running the surface's own code on the fakes of the world: `feed_card`, `job_detail`, `similar_jobs`, `alert_selection`, `ready_list`, `assistant_stored_fit`, `assistant_analyze_fit`, `extension_chip`, `tailoring_kit`, `onboarding_result`. A name in `REQUIRED_FIT_SEAMS` is never removed.
- `enforced.test.ts`: the `npm test` entry. It also scans `server/src` (outside `features/match`) for files that read `getFit`, `getFits`, `getVariantFit` or `estimateForPosting` and compares them with its `FIT_READERS` list: a new reader fails the test until it is listed there with its seam, or with a note saying why it is not a surface.

Rules:

- **A spec never skips.** A seam that does not exist yet throws `SeamMissing("<path>#<export>")`, which is a failing invariant with the missing piece named.
- **Nothing under test is imported statically.** `seams.ts` loads a repository path and an export at run time, so the specs type-check before the module exists.
- **No model, no embeddings endpoint, no planner, no database, no network.** The scorer, the embeddings client and the planner are counting fakes. `fetch` throws "network is off in eval" and counts the attempt, which is what INV-10 reads.

### How the fit functions are bound to fakes

`getFit` and `getFits` are read from `server/src/features/match/fit.ts`. The contract fixes their signatures, not how they reach a repository, so `loadFitApi` accepts either shape:

1. a factory exported by `fit.ts` (`createFitService`, or any export named `create…Fit…`, `make…Fit…`, `build…Fit…`) that takes the match dependencies, a MatchService, or `{ service }`;
2. the functions as methods of the object `createMatchService(deps)` returns.

With neither, the seam is missing: functions bound only to the production repository cannot be checked without a database.

## The gate table

`gates.ts` holds the gates of strategy 2.6 as data. Shares, recall, precision, NDCG, kappa, ICC and correlation are numbers from 0 to 1; "points" are percentage points (15 points = 0.15); latency is milliseconds.

| Layer | Metric | Gate |
|---|---|---|
| retrieval | `recall_at_200_hybrid` | at least `recall_at_200_recency` + 15 points |
| retrieval | `recall_at_200_worst_persona_delta` | at least -0.05 (no persona more than 5 points below its baseline) |
| ranking | `ndcg_at_10`, `ndcg_at_20` (career changers reported apart, not gated) | no regression against the stored baseline |
| estimate_vs_ai | `tier_kappa` | at least 0.5 |
| estimate_vs_ai | `estimate_great_ai_below_possible` | under 0.05 |
| scorer | `icc_3_runs` | at least 0.85 |
| scorer | `tier_flip_rate` | under 0.05 |
| scorer | `spearman_human` | at least 0.6 |
| taxonomy | `category_precision` | at least 0.95 on 300 labelled titles per market |
| skills | `precision_not_shown` | at least 0.95 |
| language | `ndcg_at_10`, `ndcg_at_20` for `zh-TW`, `zh-CN`, `cross` | within 10% relative of the `en` subset |
| latency | `feed_p95_ms` | at most the stored baseline + 150 ms (live only) |

Notes on three rules:

- **Language** is one-sided: a subset that does better than English passes. The gate guards against a loss.
- **"Estimate Great, AI below Possible"** is the share among the pairs whose estimate is Great. The share over all pairs is printed beside it and is not gated.
- **Judge labels.** A value computed from LLM-judge labels is `untrusted` until a recruiter audit gives a judge-human quadratic-weighted kappa of 0.6 or better. The audit must be of the same judge (model id and prompt version), hold at least 30 graded pairs (`JUDGE_TRUST_MIN_PAIRS`) and hold pairs of the market the value is reported for. Change the judge model or the prompt and every judged value is untrusted again until a new audit.
- **Career changers** are measured and printed on their own rows (`ndcg_at_10 [career_changer]`, status `info`) and are not part of the gated ranking value or of the language comparison. Their labels follow the role the person says they want. The only place that wish reaches the matcher is a Role chip of the saved search, and invariant 2 says a chip changes no fit. So a fit that is right cannot rank the wanted role first, and a fit that leaks the chip would raise the number. The goal may count in the feed order; a suite that measures that order can gate them.

A layer with no suite yet prints `not_built`. The suites shipped here are `taxonomy`, `ranking` and `language`.

### The ranking baseline

"No regression" needs a stored value: `fixtures/baselines.json`, which is committed. It records what it was measured on (`source`) and the hash of the fixture files (`fixturesHash`).

The first baseline is the order **before** the fit contract. The phase that changes ranking most (estimate v2 and `getFits`, MKT-1F) merges together with this harness, so the baseline was measured on the base commit from the list read that existed then (`MatchService.preScoreMany`: the stored AI score, else the quick estimate):

```bash
npx tsx server/src/features/match/eval/baselineBeforeFit.ts
```

That script runs only on a checkout without `features/match/fit.ts`. Once the contract exists it refuses: the order before is gone. Values on the base commit: NDCG@10 0.9427 (intl) and 0.9396 (cn), NDCG@20 0.9534 and 0.9517, career changers left out.

From then on a baseline is written only when a change in ranking is accepted on purpose:

```bash
npm run eval:match -- --write-baseline
```

Rules:

- Values are stored to six decimals. Only gated values are stored (no career-changer row, no live value in the fixture file).
- A baseline is for one set of fixtures. After `fixtures/build.ts` changes the generated files, the stored values are for other labels: the runner says so, compares nothing, and `fixtures.test.ts` fails until the baseline is written again. Regenerate fixtures and re-baseline in the same change, and say in the change which order the new baseline is.
- Live baselines (`.snapshots/baselines.live.json`) stay on the machine and are read only under `--live`.

## Fixtures are synthetic

Every fixture file starts with `"_synthetic": true`. Personas, postings, employers and resumes are written by `fixtures/build.ts` from the hand-written tables in `fixtures/seed/`. Nothing is copied from a job board, a provider response or a database row. Personas are test fixtures and never reach a user-facing surface.

| File | Content |
|---|---|
| `fixtures/personas.<market>.json` | 40 personas per market, each with a resume |
| `fixtures/postings.<market>.json` | at least 240 postings per market, hard negatives included |
| `fixtures/labels.constructed.<market>.json` | one grade 0 to 3 per pooled persona-posting pair |
| `fixtures/baselines.json` | the stored ranking values (see "The ranking baseline") |
| `fixtures/seed/` | role groups, skills in four languages, sentence banks, invented employer names, hard negatives |

Every role in `seed/groups.json` has its own skill list (eight positions of its group's vocabulary, the most characteristic first) and its own two work sentences. A posting requires the first skills of its role and describes that role's work, so an iOS posting asks for Swift and SwiftUI and a pharmacist posting is about a pharmacy. The two roles of a group share part of the vocabulary and never the leading skills or a work sentence; the generator refuses a seed where they do.

Regenerate and check:

```bash
npx tsx server/src/features/match/eval/fixtures/build.ts          # write the six files
npx tsx server/src/features/match/eval/fixtures/build.ts --check  # exit 1 when a file is stale
```

The same seed gives byte-identical files. `fixtures.test.ts` fails when a committed file differs from what the generator writes, so edit the seed tables or the generator, never a generated file.

**Labels are named by where they come from and never mixed in one value:**

- `constructed`: recorded by the generator from how a posting was written (same role 3, same role group 2, same category 1, otherwise 0, then adjusted for level distance, internships, thin postings, required skills shown, sponsorship, class year and degree). The exact rule is in the header of `fixtures/build.ts`.
- `authored`: written by hand by the engineer of the code under test. The labelled title sets of the taxonomy gate (`jobs/taxonomy/__fixtures__/labelledTitles.<market>.json`, 300 titles per market) are of this kind: synthetic titles with the role and category their author expects, not a recruiter's grading. They gate like constructed labels; the report prints `authored labels`.
- `judged`: graded by the LLM judge in a live run.
- `human`: graded by a recruiter (the audit CSV of a live run). Never used for labels the team wrote itself.

The 15 role groups are the 15 largest of taxonomy v1 by number of roles. The offline harness has no index counts to rank them by.

Subsets of the language gate: `en` and `zh-TW` are RoboApply personas, `zh-CN` GoApply personas, `cross` personas whose resume and pooled postings are in different languages. Career changers are left out of the language comparison and of the gated ranking value (see "Career changers" above).

## Adding a suite

1. Add `suites/<name>.suite.ts`. It exports three things:

   ```ts
   export const name = 'skills';
   export const layer: GateLayer = 'skills';
   export async function run(ctx: SuiteContext): Promise<SuiteMeasure[]> { /* ... */ }
   ```

2. Put its fixtures in `fixtures/<name>/`. Start every file with `"_synthetic": true`.
3. Load fixtures by path with `fs` at run time (`ctx.fixturesDir`, `ctx.repoRoot`). Never import a fixture statically from outside `eval/`.
4. Return one `SuiteMeasure` per value, named with the metric id of the gate table. Say where the labels came from (`labels`) and how large the sample is (`n`).
5. Do not decide pass or fail. When the suite cannot measure, return `status: 'no_fixture'`, `'not_built'` or `'skipped_offline'` with a note. `notBuiltOrThrow` turns a missing seam into `not_built`.
6. A new gate is a new entry in `gates.ts`.

The runner finds suites on disk. Nothing in `run.ts` changes.

## Live mode

```bash
EVAL_LIVE=1 EVAL_JUDGE_MODEL=<model id> npm run eval:match -- --live [--market cn] [--export-audit]
```

Without `--live` and `EVAL_LIVE=1` nothing reads a database or the network. `EVAL_LIVE` is read from the command's own environment before anything is loaded: putting it in `.env` does not turn live mode on. Once the switch is accepted, the local `.env` files are loaded (model keys, the database URL, and `EVAL_JUDGE_MODEL` when it is not set in the shell).

A market is measured as its brand: `intl` inside RoboApply's context, `cn` inside GoApply's. The scorer model is resolved per market (GoApply's own model when `CN_LLM_*` names one), and every scorer and judge call of a market is made inside its brand.

1. **Snapshot.** For each synthetic persona, the union of the top 50 of every retrieval variant, read from the real index inside one read-only transaction. Only postings are read. No user row, resume or profile is read.
2. **Judge.** A fixed UMBRELA-style prompt (`live/judgePrompt.ts`, versioned) grades each pair 0 to 3 with the model named by `EVAL_JUDGE_MODEL`. A market is not judged when that model is the one its scorer uses (the other market still is), and nothing is judged when it is unset. Grades are cached by prompt version, persona and everything the prompt shows of the persona and the posting, so a second run costs nothing and a regenerated resume or a changed pay line is judged again.
3. **Measures.** NDCG of the fit order against the judge's grades, per market (career changers apart) and per language subset. Per market, the scorer's stability over three runs on 100 pairs (ICC, tier flips) and estimate against AI on those pairs. The 100 pairs are a fixed draw over all pooled pairs of the market: every persona gives one pair before any gives a second, so the sample covers every role, level and language of the market. The persona's own locale is passed to the scorer.
4. **Audit.** `--export-audit` writes a 10% sample of every market's judged pairs as CSV for RoboHire and GoHire recruiters: the persona's summary and resume (what the judge saw), the posting, and an empty grade column. The CSV does not show the judge's grade. A cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet shows posting text as text and never runs it as a formula. `--import-audit <csv>` computes the judge-human quadratic-weighted kappa and stores it with the judge model, the prompt version and the number of graded pairs per market. Judged values are trusted only for that judge and those markets.
5. **Report.** `report.md` and `report.json` with the date, the judge model and prompt version, the scorer model of each market, the sample sizes and every gate, and which labels each value used.

Everything a live run writes goes under `.snapshots/<yyyy-mm-dd>/`, which is git-ignored. Real posting text is never committed. Model calls go through the platform LLM service, so their cost lands in the existing usage log.

| Variable | Meaning | Default |
|---|---|---|
| `EVAL_LIVE` | `1` allows `--live` to read the database (read-only) and call models. Anything else refuses. Set it in the shell for the command; it is not read from `.env`. | unset |
| `EVAL_JUDGE_MODEL` | Model id of the relevance judge. Must differ from the scorer model of the market being judged (the resolved `LLM_MATCHING_MODEL`, or GoApply's own). Shell or `.env`. | unset: nothing is judged |

Live runs are the owner's step. A work-package engineer never runs one.

## Tests of the harness itself

`metrics.test.ts`, `gates.test.ts`, `seams.test.ts`, `fixtures.test.ts`, `run.test.ts` and `live/live.test.ts` run in `npm test`. They use `testdata/fitShim.ts`, a stand-in that puts `MatchService.preScoreMany` behind the target signatures. It is reached only through `setFitModuleForTests`; `run.ts` never loads it, and it proves nothing about the contract. `baselineBeforeFit.ts` used the same stand-in once, on the base commit, to measure the first ranking baseline.
