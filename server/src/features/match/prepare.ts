// server/src/features/match/prepare.ts — the preparer hook (MARKET_TASK_PLAN 3.3).
//
// The estimate is synchronous: it scores hundreds of rows per request with no
// I/O. Anything it needs that must be loaded first (the canonical skill
// vocabulary of a later phase) registers an async loader here, and
// `MatchService.userContext` awaits `runMatchPreparers()` before it builds the
// person's side, so the estimate always runs against loaded data.
//
// Each preparer runs once per process. A preparer that fails is not marked as
// done: the call that triggered it rejects, and the next call runs it again.
// With nothing registered (this phase) the call resolves at once.
//
// `MatchService.userContext` logs a failure and goes on (a loader that cannot
// run must not take every list and job page down), so a preparer's consumer
// has to work, with less, while its data is not loaded.

export type MatchPreparer = () => Promise<void>;

interface Entry {
  fn: MatchPreparer;
  done: boolean;
  running: Promise<void> | null;
}

const entries: Entry[] = [];

/** Register a loader to await before the first estimate. Registering the same function twice is a no-op. */
export function registerMatchPreparer(fn: MatchPreparer): void {
  if (entries.some((e) => e.fn === fn)) return;
  entries.push({ fn, done: false, running: null });
}

function runOne(entry: Entry): Promise<void> {
  if (entry.done) return Promise.resolve();
  if (!entry.running) {
    entry.running = Promise.resolve()
      .then(() => entry.fn())
      .then(
        () => {
          entry.done = true;
          entry.running = null;
        },
        (err: unknown) => {
          // Not done: the next call tries again.
          entry.running = null;
          throw err;
        },
      );
  }
  return entry.running;
}

/**
 * Await every registered preparer, in registration order. Concurrent callers
 * share one run. Stops at the first failure and rejects with it; preparers
 * that already finished are not run again.
 */
export async function runMatchPreparers(): Promise<void> {
  for (const entry of entries) {
    if (entry.done) continue;
    await runOne(entry);
  }
}

/** Test seam: forget every registered preparer. */
export function resetMatchPreparersForTests(): void {
  entries.length = 0;
}
