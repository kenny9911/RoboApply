// server/src/features/jobs/import/limits.ts — the job-import abuse limits,
// persisted in `RARateCounter` (WP-35; ARCH §3.10, F-TRK-04).
//
//   - 10 imports per hour per user (`jobImportPerUser`, overridable through
//     RATE_LIMITS_JSON); a save that confirms a draft is not counted again,
//     once per draft (the draft's nonce is claimed, single use);
//   - 20 consecutive failed imports → a 1-hour lock (a success resets the run);
//   - the 3rd lock within 7 days is a 7-day lock.
// Every value lives in the database, so the limits hold across serverless
// instances and restarts. Keys:
//   rl:<brand>:jobImportFailures:user:<id>   one row, count = consecutive failures
//   rl:<brand>:jobImportLock:user:<id>       one row per lock, expiresAt = lock end
//   rl:<brand>:jobImportLockLog:user:<id>    one row per lock, kept 7 days (for the 3-in-7 rule)
//   rl:<brand>:jobImportDraftUsed:user:<id>:<nonce>
//                                            one row per confirmed draft, expiresAt = the draft's expiry
// `jobs-maintain` prunes rows whose expiresAt passed (platform pruneRateCounters).

import prisma from '../../../lib/prisma.js';
import {
  consumeRateLimit,
  rateLimitKey,
  rateLimitWindows,
  type RateLimitDb,
  type RateLimitResult,
} from '../../../platform/ratelimit/index.js';
import type { EnvSource } from '../../../platform/brand/index.js';
import { IMPORT_LIMITS } from './contract.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const EPOCH = new Date(0);

export interface LockState {
  until: Date;
}

export interface FailureResult {
  consecutive: number;
  /** Set when this failure started a lock. */
  lockedUntil: Date | null;
  longLock: boolean;
}

export interface ImportLimitStore {
  /** The end of the user's active lock, or null. */
  activeLock(userId: string, now: Date): Promise<Date | null>;
  /** Count one import against the hourly limit. */
  consumeHourly(userId: string, now: Date): Promise<Pick<RateLimitResult, 'allowed' | 'retryAfterSec'>>;
  recordFailure(userId: string, now: Date): Promise<FailureResult>;
  recordSuccess(userId: string): Promise<void>;
  /**
   * Claim a draft's single-use nonce for the save that confirms it. True the
   * first time only; any later save with the same draft is a new import.
   */
  claimDraft(userId: string, nonce: string, expiresAt: Date): Promise<boolean>;
}

/** The subset of `prisma.rARateCounter` this store uses. */
export interface CounterDelegate {
  findFirst(args: {
    where: { key: string; expiresAt?: { gt: Date } };
    orderBy?: { expiresAt: 'desc' };
    select: { count: true; expiresAt: true };
  }): Promise<{ count: number; expiresAt: Date } | null>;
  count(args: { where: { key: string; windowStart: { gte: Date } } }): Promise<number>;
  create(args: { data: { key: string; windowStart: Date; count: number; expiresAt: Date } }): Promise<unknown>;
  updateMany(args: { where: { key: string }; data: { count: { increment: number }; expiresAt: Date } }): Promise<{ count: number }>;
  deleteMany(args: { where: { key: string } }): Promise<{ count: number }>;
}

export interface LimitStoreDeps {
  counters?: CounterDelegate;
  /** Hourly counter (default: the platform fixed-window limiter on the same table). */
  consume?: (key: string, now: Date) => Promise<RateLimitResult>;
  db?: RateLimitDb;
  env?: EnvSource;
  /** Brand id in the keys (default: the request's brand). */
  brandId?: string;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export function createImportLimitStore(deps: LimitStoreDeps = {}): ImportLimitStore {
  const counters = (): CounterDelegate => deps.counters ?? (prisma.rARateCounter as unknown as CounterDelegate);
  const key = (name: string, userId: string) => rateLimitKey(name, 'user', userId, deps.brandId);
  const consume =
    deps.consume ??
    ((k: string, now: Date) => consumeRateLimit({ key: k, windows: rateLimitWindows('jobImportPerUser', deps.env), now, db: deps.db }));

  async function addRow(k: string, windowStart: Date, expiresAt: Date): Promise<void> {
    try {
      await counters().create({ data: { key: k, windowStart, count: 1, expiresAt } });
    } catch (err) {
      // Two locks in the same millisecond: one row is enough.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  return {
    async activeLock(userId, now) {
      const row = await counters().findFirst({
        where: { key: key('jobImportLock', userId), expiresAt: { gt: now } },
        orderBy: { expiresAt: 'desc' },
        select: { count: true, expiresAt: true },
      });
      return row?.expiresAt ?? null;
    },

    async consumeHourly(userId, now) {
      const r = await consume(key('jobImportPerUser', userId), now);
      return { allowed: r.allowed, retryAfterSec: r.retryAfterSec };
    },

    async recordFailure(userId, now) {
      const k = key('jobImportFailures', userId);
      const keepUntil = new Date(now.getTime() + IMPORT_LIMITS.longLockDays * DAY_MS);
      const { count } = await counters().updateMany({ where: { key: k }, data: { count: { increment: 1 }, expiresAt: keepUntil } });
      if (count === 0) {
        try {
          await counters().create({ data: { key: k, windowStart: EPOCH, count: 1, expiresAt: keepUntil } });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          await counters().updateMany({ where: { key: k }, data: { count: { increment: 1 }, expiresAt: keepUntil } });
        }
      }
      const row = await counters().findFirst({ where: { key: k }, select: { count: true, expiresAt: true } });
      const consecutive = row?.count ?? 1;
      if (consecutive < IMPORT_LIMITS.failuresBeforeLock) return { consecutive, lockedUntil: null, longLock: false };

      const logKey = key('jobImportLockLog', userId);
      const since = new Date(now.getTime() - IMPORT_LIMITS.longLockDays * DAY_MS);
      const earlier = await counters().count({ where: { key: logKey, windowStart: { gte: since } } });
      const longLock = earlier + 1 >= IMPORT_LIMITS.locksBeforeLongLock;
      const until = new Date(now.getTime() + (longLock ? IMPORT_LIMITS.longLockDays * DAY_MS : IMPORT_LIMITS.lockMinutes * MIN_MS));
      await addRow(key('jobImportLock', userId), now, until);
      await addRow(logKey, now, new Date(now.getTime() + IMPORT_LIMITS.longLockDays * DAY_MS));
      await counters().deleteMany({ where: { key: k } });
      return { consecutive, lockedUntil: until, longLock };
    },

    async recordSuccess(userId) {
      await counters().deleteMany({ where: { key: key('jobImportFailures', userId) } });
    },

    async claimDraft(userId, nonce, expiresAt) {
      const k = `${key('jobImportDraftUsed', userId)}:${nonce}`;
      if (await counters().findFirst({ where: { key: k }, select: { count: true, expiresAt: true } })) return false;
      try {
        // @@id([key, windowStart]) makes a concurrent second claim fail with P2002.
        await counters().create({ data: { key: k, windowStart: EPOCH, count: 1, expiresAt } });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
  };
}
