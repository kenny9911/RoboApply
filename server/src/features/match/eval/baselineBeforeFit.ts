// server/src/features/match/eval/baselineBeforeFit.ts
//
// Where the first ranking baseline came from (fixtures/baselines.json).
//
//   npx tsx server/src/features/match/eval/baselineBeforeFit.ts
//
// The ranking gate is "no regression against the stored baseline". The phase
// that changes ranking most (the fit contract and estimate v2, MKT-1F) merges
// together with this harness, so the baseline has to be the order BEFORE that
// change, or the gate cannot fail at the merge. Before the fit contract the
// list read is `MatchService.preScoreMany` (the stored AI score, else the
// quick estimate). This script puts that read behind the `getFits` signature
// (testdata/fitShim.ts), runs the ranking suite on the committed fixtures and
// writes the values to fixtures/baselines.json with what they were measured on.
//
// It runs only on a checkout WITHOUT features/match/fit.ts. Once the fit
// contract exists, `preScoreMany` is the contract's own list read and "the
// order before" is gone: the script refuses, and a later baseline is written
// by `npm run eval:match -- --write-baseline` when a ranking change is
// accepted on purpose.
//
// Offline like every fixture run: no network, no database, no model.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFilesHash } from './fixtures/load.js';
import { FIXTURE_FILES } from './fixtures/schema.js';
import { installOfflineGuard, pinOfflineEnv } from './offline.js';
import { FIXTURES_DIR, SUITES_DIR, baselineValues, buildReport, discoverSuites, runSuites, writeBaselines } from './run.js';
import { EVAL_DIR, REPO_ROOT, setFitModuleForTests } from './seams.js';
import type { BaselinesFile } from './fixtures/schema.js';

export const BEFORE_FIT_COMMAND = 'npx tsx server/src/features/match/eval/baselineBeforeFit.ts';
export const BEFORE_FIT_SOURCE =
  'the list read before the fit contract (MatchService.preScoreMany: the stored AI score, else the quick estimate) on the committed fixtures, measured on a checkout without features/match/fit.ts';

export class BaselineRefused extends Error {}

export interface BeforeFitInput {
  fixturesDir?: string;
  /** Where the baseline is written (default: `<fixturesDir>/baselines.json`). */
  outFile?: string;
  now?: Date;
  /** Does the fit contract exist in this checkout? Default: is features/match/fit.ts on disk. */
  fitContractExists?: boolean;
}

/** Measure the ranking suite on the pre-contract list read and write the baseline. Answers what was written. */
export async function writeBaselineBeforeFit(input: BeforeFitInput = {}): Promise<BaselinesFile> {
  const fixturesDir = input.fixturesDir ?? FIXTURES_DIR;
  const exists = input.fitContractExists ?? existsSync(path.join(REPO_ROOT, 'server/src/features/match/fit.ts'));
  if (exists) {
    throw new BaselineRefused(
      'features/match/fit.ts exists: the list read before the fit contract is gone, so this script has nothing to measure. To accept the current order as the new baseline, run: npm run eval:match -- --write-baseline',
    );
  }
  const now = input.now ?? new Date();
  setFitModuleForTests(path.join(EVAL_DIR, 'testdata', 'fitShim.ts'));
  try {
    const ctx = { markets: ['intl' as const, 'cn' as const], live: false, repoRoot: REPO_ROOT, evalDir: EVAL_DIR, fixturesDir, now };
    const suites = await runSuites(discoverSuites(SUITES_DIR), ctx, 'ranking');
    const failed = suites.find((s) => s.error || s.notBuilt);
    if (!suites.length || failed) throw new Error(`the ranking suite did not measure: ${failed?.error ?? failed?.notBuilt ?? 'no suite named ranking'}`);
    const report = buildReport({ enforce: 'all', live: false, invariants: [], suites, baselines: {}, audit: null, listUnbuilt: false });
    const values = baselineValues(report.rows, false);
    if (!Object.keys(values).length) throw new Error('the ranking suite reported no value to store (are the fixtures on disk?)');
    return writeBaselines(input.outFile ?? path.join(fixturesDir, FIXTURE_FILES.baselines), values, now, { generatedBy: BEFORE_FIT_COMMAND, source: BEFORE_FIT_SOURCE, fixturesHash: fixtureFilesHash(fixturesDir) });
  } finally {
    setFitModuleForTests(null);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  pinOfflineEnv();
  installOfflineGuard();
  writeBaselineBeforeFit().then(
    (file) => {
      for (const [key, value] of Object.entries(file.values)) console.log(`${key} = ${value.toFixed(6)}`);
      console.log(`Baseline written to ${path.relative(REPO_ROOT, path.join(FIXTURES_DIR, FIXTURE_FILES.baselines))} (fixtures ${file.fixturesHash?.slice(0, 12)}).`);
      process.exit(0);
    },
    (err) => {
      console.error(err instanceof BaselineRefused ? err.message : err);
      process.exit(err instanceof BaselineRefused ? 2 : 1);
    },
  );
}
