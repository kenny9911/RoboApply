// server/src/features/match/eval/invariants.eval.ts
//
// The ten invariants as Vitest cases (MARKET_STRATEGY.md 2.6). This module
// registers NOTHING at import. A test file calls
//
//   registerInvariants({ enforce: 'M1' | 'M2' | 'M4' | 'all' })
//
// which declares the ten cases. An invariant whose due phase is at or before
// `enforce` must pass. One due later is PENDING: it still runs (none is ever
// skipped), its result is recorded and printed, and it does not fail the run.
//
//   eval/invariants.entry.eval.ts   the harness entry (npm run eval:match; --enforce comes from the runner)
//   eval/enforced.test.ts           a later bundle puts the invariants of finished phases into npm test
//
// Each case stores `{ id, due, outcome, reason, enforced }` in the task's meta
// (`meta.evalInvariant`), which run.ts reads back through the Vitest node API.
//
// Vitest is loaded through a variable specifier, not a static import: this
// file compiles with the server (it is not a *.test.ts), and the server build
// must not depend on a test framework.

import { isEnforced, type Enforce, type Stage } from './invariantList.js';
import { INVARIANTS, reasonOf, type InvariantSpec } from './invariantSpecs.js';

export { INVARIANTS };
export type { InvariantSpec };

export interface InvariantOutcome {
  id: string;
  due: Stage;
  outcome: 'pass' | 'fail';
  /** Why it failed; null when it passed. */
  reason: string | null;
  /** False: the failure is reported and does not fail the run (due after the enforced phase). */
  enforced: boolean;
}

interface TaskLike {
  meta: Record<string, unknown>;
}
interface VitestLike {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: (ctx: { task: TaskLike }) => Promise<void>, timeout?: number): void;
}

const VITEST_MODULE = 'vitest';

async function loadVitest(): Promise<VitestLike | null> {
  try {
    return (await import(/* @vite-ignore */ VITEST_MODULE)) as VitestLike;
  } catch {
    return null;
  }
}

const vitest = await loadVitest();

/** Longest an invariant may take: they are in-memory, so this is generous. */
export const INVARIANT_TIMEOUT_MS = 30_000;

export function invariantTestName(spec: Pick<InvariantSpec, 'id' | 'title'>): string {
  return `${spec.id} ${spec.title}`;
}

/** Run one spec and say what happened; never throws. */
export async function runInvariant(spec: InvariantSpec, enforce: Enforce): Promise<InvariantOutcome> {
  const enforced = isEnforced(spec.due, enforce);
  try {
    await spec.run();
    return { id: spec.id, due: spec.due, outcome: 'pass', reason: null, enforced };
  } catch (err) {
    return { id: spec.id, due: spec.due, outcome: 'fail', reason: reasonOf(err), enforced };
  }
}

/**
 * Declare the ten invariants in the calling test file. Call it at the top
 * level of a file Vitest runs.
 */
export function registerInvariants(options: { enforce: Enforce }): void {
  if (!vitest) throw new Error('registerInvariants must be called from a file run by Vitest');
  const { describe, test } = vitest;
  describe(`match invariants (enforced through ${options.enforce})`, () => {
    for (const spec of INVARIANTS) {
      const enforced = isEnforced(spec.due, options.enforce);
      test(
        `${invariantTestName(spec)}${enforced ? '' : ` [pending until ${spec.due}]`}`,
        async ({ task }) => {
          const outcome = await runInvariant(spec, options.enforce);
          task.meta.evalInvariant = outcome;
          if (outcome.outcome === 'fail' && enforced) throw new Error(`${spec.id} (due ${spec.due}): ${outcome.reason}`);
        },
        INVARIANT_TIMEOUT_MS,
      );
    }
  });
}
