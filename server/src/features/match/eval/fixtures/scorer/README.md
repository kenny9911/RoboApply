# Fixtures of the scorer suite

Read by `eval/suites/scorer.suite.ts` (strategy 2.6, scorer layer; requirement SM-8). Everything here is SYNTHETIC: the personas and postings are the committed fixtures of the harness, and every JSON file starts with `"_synthetic": true`.

| File | What it is | Who writes it |
|---|---|---|
| `selfcheck.json` | Ten hand-written resume-posting pairs with three hand-written answers each (the same checklist in three spellings) and the totals worked out by hand. No model output. The suite replays it on every run: ICC 1 and no tier flip, or the command fails. An answer never has more than a third of its copied lines missing from the posting: beyond that the server refuses the answer, which the self-check would report as a failure. | Committed with the suite. |
| `recorded.<market>.json` | The raw answers of three runs of the pinned scorer (scorer v4) on 100 synthetic persona-posting pairs: the fixture behind `icc_3_runs` and `tier_flip_rate`. | A live run writes it under `eval/.snapshots/<date>/scorer/`; the owner reviews it and copies it here. |
| `recorded.v3.<market>.json` | The same for scorer v3 (`MATCH_SCORER_RUBRIC=fit_v3`): the fixture behind the fourth gate, `spearman_human_gain_over_v3` ("not below the current scorer", SM-8), and behind `spearman_human_v3`, printed next to scorer v4's value. Without this file that gate is NOT measured: it reads `no_fixture`, also when `spearman_human` passes. | As above, recorded with the rollback switch set: `MATCH_SCORER_RUBRIC=fit_v3 EVAL_LIVE=1 EVAL_SCORER_RECORD=1 npm run eval:match -- --live`. |
| `audit.<market>.json` | Recruiters' grades (0 to 3) of recorded pairs: the fixture behind `spearman_human`. Human grades only. | The owner, from the graded sheet (see below). |

Until `recorded.<market>.json` is here the four gated scorer rows of the report read `no_fixture` (`icc_3_runs`, `tier_flip_rate`, `spearman_human`, `spearman_human_gain_over_v3`). Nothing fails and no number is invented. With the recording and the audit here and no `recorded.v3.<market>.json`, the first three are measured and the fourth still reads `no_fixture`, with the command above in its note.

## How a recording is read

- `tier_flip_rate` is the share of pairs that did not get one and the same tier in all three runs, over every pair of the recording that is still for today's inputs. A run that gave no usable answer (the call failed, the answer does not parse, the server refused the checklist) is a pair without one tier, whether one run or all three gave nothing: the person would see an estimate where the AI fit should be. Such a pair is never dropped quietly.
- `icc_3_runs` and `spearman_human` need a score from every run, so they are computed over the pairs every run scored. They are held against their gates only when those pairs are at least 90% of the recording and at least 30 pairs. Below either bound the row reads `no_fixture` and its note says why; the flip rate then carries the failure.
- `spearman_human` also needs at least 30 graded pairs (the bound of the judge audit). Two pairs always give +1 or -1.
- A recording with fewer than 30 pairs on today's inputs is too small a sample: all three rows read `no_fixture`.

## Recording (the owner's step)

```bash
EVAL_LIVE=1 EVAL_SCORER_RECORD=1 npm run eval:match -- --live [--market intl|cn]
```

Both switches are set in the shell for the command. Without `EVAL_SCORER_RECORD=1` a live run records nothing and replays what is committed, so a nightly live run does not call the scorer 600 more times.

For each market the suite draws 100 pooled pairs of the synthetic fixtures (every persona gives one pair before any gives a second), calls the pinned scorer three times per pair inside the market's brand, and writes:

- `eval/.snapshots/<date>/scorer/recorded.<market>.json`: scorer prompt, rubric and model id, the time, and per pair the hash of the prompt the model saw and its three raw answers (an answer that does not parse is kept as written; a call that failed is `null`);
- `eval/.snapshots/<date>/scorer/audit.<market>.csv`: the sheet for the recruiters, one row per recorded pair with an empty `human_grade_0_to_3` column.

The report of that run prints the three values measured on the new recording, with the model id, the date and the sample size in the row's note. Review the file, then copy it into this folder and commit it.

In every recorded call the model copies the requirement lines itself: the suite's repository stores no list on a posting, also when two pairs share a posting. So a pair's prompt and the meaning of its recorded answer never depend on which pair of a posting was scored first (recording runs four pairs at a time, replay runs them one by one). That is also the harder case for stability: in production the lines are stored once per posting and later scores only fill them in.

## The recruiters' grades

After recruiters filled the grade column of the sheet:

```bash
npx tsx server/src/features/match/eval/suites/scorer.suite.ts --import-audit <graded.csv> --market intl
```

writes `audit.intl.json` here (pairs with no grade are left out). It is a file conversion: no database, no model.

## When a recording goes stale

A recording is for the inputs it was made on. A pair whose prompt would be another today (the fixtures were regenerated, or the resume strip changed) is left out and counted in the row's note. When more than half of the pairs changed, the rows read `no_fixture` again and the note says to record again.
