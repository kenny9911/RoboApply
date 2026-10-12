// server/src/platform/queue/runForBudget.ts
//
// Time boxes for crons and the queue drain (ARCHITECTURE.md §4.6). Vercel
// bounds each function call by `maxDuration` (300 s here), may deliver a cron
// twice, and runs at most once a minute per entry. Every handler therefore
// works in short steps inside a 240 s budget and stops starting new steps
// when the budget is spent; leases make the next tick pick up the rest.
//
// Also home to the cron task contract every `server/src/features/<area>/cron.ts`
// implements (CronTask), so the area stubs and the HTTP/node-cron runners in
// server/src/cron/handlers.ts share one shape.

import type { ProductBrand } from '../brand/registry.js';

/** The per-invocation budget for every cron handler (ARCH §4.6). */
export const CRON_BUDGET_MS = 240_000;
/** Budget for the request-time `waitUntil` drain kick. */
export const KICK_BUDGET_MS = 20_000;

export type Clock = () => number;

export interface Budget {
  readonly startedAt: number;
  readonly deadline: number;
  readonly budgetMs: number;
  /** Milliseconds left (never negative). */
  remainingMs(): number;
  /** Milliseconds since start. */
  elapsedMs(): number;
  /** True once `remainingMs() <= reserveMs`. */
  exhausted(reserveMs?: number): boolean;
}

export function createBudget(budgetMs: number, now: Clock = Date.now): Budget {
  const startedAt = now();
  const deadline = startedAt + Math.max(0, budgetMs);
  return {
    startedAt,
    deadline,
    budgetMs,
    remainingMs: () => Math.max(0, deadline - now()),
    elapsedMs: () => now() - startedAt,
    exhausted: (reserveMs = 0) => deadline - now() <= reserveMs,
  };
}

/** A sub-budget that never outlives its parent. */
export function childBudget(parent: Budget, budgetMs: number, now: Clock = Date.now): Budget {
  return createBudget(Math.min(budgetMs, parent.remainingMs()), now);
}

/** What one step reports. `more: false` (or `done: true`) ends the run early. */
export interface StepResult {
  /** Units of work this step completed (summed into `processed`). */
  processed?: number;
  /** False when there is no more work right now. Defaults to true when `processed > 0`, else false. */
  more?: boolean;
}

export interface RunForBudgetOptions {
  budgetMs?: number;
  /** Stop starting steps when this many ms remain (default 2 s). */
  reserveMs?: number;
  /** Hard cap on steps (a guard against a step that always reports more). */
  maxSteps?: number;
  now?: Clock;
}

export interface BudgetRunResult {
  steps: number;
  processed: number;
  stoppedBy: 'idle' | 'budget' | 'max_steps';
  ms: number;
}

/**
 * Call `step` repeatedly until it reports no more work, the budget is spent,
 * or `maxSteps` is reached. A step is never interrupted: it receives the
 * budget and must size its own work (e.g. lease fewer items) to fit.
 * Errors from a step propagate to the caller.
 */
export async function runForBudget(
  step: (budget: Budget, index: number) => Promise<StepResult | void>,
  options: RunForBudgetOptions = {},
): Promise<BudgetRunResult> {
  const now = options.now ?? Date.now;
  const budget = createBudget(options.budgetMs ?? CRON_BUDGET_MS, now);
  const reserveMs = options.reserveMs ?? 2_000;
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  let steps = 0;
  let processed = 0;
  let stoppedBy: BudgetRunResult['stoppedBy'] = 'idle';

  for (;;) {
    if (budget.exhausted(reserveMs)) {
      stoppedBy = 'budget';
      break;
    }
    if (steps >= maxSteps) {
      stoppedBy = 'max_steps';
      break;
    }
    const result = (await step(budget, steps)) ?? {};
    steps += 1;
    const n = result.processed ?? 0;
    processed += n;
    const more = result.more ?? n > 0;
    if (!more) {
      stoppedBy = 'idle';
      break;
    }
  }
  return { steps, processed, stoppedBy, ms: budget.elapsedMs() };
}

// ── Cron task contract ────────────────────────────────────────────────────

/** Context handed to every area cron task; runs inside `runWithBrand(brand.id, …)`. */
export interface CronContext {
  /** Cron path name, e.g. 'jobs-ingest'. */
  name: string;
  brand: ProductBrand;
  /** Shared budget for this invocation (one per brand run). */
  budget: Budget;
  /** Invocation time. */
  now: Date;
}

/**
 * What a cron task returns; logged and echoed in the HTTP response.
 * Return `{ skipped: 'no_work' }` (or `processed: 0`) quickly when idle:
 * every cron must answer in under 2 s when nothing is due (R-6).
 */
export interface CronResult {
  skipped?: 'not_implemented' | 'no_work' | 'disabled' | 'not_for_market' | (string & {});
  processed?: number;
  [key: string]: unknown;
}

export type CronTask = (ctx: CronContext) => Promise<CronResult>;

/** The result every unfilled stub returns. */
export const NOT_IMPLEMENTED_RESULT: Readonly<CronResult> = Object.freeze({ skipped: 'not_implemented' });

/**
 * A stub cron task: returns `{ skipped: 'not_implemented' }` at once and never
 * throws. The owning WP replaces the export with a real task.
 */
export function notImplementedCron(_owner: string): CronTask {
  return async () => ({ ...NOT_IMPLEMENTED_RESULT });
}
