// @vitest-environment node
//
// The Prisma tailor store's job scope and the hub's review-session read
// (INT-10). Prisma is a recording fake; no database.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  jobFindFirst: vi.fn(async (_args: { where: Record<string, unknown> }) => null as unknown),
  sessionFindMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [] as Array<{ id: string; resultVariantId: string | null }>),
}));
vi.mock('../../../lib/prisma.js', () => ({
  default: { rAJob: { findFirst: db.jobFindFirst }, rATailorSession: { findMany: db.sessionFindMany } },
}));

import { createPrismaTailorStore } from './store.js';

const saved = process.env.CN_RECRUITMENT_INFO_MODE;
beforeEach(() => {
  db.jobFindFirst.mockClear();
  db.sessionFindMany.mockClear();
  delete process.env.CN_RECRUITMENT_INFO_MODE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
  else process.env.CN_RECRUITMENT_INFO_MODE = saved;
});

const whereOf = () => db.jobFindFirst.mock.calls[0]![0].where as { id: string; market: string; AND: Array<{ OR: unknown[] }> };

describe('findJob scope', () => {
  it('RoboApply: the market, and public rows or the user\'s own', async () => {
    await createPrismaTailorStore().findJob('u1', 'job_1', 'intl');
    expect(whereOf()).toEqual({ id: 'job_1', market: 'intl', AND: [{ OR: [{ visibility: 'public' }, { ownerUserId: 'u1' }] }] });
  });

  it('GoApply with the recruitment-info mode off (default): only the user\'s own imports', async () => {
    await createPrismaTailorStore().findJob('u1', 'job_1', 'cn');
    const where = whereOf();
    expect(where.market).toBe('cn');
    expect(where.AND).toHaveLength(2);
    // The mode fragment admits no public posting.
    expect(where.AND[1]).toEqual({ OR: [{ visibility: 'private', ownerUserId: 'u1' }] });
  });

  it('GoApply with postings allowed: public postings and the user\'s own imports', async () => {
    process.env.CN_RECRUITMENT_INFO_MODE = 'licensed';
    await createPrismaTailorStore().findJob('u1', 'job_1', 'cn');
    expect(whereOf().AND[1]).toEqual({ OR: [{ visibility: 'public' }, { visibility: 'private', ownerUserId: 'u1' }] });
  });
});

describe('findReviewSessions', () => {
  it('reads the user\'s sessions in review for the given versions, newest first', async () => {
    db.sessionFindMany.mockResolvedValueOnce([
      { id: 'ts_2', resultVariantId: 'rv_a' },
      { id: 'ts_1', resultVariantId: 'rv_a' },
      { id: 'ts_0', resultVariantId: null },
    ]);
    const rows = await createPrismaTailorStore().findReviewSessions('u1', ['rv_a', 'rv_b']);
    expect(db.sessionFindMany).toHaveBeenCalledWith({
      where: { userId: 'u1', status: 'review', resultVariantId: { in: ['rv_a', 'rv_b'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, resultVariantId: true },
    });
    expect(rows).toEqual([
      { id: 'ts_2', resultVariantId: 'rv_a' },
      { id: 'ts_1', resultVariantId: 'rv_a' },
    ]);
  });

  it('asks nothing for an empty list', async () => {
    await expect(createPrismaTailorStore().findReviewSessions('u1', [])).resolves.toEqual([]);
    expect(db.sessionFindMany).not.toHaveBeenCalled();
  });
});
