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

  it('a first report inserts and counts in one transaction, with no pre-check and no SERIALIZABLE retry (SR-59-3)', async () => {
    db.rAQuestionReport.create.mockResolvedValue({ id: 'r1' });
    db.rAInterviewQuestion.update.mockResolvedValue({ reportsCount: 2 });
    const store = await createPrismaPrepStore();
    expect(await store.addReport('q1', 'u1', 'wrong', null)).toEqual({ created: true, reportsCount: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Default isolation: the unique index decides, not the transaction level.
    expect(db.$transaction.mock.calls[0]?.[1]).toBeUndefined();
    expect(db.rAQuestionReport.findFirst).not.toHaveBeenCalled();
    expect(db.rAQuestionReport.create).toHaveBeenCalledWith({ data: { questionId: 'q1', userId: 'u1', reason: 'wrong', note: null } });
    expect(db.rAInterviewQuestion.update).toHaveBeenCalledWith({ where: { id: 'q1' }, data: { reportsCount: { increment: 1 } }, select: { reportsCount: true } });
  });

  it('a second report by the same user hits the unique index (P2002): already reported, not counted again', async () => {
    db.rAQuestionReport.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed on (questionId, userId)'), { code: 'P2002' }));
    db.rAInterviewQuestion.findUniqueOrThrow.mockResolvedValue({ reportsCount: 1 });
    const store = await createPrismaPrepStore();
    expect(await store.addReport('q1', 'u1', 'wrong', null)).toEqual({ created: false, reportsCount: 1 });
    expect(db.rAInterviewQuestion.update).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('any other report error is not swallowed and is not retried', async () => {
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error('serialization failure'), { code: 'P2034' }));
    const store = await createPrismaPrepStore();
    await expect(store.addReport('q1', 'u1', 'wrong', null)).rejects.toThrow('serialization failure');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.rAInterviewQuestion.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("a contribution stores the contributor's category; a rejection stores the staff reason (SR-59-2)", async () => {
    const store = await createPrismaPrepStore();
    db.rAQuestionContribution.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c1', status: 'pending', moderatorId: null, moderatedAt: null, createdAt: new Date(), rejectReason: null, ...data }));
    const row = await store.createContribution({ userId: 'u1', market: 'intl', companyName: 'Acme', role: '', interviewYm: '2026-09', body: 'Why payments?', category: 'role_specific' });
    expect(db.rAQuestionContribution.create).toHaveBeenCalledWith({ data: expect.objectContaining({ category: 'role_specific' }) });
    expect(row.category).toBe('role_specific');

    const at = new Date('2026-10-10T00:00:00Z');
    db.rAQuestionContribution.updateMany.mockResolvedValue({ count: 1 });
    expect(await store.moderateContribution('c1', { status: 'rejected', moderatorId: 'a1', moderatedAt: at, rejectReason: 'duplicate' })).toBe(true);
    expect(db.rAQuestionContribution.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', status: 'pending' },
      data: { status: 'rejected', moderatorId: 'a1', moderatedAt: at, rejectReason: 'duplicate' },
    });
  });

  it('question rows carry jobId (SR-59-1)', async () => {
    db.rAInterviewQuestion.findUnique.mockResolvedValue(null);
    const store = await createPrismaPrepStore();
    await store.getQuestion('q1');
    expect(db.rAInterviewQuestion.findUnique.mock.calls[0]?.[0]?.select).toMatchObject({ jobId: true });
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
