// server/src/features/prep/memoryStore.ts — in-process PrepStore (tests and
// local fixtures; same semantics as the Prisma store, no database).

import type { JobSetQuestionDelegate } from './jobSetIndex.js';
import type { CompanyGroup, CompanyRecord, ContributionRow, Page, Paged, PrepStore, QuestionQuery, QuestionRow, ReportRow } from './store.js';

export interface MemoryPrepStore extends PrepStore {
  questions: QuestionRow[];
  contributions: ContributionRow[];
  reports: Array<ReportRow & { questionId: string; userId: string }>;
  companies: Array<CompanyRecord & { market: string }>;
  jobs: Array<{ id: string; title: string; companyId: string | null; companyNameNormalized: string | null; market: string; visibility: string; open: boolean }>;
  audits: Array<{ userId: string; eventType: string; payload: Record<string, unknown> }>;
}

function page<T extends { id: string }>(rows: T[], p: Page): Paged<T> {
  const start = p.cursor ? rows.findIndex((r) => r.id === p.cursor) + 1 : 0;
  const slice = rows.slice(start, start + p.take + 1);
  const more = slice.length > p.take;
  const out = more ? slice.slice(0, p.take) : slice;
  return { rows: out, cursor: more ? (out[out.length - 1]?.id ?? null) : null };
}

function matches(q: QuestionRow, where: QuestionQuery): boolean {
  if (q.market !== where.market) return false;
  if (where.sourceKind && q.sourceKind !== where.sourceKind) return false;
  if (where.category && q.category !== where.category) return false;
  if (where.seniority && q.seniority !== where.seniority) return false;
  if (where.status && q.status !== where.status) return false;
  if (where.reported && q.reportsCount <= 0) return false;
  if (where.locale && q.locale !== where.locale) return false;
  if (where.company) {
    const byId = where.company.companyId !== null && q.companyId === where.company.companyId;
    const byName = q.companyNameNormalized === where.company.nameNormalized;
    if (!byId && !byName) return false;
  }
  return true;
}

export function createMemoryPrepStore(now: () => Date = () => new Date()): MemoryPrepStore {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const store: MemoryPrepStore = {
    questions: [],
    contributions: [],
    reports: [],
    companies: [],
    jobs: [],
    audits: [],

    async createQuestion(row) {
      const t = now();
      const q: QuestionRow = { ...row, id: id('q'), guide: null, guideModel: null, status: 'published', reportsCount: 0, createdAt: t, updatedAt: t, jobId: null };
      store.questions.push(q);
      return { ...q };
    },
    async getQuestion(qid) {
      const q = store.questions.find((r) => r.id === qid);
      return q ? { ...q } : null;
    },
    async getQuestions(ids) {
      return ids.map((i) => store.questions.find((r) => r.id === i)).filter((r): r is QuestionRow => Boolean(r)).map((r) => ({ ...r }));
    },
    async listQuestions(where, p) {
      const rows = store.questions
        .filter((q) => matches(q, where))
        .sort((a, b) => (b.reportedPeriod ?? '').localeCompare(a.reportedPeriod ?? '') || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      return page(rows, p);
    },
    async updateQuestion(qid, data) {
      const q = store.questions.find((r) => r.id === qid);
      if (!q) throw new Error('not found');
      if (data.guide !== undefined) q.guide = data.guide;
      if (data.guideModel !== undefined) q.guideModel = data.guideModel;
      if (data.status !== undefined) q.status = data.status;
      if (data.reportsCount !== undefined) q.reportsCount = data.reportsCount;
      q.updatedAt = now();
      return { ...q };
    },
    async companyStats(market, key) {
      const rows = store.questions.filter((q) => matches(q, { market, sourceKind: 'user_report', status: 'published', company: key }));
      const latest = rows.map((r) => r.reportedPeriod).filter((v): v is string => Boolean(v)).sort().pop() ?? null;
      return { count: rows.length, latestPeriod: latest };
    },
    async listCompanyGroups(market, q) {
      const groups = new Map<string, CompanyGroup>();
      for (const r of store.questions) {
        if (r.market !== market || r.sourceKind !== 'user_report' || r.status !== 'published' || !r.companyNameNormalized) continue;
        if (q.nameContains && !r.companyNameNormalized.includes(q.nameContains)) continue;
        // One group per normalized name (rows with and without a company record).
        const k = r.companyNameNormalized;
        const g = groups.get(k) ?? { nameNormalized: r.companyNameNormalized, companyId: null, count: 0, latestPeriod: null };
        g.companyId ??= r.companyId;
        g.count += 1;
        if (r.reportedPeriod && (!g.latestPeriod || r.reportedPeriod > g.latestPeriod)) g.latestPeriod = r.reportedPeriod;
        groups.set(k, g);
      }
      return [...groups.values()].sort((a, b) => b.count - a.count || a.nameNormalized.localeCompare(b.nameNormalized)).slice(q.offset, q.offset + q.take);
    },
    async companyBySlug(market, slug) {
      const c = store.companies.find((r) => r.market === market && r.slug === slug);
      return c ? { id: c.id, slug: c.slug, displayName: c.displayName, nameNormalized: c.nameNormalized } : null;
    },
    async companyByNormalizedName(market, name) {
      const c = store.companies.find((r) => r.market === market && r.nameNormalized === name);
      return c ? { id: c.id, slug: c.slug, displayName: c.displayName, nameNormalized: c.nameNormalized } : null;
    },
    async companiesByIds(ids) {
      return store.companies.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, slug: c.slug, displayName: c.displayName, nameNormalized: c.nameNormalized }));
    },
    async contributedNames(market, names) {
      const out = new Map<string, string>();
      // Newest question first, like the Prisma store (orderBy createdAt desc).
      for (const q of [...store.questions].reverse()) {
        if (q.market !== market || !q.companyNameNormalized || !names.includes(q.companyNameNormalized) || !q.contributionId) continue;
        const c = store.contributions.find((r) => r.id === q.contributionId);
        if (c && !out.has(q.companyNameNormalized)) out.set(q.companyNameNormalized, c.companyName);
      }
      return out;
    },
    async addReport(questionId, userId, reason, note) {
      const q = store.questions.find((r) => r.id === questionId);
      if (!q) throw new Error('not found');
      if (store.reports.some((r) => r.questionId === questionId && r.userId === userId)) return { created: false, reportsCount: q.reportsCount };
      store.reports.push({ questionId, userId, reason, note, createdAt: now() });
      q.reportsCount += 1;
      return { created: true, reportsCount: q.reportsCount };
    },
    async recentReports(questionId, take) {
      return store.reports
        .filter((r) => r.questionId === questionId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
        .map(({ reason, note, createdAt }) => ({ reason, note, createdAt }));
    },
    async createContribution(row) {
      const c: ContributionRow = { ...row, id: id('c'), status: 'pending', moderatorId: null, moderatedAt: null, createdAt: now(), rejectReason: null };
      store.contributions.push(c);
      return { ...c };
    },
    async getContribution(cid) {
      const c = store.contributions.find((r) => r.id === cid);
      return c ? { ...c } : null;
    },
    async listContributions(market, status, p) {
      const rows = store.contributions
        .filter((c) => c.market === market && c.status === status)
        .sort((a, b) =>
          status === 'pending' ? a.createdAt.getTime() - b.createdAt.getTime() : (b.moderatedAt?.getTime() ?? 0) - (a.moderatedAt?.getTime() ?? 0),
        );
      return page(rows, p);
    },
    async moderateContribution(cid, data) {
      const c = store.contributions.find((r) => r.id === cid);
      if (!c || c.status !== 'pending') return false;
      Object.assign(c, data);
      return true;
    },
    async approveContribution(cid, data, question) {
      const c = store.contributions.find((r) => r.id === cid);
      if (!c || c.status !== 'pending') return null;
      // Same all-or-nothing outcome as the Prisma transaction: the question is
      // created first, and the contribution moves only when that succeeded.
      const q = await store.createQuestion(question);
      Object.assign(c, { status: 'approved', ...data });
      return q;
    },
    async otherPostingTitles(input) {
      return store.jobs
        .filter(
          (j) =>
            j.id !== input.jobId &&
            j.market === input.market &&
            j.visibility === 'public' &&
            j.open &&
            (input.companyId ? j.companyId === input.companyId : j.companyNameNormalized === input.companyNameNormalized),
        )
        .map((j) => j.title)
        .slice(0, input.take);
    },
    async audit(userId, eventType, payload) {
      store.audits.push({ userId, eventType, payload });
    },
  };
  return store;
}

/**
 * The fake `prisma.rAInterviewQuestion` the Prisma job-set index runs against
 * in tests: the same `where` shapes, applied to the in-memory question rows.
 */
export function createMemoryJobSetDelegate(store: Pick<MemoryPrepStore, 'questions'>): JobSetQuestionDelegate & { calls: { findMany: unknown[]; updateMany: unknown[] } } {
  const calls = { findMany: [] as unknown[], updateMany: [] as unknown[] };
  return {
    calls,
    async findMany(args) {
      calls.findMany.push(args);
      const w = args.where;
      return store.questions
        .filter((q) => q.jobId === w.jobId && q.market === w.market && q.locale === w.locale && q.sourceKind === w.sourceKind && q.status === w.status)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, args.take)
        .map((q) => ({ id: q.id, createdAt: q.createdAt }));
    },
    async updateMany(args) {
      calls.updateMany.push(args);
      const w = args.where;
      let count = 0;
      for (const q of store.questions) {
        if (q.market !== w.market || q.locale !== w.locale || q.sourceKind !== w.sourceKind) continue;
        const hit = 'jobId' in w ? q.jobId === w.jobId && !w.id.notIn.includes(q.id) : w.id.in.includes(q.id);
        if (!hit) continue;
        q.jobId = args.data.jobId;
        count += 1;
      }
      return { count };
    },
  };
}
