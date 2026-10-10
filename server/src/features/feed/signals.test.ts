// @vitest-environment node
//
// REQ-50-02: `feedSignals` has the exact signatures of the Assistant's
// `NudgeSignals` (copilot/nudges.ts) and reads only the asking user's rows.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import type { NudgeSignals } from '../copilot/nudges.js';
import { createFeedSignals, feedSignals, type FeedSignals } from './signals.js';

const day = (d: number) => new Date(Date.UTC(2026, 9, d));

function fakeDb() {
  const ratings = [
    { userId: 'u1', score: 4, createdAt: day(3) },
    { userId: 'u1', score: 8, createdAt: day(6) },
    { userId: 'u2', score: 2, createdAt: day(9) },
  ];
  const interactions = [
    { id: 'i1', userId: 'u1', kind: 'report', createdAt: day(2) },
    { id: 'i2', userId: 'u1', kind: 'hide', createdAt: day(8) },
    { id: 'i3', userId: 'u2', kind: 'report', createdAt: day(8) },
  ];
  return {
    rAFeedRating: {
      async findFirst({ where }: { where: { userId: string; createdAt: { gte: Date } } }) {
        const rows = ratings.filter((r) => r.userId === where.userId && r.createdAt >= where.createdAt.gte).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ? { score: rows[0].score, createdAt: rows[0].createdAt } : null;
      },
    },
    rAJobInteraction: {
      async findFirst({ where }: { where: { userId: string; kind: string; createdAt: { gte: Date } } }) {
        const row = interactions.find((r) => r.userId === where.userId && r.kind === where.kind && r.createdAt >= where.createdAt.gte);
        return row ? { id: row.id } : null;
      },
    },
  };
}

describe('feedSignals', () => {
  const signals = createFeedSignals(async () => fakeDb());

  it("latestRating: the user's newest rating since the date, or null", async () => {
    expect(await signals.latestRating('u1', day(1))).toEqual({ score: 8, createdAt: day(6) });
    expect(await signals.latestRating('u1', day(7))).toBeNull();
    expect(await signals.latestRating('nobody', day(1))).toBeNull();
  });

  it('reportedSince: only a report, only this user, only since the date', async () => {
    expect(await signals.reportedSince('u1', day(1))).toBe(true);
    expect(await signals.reportedSince('u1', day(5))).toBe(false); // the later row is a hide, and the other report is another user's
    expect(await signals.reportedSince('nobody', day(1))).toBe(false);
  });

  it("has the exact shape of the Assistant's NudgeSignals (drop-in for the deprecated reader)", () => {
    const asNudge: NudgeSignals = feedSignals;
    const back: FeedSignals = asNudge;
    expect(Object.keys(back).sort()).toEqual(['latestRating', 'reportedSince']);
  });
});
