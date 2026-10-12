// server/src/platform/queue/index.ts — public surface of the work queue.
//
//   enqueue(kind, payload, { dedupeKey, runAfter, priority })   producer
//   drain(kinds, { budgetMs, concurrency })                       consumer (queue-drain cron)
//   kickDrain(kinds)                                              request-time `waitUntil` kick
//   registerWorkers(workers)                                      FND-5's registry.ts calls this
//   runForBudget / createBudget / CronTask                        time boxes and the cron contract

import { waitUntil } from '@vercel/functions';
import { logger } from '../../services/LoggerService.js';
import { drain, type DrainOptions, type DrainResult } from './drain.js';
import { KICK_BUDGET_MS } from './runForBudget.js';

export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRIORITY,
  WORK_STATUSES,
  assertValidKind,
  enqueue,
  enqueueMany,
} from './enqueue.js';
export type { EnqueueManyItem, EnqueueOptions, EnqueuedItem, QueueDb, WorkStatus } from './enqueue.js';
export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DeferWorkError,
  LEASE_MS,
  PermanentWorkError,
  backoffMs,
  drain,
  getWorker,
  leaseWorkItems,
  pruneWorkItems,
  registerWorker,
  registerWorkers,
  registeredKinds,
  resetWorkerRegistryForTests,
  retryDeadItem,
} from './drain.js';
export type {
  DrainOptions,
  DrainResult,
  LeaseOptions,
  LeasedWorkItem,
  WorkerContext,
  WorkerDefinition,
  WorkerHandler,
} from './drain.js';
export {
  CRON_BUDGET_MS,
  KICK_BUDGET_MS,
  NOT_IMPLEMENTED_RESULT,
  childBudget,
  createBudget,
  notImplementedCron,
  runForBudget,
} from './runForBudget.js';
export type {
  Budget,
  BudgetRunResult,
  Clock,
  CronContext,
  CronResult,
  CronTask,
  RunForBudgetOptions,
  StepResult,
} from './runForBudget.js';

/**
 * Start a short drain after the response is sent (ARCH §4.6). On Vercel the
 * function stays alive for it through `waitUntil`; elsewhere the promise
 * simply runs in-process and the `queue-drain` cron covers anything left.
 * Never throws; returns the promise for tests.
 */
export function kickDrain(kinds: string[], options: DrainOptions = {}): Promise<DrainResult | null> {
  const run = drain(kinds, { budgetMs: KICK_BUDGET_MS, ...options }).catch((err) => {
    logger.warn('QUEUE', 'drain kick failed', { kinds, error: err instanceof Error ? err.message : String(err) });
    return null;
  });
  try {
    waitUntil(run);
  } catch {
    // Not inside a Vercel request context: the promise already runs.
  }
  return run;
}
