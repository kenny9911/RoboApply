// server/src/features/growth/workers.ts — queue workers of the growth area
// (WP-23 → WP-60). server/src/platform/queue/registry.ts imports `workers`
// and registers them; the queue-drain cron runs them inside the item's brand.
//
//   growth.referralRisk         one item per invite (dedupe `growth.referral:<id>`),
//                               queued at signup. Waits until the friend is verified
//                               and has finished setup, then runs the risk check:
//                               held for review, or both practice credits granted
//                               (referrals.ts `evaluateReferral`). While the friend
//                               is not there yet the item is put back without using
//                               an attempt: every 30 min on day 1, every 6 h in the
//                               first week, then daily until day 30. After that it
//                               stops; the friend's own activity (`noteActivity`)
//                               and the `checkReferralFor` seam still check it.
//   growth.referralSignalPrune  deletes risk signals older than 30 days. Queued
//                               (one per brand, dedupe `growth.referralSignalPrune:<brand>`)
//                               whenever a signal row is stored, and re-queued by
//                               itself until no rows are left, so deletion never
//                               depends on referral work existing. INT may also call
//                               `pruneReferralSignals()` from the daily cron.

import { DeferWorkError, type LeasedWorkItem, type WorkerDefinition } from '../../platform/queue/index.js';
import { logger } from '../../services/LoggerService.js';
import { SIGNAL_PRUNE_WORK_KIND, referralServiceImpl, type EvaluateOutcome, type ReferralService } from './referrals.js';

export const GROWTH_WORK_KINDS = { referralRiskHold: 'growth.referralRisk', referralSignalPrune: SIGNAL_PRUNE_WORK_KIND } as const;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Stop polling a friend who has not finished after this long. */
export const REFERRAL_WAIT_MAX_MS = 30 * DAY;
/** The prune item never runs more often than this. */
export const PRUNE_MIN_DELAY_MS = HOUR;

/** How long to wait before the next look at a referral that is not qualified yet. */
export function nextCheckDelayMs(ageMs: number): number | null {
  if (ageMs >= REFERRAL_WAIT_MAX_MS) return null;
  if (ageMs < DAY) return 30 * MIN;
  if (ageMs < 7 * DAY) return 6 * HOUR;
  return DAY;
}

export interface ReferralWorkerDeps {
  service?: Pick<ReferralService, 'evaluateReferral'>;
  /** When the referral was created (for the polling schedule); default: read it. */
  createdAt?: (referralId: string) => Promise<Date | null>;
  now?: () => Date;
}

async function defaultCreatedAt(referralId: string): Promise<Date | null> {
  const { default: prisma } = await import('../../lib/prisma.js');
  const row = await prisma.rAReferral.findUnique({ where: { id: referralId }, select: { createdAt: true } });
  return row?.createdAt ?? null;
}

export function createReferralWorker(deps: ReferralWorkerDeps = {}): WorkerDefinition<{ referralId?: unknown }> {
  const service = deps.service ?? referralServiceImpl;
  const createdAt = deps.createdAt ?? defaultCreatedAt;
  const now = deps.now ?? (() => new Date());

  return {
    kind: GROWTH_WORK_KINDS.referralRiskHold,
    // One at a time per drain, so two invites of one person do not both
    // take the last reward of the year.
    concurrency: 1,
    async handler(item: LeasedWorkItem<{ referralId?: unknown }>) {
      const referralId = typeof item.payload?.referralId === 'string' ? item.payload.referralId : null;
      if (!referralId) return; // malformed payload: nothing to do
      const outcome: EvaluateOutcome = await service.evaluateReferral(referralId);
      if (outcome === 'retry') throw new DeferWorkError(5 * MIN, 'referral grant in progress');
      if (outcome !== 'waiting') return;
      const created = await createdAt(referralId);
      const delay = created ? nextCheckDelayMs(now().getTime() - created.getTime()) : null;
      if (delay !== null) throw new DeferWorkError(delay, 'friend not verified or not set up yet');
    },
  };
}

export interface SignalPruneWorkerDeps {
  service?: Pick<ReferralService, 'pruneSignals'>;
  now?: () => Date;
}

export function createSignalPruneWorker(deps: SignalPruneWorkerDeps = {}): WorkerDefinition<unknown> {
  const service = deps.service ?? referralServiceImpl;
  const now = deps.now ?? (() => new Date());
  return {
    kind: GROWTH_WORK_KINDS.referralSignalPrune,
    concurrency: 1,
    async handler() {
      const { deleted, nextAt } = await service.pruneSignals({ now: now() });
      if (deleted > 0) logger.info('GROWTH', 'referral signals pruned', { deleted });
      // Rows remain: come back when the oldest one turns 30 days old.
      if (nextAt) throw new DeferWorkError(Math.max(PRUNE_MIN_DELAY_MS, nextAt.getTime() - now().getTime()), 'next signal expiry');
    },
  };
}

export const workers: WorkerDefinition[] = [createReferralWorker() as WorkerDefinition, createSignalPruneWorker() as WorkerDefinition];
