// server/src/features/push/repo.ts — `RAPushSubscription` access (typed Prisma).
//
// The default repo imports Prisma lazily, so importing this area (the router,
// the delivery channel) opens no pool until a request or a send needs one.

import type prismaClient from '../../lib/prisma.js';

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  brand: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  failedCount: number;
  lastOkAt: Date | null;
  createdAt: Date;
}

export interface UpsertPushSubscription {
  userId: string;
  brand: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

export interface PushRepo {
  /**
   * Insert, or take over the row with the same endpoint (one browser profile
   * = one endpoint; the account signed in last owns it), resetting failures.
   */
  upsert(input: UpsertPushSubscription): Promise<PushSubscriptionRow>;
  /** The person's devices on a brand, oldest first. */
  listForUser(userId: string, brand: string): Promise<PushSubscriptionRow[]>;
  /** One row, only when it belongs to the user. */
  findOwned(id: string, userId: string): Promise<PushSubscriptionRow | null>;
  /** The row for a browser endpoint, whoever owns it (callers check ownership). */
  findByEndpoint(endpoint: string): Promise<PushSubscriptionRow | null>;
  deleteIds(ids: string[]): Promise<number>;
  markOk(id: string, at: Date): Promise<void>;
  /** failedCount += 1; returns the new count. */
  markFailed(id: string): Promise<number>;
  /** Stamp `SeekerNotification.pushSentAt` on the mirrored inbox row. */
  markNotificationPushed(notificationId: string, at: Date): Promise<void>;
}

type Db = Pick<typeof prismaClient, 'rAPushSubscription' | 'seekerNotification'>;

const SELECT = {
  id: true,
  userId: true,
  brand: true,
  endpoint: true,
  p256dh: true,
  auth: true,
  userAgent: true,
  failedCount: true,
  lastOkAt: true,
  createdAt: true,
} as const;

async function defaultDb(): Promise<Db> {
  return (await import('../../lib/prisma.js')).default;
}

export function createPrismaPushRepo(getDb: () => Promise<Db> = defaultDb): PushRepo {
  return {
    async upsert(input) {
      const db = await getDb();
      return db.rAPushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: { ...input },
        update: {
          userId: input.userId,
          brand: input.brand,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent,
          failedCount: 0,
        },
        select: SELECT,
      });
    },
    async listForUser(userId, brand) {
      const db = await getDb();
      return db.rAPushSubscription.findMany({ where: { userId, brand }, orderBy: { createdAt: 'asc' }, select: SELECT });
    },
    async findOwned(id, userId) {
      const db = await getDb();
      return db.rAPushSubscription.findFirst({ where: { id, userId }, select: SELECT });
    },
    async findByEndpoint(endpoint) {
      const db = await getDb();
      return db.rAPushSubscription.findUnique({ where: { endpoint }, select: SELECT });
    },
    async deleteIds(ids) {
      if (!ids.length) return 0;
      const db = await getDb();
      const { count } = await db.rAPushSubscription.deleteMany({ where: { id: { in: ids } } });
      return count;
    },
    async markOk(id, at) {
      const db = await getDb();
      await db.rAPushSubscription.updateMany({ where: { id }, data: { lastOkAt: at, failedCount: 0 } });
    },
    async markFailed(id) {
      const db = await getDb();
      const row = await db.rAPushSubscription.update({ where: { id }, data: { failedCount: { increment: 1 } }, select: { failedCount: true } });
      return row.failedCount;
    },
    async markNotificationPushed(notificationId, at) {
      const db = await getDb();
      await db.seekerNotification.updateMany({ where: { id: notificationId }, data: { pushSentAt: at } });
    },
  };
}
