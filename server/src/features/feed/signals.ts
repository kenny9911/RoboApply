// server/src/features/feed/signals.ts — what a user did on the feed, for other
// areas (REQ-50-02): the Assistant's nudges read these instead of the feed's
// RAFeedRating and RAJobInteraction tables.
//
// The signatures are the Assistant's `NudgeSignals` (copilot/nudges.ts), so
// `feedSignals` drops in for its deprecated Prisma reader. Read-only; a signal
// is the user's own action, never an estimate.

type SignalsDb = {
  rAFeedRating: {
    findFirst(args: {
      where: { userId: string; createdAt: { gte: Date } };
      orderBy: { createdAt: 'desc' };
      select: { score: true; createdAt: true };
    }): Promise<{ score: number; createdAt: Date } | null>;
  };
  rAJobInteraction: {
    findFirst(args: { where: { userId: string; kind: 'report'; createdAt: { gte: Date } }; select: { id: true } }): Promise<{ id: string } | null>;
  };
};

export interface FeedSignals {
  /** The user's newest "rate your list" answer since `since`, or null. */
  latestRating(userId: string, since: Date): Promise<{ score: number; createdAt: Date } | null>;
  /** Did the user report a job since `since`? */
  reportedSince(userId: string, since: Date): Promise<boolean>;
}

const defaultDb = async (): Promise<SignalsDb> => (await import('../../lib/prisma.js')).default as unknown as SignalsDb;

export function createFeedSignals(getDb: () => Promise<SignalsDb> = defaultDb): FeedSignals {
  return {
    async latestRating(userId, since) {
      const p = await getDb();
      return p.rAFeedRating.findFirst({ where: { userId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, select: { score: true, createdAt: true } });
    },
    async reportedSince(userId, since) {
      const p = await getDb();
      const row = await p.rAJobInteraction.findFirst({ where: { userId, kind: 'report', createdAt: { gte: since } }, select: { id: true } });
      return Boolean(row);
    },
  };
}

export const feedSignals: FeedSignals = createFeedSignals();
