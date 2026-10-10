// @vitest-environment node
// WP-59 Prisma store: query shapes that carry product rules (no database; prisma mocked).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rAInterviewQuestion: { findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
  rAQuestionReport: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  rAQuestionContribution: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  rACompany: { findUnique: vi.fn(), findMany: vi.fn() },
  rAJob: { findMany: vi.fn() },
  seekerProfile: { findUnique: vi.fn() },
  seekerActivityLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../lib/prisma.js', () => ({ default: db }));

import { createPrismaPrepStore } from './store.js';

beforeEach(() => {
  for (const model of Object.values(db)) {
    if (typeof model === 'function') (model as ReturnType<typeof vi.fn>).mockReset();
    else for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

describe('Prisma prep store', () => {
  it('company lists count only published user reports of the market', async () => {
    db.rAInterviewQuestion.groupBy.mockResolvedValue([{ companyNameNormalized: 'acme', _count: { _all: 2 }, _max: { reportedPeriod: '2026-09', companyId: 'co1' } }]);
    const store = await createPrismaPrepStore();
    const groups = await store.listCompanyGroups('intl', { nameContains: 'ac', offset: 0, take: 31 });
    expect(groups).toEqual([{ nameNormalized: 'acme', companyId: 'co1', count: 2, latestPeriod: '2026-09' }]);
    const args = db.rAInterviewQuestion.groupBy.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      where: { market: 'intl', sourceKind: 'user_report', status: 'published', companyNameNormalized: { contains: 'ac' } },
    });
    // One group per company name: rows with and without a company record are not split.
    expect(args.by).toEqual(['companyNameNormalized']);
  });

  it('company questions match the record or the normalized name', async () => {
    db.rAInterviewQuestion.findMany.mockResolvedValue([]);
    const store = await createPrismaPrepStore();
    await store.listQuestions({ market: 'cn', sourceKind: 'user_report', status: 'published', company: { companyId: 'co1', nameNormalized: 'acme' } }, { take: 20 });
    expect(db.rAInterviewQuestion.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { market: 'cn', sourceKind: 'user_report', status: 'published', OR: [{ companyId: 'co1' }, { companyNameNormalized: 'acme' }] },
      take: 21,
    });
  });

  it('other postings: public, canonical, open, same market, never the job itself', async () => {
    db.rAJob.findMany.mockResolvedValue([{ title: 'Data Engineer' }, { title: 'Data Engineer' }, { title: ' SRE ' }]);
    const store = await createPrismaPrepStore();
    const titles = await store.otherPostingTitles({ jobId: 'j1', companyId: 'co1', companyNameNormalized: 'acme', market: 'intl', take: 8, where: { OR: [{ visibility: 'public' }] } });
    expect(titles).toEqual(['Data Engineer', 'SRE']);
    const where = db.rAJob.findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toEqual([
      { companyId: 'co1' },
      { id: { not: 'j1' }, market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
      { OR: [{ visibility: 'public' }] },
    ]);
  });

  it('a second report by the same user does not count again', async () => {
    db.rAQuestionReport.findFirst.mockResolvedValue({ id: 'r1' });
    db.rAInterviewQuestion.findUniqueOrThrow.mockResolvedValue({ reportsCount: 1 });
    const store = await createPrismaPrepStore();
    expect(await store.addReport('q1', 'u1', 'wrong', null)).toEqual({ created: false, reportsCount: 1 });
    expect(db.rAQuestionReport.create).not.toHaveBeenCalled();
    expect(db.rAInterviewQuestion.update).not.toHaveBeenCalled();
  });

  it('reports run at SERIALIZABLE; a lost race is retried and a duplicate-key error reads as "already reported"', async () => {
    const store = await createPrismaPrepStore();
    db.rAQuestionReport.findFirst.mockResolvedValue(null);
    db.rAInterviewQuestion.update.mockResolvedValue({ reportsCount: 2 });
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error('serialization failure'), { code: 'P2034' }));
    expect(await store.addReport('q1', 'u1', 'wrong', null)).toEqual({ created: true, reportsCount: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.$transaction.mock.calls[1]?.[1]).toEqual({ isolationLevel: 'Serializable' });

    db.$transaction.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    db.rAInterviewQuestion.findUniqueOrThrow.mockResolvedValue({ reportsCount: 2 });
    expect(await store.addReport('q1', 'u1', 'wrong', null)).toEqual({ created: false, reportsCount: 2 });
  });

  it('approving a contribution and creating its question share one transaction; the approved company name is stored', async () => {
    const store = await createPrismaPrepStore();
    const at = new Date('2026-10-10T00:00:00Z');
    const question = {
      market: 'intl',
      companyId: null,
      companyNameNormalized: 'acme',
      taxonomyId: null,
      category: 'behavioral',
      difficulty: null,
      seniority: null,
      title: 'Why us',
      body: 'Why do you want to work here?',
      locale: 'en',
      sourceKind: 'user_report',
      reportedPeriod: '2026-09',
      contributionId: 'c1',
    };
    db.rAQuestionContribution.updateMany.mockResolvedValue({ count: 1 });
    db.rAInterviewQuestion.create.mockRejectedValueOnce(new Error('connection reset'));
    await expect(store.approveContribution('c1', { moderatorId: 'a1', moderatedAt: at, companyName: 'Acme' }, question)).rejects.toThrow('connection reset');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.rAQuestionContribution.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'pending' },
      data: { status: 'approved', moderatorId: 'a1', moderatedAt: at, companyName: 'Acme' },
    });

    db.rAQuestionContribution.updateMany.mockResolvedValue({ count: 0 });
    expect(await store.approveContribution('c1', { moderatorId: 'a1', moderatedAt: at, companyName: 'Acme' }, question)).toBeNull();
    expect(db.rAInterviewQuestion.create).toHaveBeenCalledTimes(1);
  });

  it('a staff review can clear the report count', async () => {
    db.rAInterviewQuestion.update.mockResolvedValue({ id: 'q1' });
    const store = await createPrismaPrepStore();
    await store.updateQuestion('q1', { status: 'published', reportsCount: 0 });
    expect(db.rAInterviewQuestion.update.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'q1' }, data: { status: 'published', reportsCount: 0 } });
  });

  it('moderation only moves a pending contribution', async () => {
    db.rAQuestionContribution.updateMany.mockResolvedValue({ count: 0 });
    const store = await createPrismaPrepStore();
    const at = new Date('2026-10-10T00:00:00Z');
    expect(await store.moderateContribution('c1', { status: 'approved', moderatorId: 'a1', moderatedAt: at })).toBe(false);
    expect(db.rAQuestionContribution.updateMany).toHaveBeenCalledWith({ where: { id: 'c1', status: 'pending' }, data: { status: 'approved', moderatorId: 'a1', moderatedAt: at } });
  });

  it('audit rows go to the contributor profile, and skip users without one', async () => {
    const store = await createPrismaPrepStore();
    db.seekerProfile.findUnique.mockResolvedValueOnce(null);
    await store.audit('u1', 'question_contribution_moderated', { decision: 'rejected' });
    expect(db.seekerActivityLog.create).not.toHaveBeenCalled();
    db.seekerProfile.findUnique.mockResolvedValueOnce({ id: 'sp1' });
    await store.audit('u1', 'question_contribution_moderated', { decision: 'rejected' });
    expect(db.seekerActivityLog.create).toHaveBeenCalledWith({ data: { seekerProfileId: 'sp1', eventType: 'question_contribution_moderated', payload: { decision: 'rejected' } } });
  });
});
