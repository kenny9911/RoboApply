// @vitest-environment node
//
// INT-09 (SR-59-1): the Prisma-backed job-set index — query shapes, the
// "newest generation only" rule and key parsing. A fake of the one Prisma
// model it uses; no database.
// Run: npx vitest run server/src/features/prep/jobSetIndex.test.ts

import { describe, expect, it } from 'vitest';

import { GENERATION_GAP_MS, createPrismaJobSetIndex, jobSetKey, newestGeneration, parseJobSetKey } from './jobSetIndex.js';
import { createMemoryJobSetDelegate } from './memoryStore.js';
import type { QuestionRow } from './store.js';

function row(over: Partial<QuestionRow> & { id: string; createdAt: Date }): QuestionRow {
  return {
    market: 'intl', companyId: null, companyNameNormalized: null, taxonomyId: null, category: 'behavioral', difficulty: null,
    seniority: null, title: 't', body: 'b', locale: 'en', sourceKind: 'ai_practice', reportedPeriod: null, contributionId: null,
    guide: null, guideModel: null, status: 'published', reportsCount: 0, updatedAt: over.createdAt, jobId: null,
    ...over,
  };
}

const T0 = new Date('2026-10-10T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('parseJobSetKey', () => {
  it('reads market, job and language back from jobSetKey', () => {
    expect(parseJobSetKey(jobSetKey('cn', 'cmg123abc', 'zh-TW'))).toEqual({ market: 'cn', jobId: 'cmg123abc', locale: 'zh-TW' });
    expect(parseJobSetKey('intl:job:with:colons:en')).toEqual({ market: 'intl', jobId: 'job:with:colons', locale: 'en' });
  });

  it('refuses anything that is not a key', () => {
    for (const bad of ['', 'intl', 'intl:job', ':job:en', 'intl::en', 'intl:job:']) expect(parseJobSetKey(bad)).toBeNull();
  });
});

describe('newestGeneration', () => {
  it('keeps rows written together and stops at the first long gap', () => {
    const rows = [at(GENERATION_GAP_MS * 10 + 900), at(GENERATION_GAP_MS * 10 + 400), at(GENERATION_GAP_MS * 10), at(600), at(0)].map((createdAt, i) => ({ id: `q${i}`, createdAt }));
    expect(newestGeneration(rows).map((r) => r.id)).toEqual(['q0', 'q1', 'q2']);
    expect(newestGeneration([])).toEqual([]);
  });
});

describe('createPrismaJobSetIndex', () => {
  it('put stamps jobId on the set rows only (same market, language, AI rows) and unlinks an older set', async () => {
    const store = {
      questions: [
        row({ id: 'old1', createdAt: at(0), jobId: 'job_1' }),
        row({ id: 'new1', createdAt: at(GENERATION_GAP_MS * 5) }),
        row({ id: 'new2', createdAt: at(GENERATION_GAP_MS * 5 + 50) }),
        row({ id: 'report1', createdAt: at(10), sourceKind: 'user_report' }),
        row({ id: 'zh1', createdAt: at(20), locale: 'zh', jobId: 'job_1' }),
        row({ id: 'cn1', createdAt: at(30), market: 'cn', jobId: 'job_1' }),
        row({ id: 'other1', createdAt: at(40), jobId: 'job_2' }),
      ],
    };
    const db = createMemoryJobSetDelegate(store);
    const index = createPrismaJobSetIndex({ rAInterviewQuestion: db });
    // 'report1' is passed by mistake: a user report is never linked to a post.
    await index.put(jobSetKey('intl', 'job_1', 'en'), { questionIds: ['new1', 'new2', 'report1'], generatedAt: at(GENERATION_GAP_MS * 5 + 50) });

    const linked = Object.fromEntries(store.questions.map((q) => [q.id, q.jobId]));
    expect(linked).toEqual({ old1: null, new1: 'job_1', new2: 'job_1', report1: null, zh1: 'job_1', cn1: 'job_1', other1: 'job_2' });
    expect(db.calls.updateMany).toEqual([
      { where: { id: { in: ['new1', 'new2', 'report1'] }, market: 'intl', locale: 'en', sourceKind: 'ai_practice' }, data: { jobId: 'job_1' } },
      { where: { jobId: 'job_1', market: 'intl', locale: 'en', sourceKind: 'ai_practice', id: { notIn: ['new1', 'new2', 'report1'] } }, data: { jobId: null } },
    ]);
  });

  it('get reads published AI rows of the job, newest generation only, in written order', async () => {
    const store = {
      questions: [
        row({ id: 'gen1-a', createdAt: at(0), jobId: 'job_1' }),
        row({ id: 'gen1-b', createdAt: at(300), jobId: 'job_1' }),
        row({ id: 'gen2-a', createdAt: at(GENERATION_GAP_MS * 3), jobId: 'job_1' }),
        row({ id: 'gen2-b', createdAt: at(GENERATION_GAP_MS * 3 + 200), jobId: 'job_1' }),
        row({ id: 'gen2-hidden', createdAt: at(GENERATION_GAP_MS * 3 + 400), jobId: 'job_1', status: 'hidden' }),
      ],
    };
    const db = createMemoryJobSetDelegate(store);
    const index = createPrismaJobSetIndex({ rAInterviewQuestion: db });
    const entry = await index.get(jobSetKey('intl', 'job_1', 'en'));
    expect(entry).toEqual({ questionIds: ['gen2-a', 'gen2-b'], generatedAt: at(GENERATION_GAP_MS * 3 + 200) });
    expect(db.calls.findMany[0]).toMatchObject({
      where: { jobId: 'job_1', market: 'intl', locale: 'en', sourceKind: 'ai_practice', status: 'published' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });
  });

  it('get answers null for an unknown job or a malformed key; put ignores an empty set', async () => {
    const store = { questions: [row({ id: 'q1', createdAt: at(0), jobId: 'job_1' })] };
    const db = createMemoryJobSetDelegate(store);
    const index = createPrismaJobSetIndex({ rAInterviewQuestion: db });
    expect(await index.get(jobSetKey('intl', 'job_9', 'en'))).toBeNull();
    expect(await index.get('not-a-key')).toBeNull();
    await index.put(jobSetKey('intl', 'job_1', 'en'), { questionIds: [], generatedAt: at(0) });
    expect(db.calls.updateMany).toHaveLength(0);
    expect(store.questions[0]!.jobId).toBe('job_1');
  });
});
