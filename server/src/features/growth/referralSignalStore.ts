// server/src/features/growth/referralSignalStore.ts — where invite risk
// signals live (WP-60).
//
// Hashed request signals (referralRisk.ts) are kept 30 days so the reward
// check can compare the inviter's and the friend's browsers and networks.
// Their own table, requested from SCHEMA-5 as SR-60-1:
//
//   /// Invite-reward risk signals (F-GROW-01; SR-60-1). Keyed hashes only
//   /// (HMAC; never a raw IP or User-Agent); deleted after 30 days and with
//   /// the account.
//   model RAReferralSignal {          // ra-growth.prisma
//     id         String   @id @default(cuid())
//     userId     String
//     user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
//     brand      String
//     ipHash     String?
//     uaHash     String?
//     deviceHash String?
//     createdAt  DateTime @default(now())
//
//     @@index([userId, createdAt])
//     @@index([createdAt])
//   }
//   // User: raReferralSignals RAReferralSignal[]
//
// Until the model is generated the delegate does not exist: the store
// resolves to null, nothing is recorded, and every qualified referral is
// held for review with reason `signals_unavailable` (fail closed). After
// SCHEMA-5 the same code runs against the table.

import type { HashedSignals, SignalRow } from './referralRisk.js';

export interface ReferralSignalStore {
  /** Store one row; false when it was a duplicate or the user hit the daily cap. */
  record(input: { userId: string; brand: string; signals: HashedSignals; at: Date }): Promise<boolean>;
  /**
   * Rows of these users created at or after `since`, newest first. Each user
   * is read on its own (up to MAX_ROWS_PER_USER), so one person's rows can
   * never push another person's out of the comparison.
   */
  forUsers(userIds: string[], since: Date): Promise<SignalRow[]>;
  /** Delete rows created before `before`; returns the count. */
  prune(before: Date): Promise<number>;
  /** When the oldest stored row was created (null = none), to schedule the next prune. */
  oldestAt(): Promise<Date | null>;
}

type SignalData = { userId: string; brand: string; createdAt: Date } & HashedSignals;
type SignalWhere = { userId?: string; createdAt?: { gte: Date } } & Partial<HashedSignals>;

/** The subset of the (requested) Prisma delegate this adapter uses. */
export interface ReferralSignalDelegate {
  findFirst(args: { where: SignalWhere; select: { id?: true; createdAt?: true }; orderBy?: { createdAt: 'asc' } }): Promise<{ id?: string; createdAt?: Date } | null>;
  findMany(args: {
    where: { userId: string; createdAt: { gte: Date } };
    select: { userId: true; ipHash: true; uaHash: true; deviceHash: true; createdAt: true };
    orderBy: { createdAt: 'desc' };
    take: number;
  }): Promise<SignalRow[]>;
  count(args: { where: { userId: string; createdAt: { gte: Date } } }): Promise<number>;
  create(args: { data: SignalData }): Promise<unknown>;
  deleteMany(args: { where: { createdAt: { lt: Date } } }): Promise<{ count: number }>;
}

/** The same hashes from the same user within this window are stored once. */
export const SIGNAL_DEDUPE_MS = 60 * 60 * 1000;
/** At most this many rows per user in any 24 hours (bounds the table and request spam). */
export const MAX_ROWS_PER_USER_PER_DAY = 50;
/** Rows read per user for one comparison (50/day × 30 days fits). */
export const MAX_ROWS_PER_USER = MAX_ROWS_PER_USER_PER_DAY * 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createDelegateSignalStore(delegate: ReferralSignalDelegate): ReferralSignalStore {
  return {
    async record({ userId, brand, signals, at }) {
      const recent = await delegate.findFirst({
        where: { userId, createdAt: { gte: new Date(at.getTime() - SIGNAL_DEDUPE_MS) }, ...signals },
        select: { id: true },
      });
      if (recent) return false;
      const today = await delegate.count({ where: { userId, createdAt: { gte: new Date(at.getTime() - DAY_MS) } } });
      if (today >= MAX_ROWS_PER_USER_PER_DAY) return false;
      await delegate.create({ data: { userId, brand, ...signals, createdAt: at } });
      return true;
    },
    async forUsers(userIds, since) {
      const out: SignalRow[] = [];
      for (const userId of new Set(userIds)) {
        const rows = await delegate.findMany({
          where: { userId, createdAt: { gte: since } },
          select: { userId: true, ipHash: true, uaHash: true, deviceHash: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: MAX_ROWS_PER_USER,
        });
        out.push(...rows);
      }
      return out;
    },
    async prune(before) {
      const { count } = await delegate.deleteMany({ where: { createdAt: { lt: before } } });
      return count;
    },
    async oldestAt() {
      const row = await delegate.findFirst({ where: {}, select: { createdAt: true }, orderBy: { createdAt: 'asc' } });
      return row?.createdAt ?? null;
    },
  };
}

/** The store backed by `prisma.rAReferralSignal`, or null while SR-60-1 is pending. */
export function resolvePrismaSignalStore(db: unknown): ReferralSignalStore | null {
  let delegate: unknown;
  try {
    delegate = (db as { rAReferralSignal?: unknown } | null)?.rAReferralSignal;
  } catch {
    return null;
  }
  const d = delegate as Partial<ReferralSignalDelegate> | undefined;
  if (
    !d ||
    typeof d.findFirst !== 'function' ||
    typeof d.findMany !== 'function' ||
    typeof d.count !== 'function' ||
    typeof d.create !== 'function' ||
    typeof d.deleteMany !== 'function'
  ) {
    return null;
  }
  return createDelegateSignalStore(d as ReferralSignalDelegate);
}
