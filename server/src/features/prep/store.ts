// server/src/features/prep/store.ts — persistence of the question bank (WP-59).
//
// A narrow typed store so the service is testable without a database
// (memoryStore.ts is the in-process twin used by the tests). Typed Prisma only.
//
// Schema requests (handoff; until SCHEMA-4 applies them the store degrades as noted):
//   SR-59-1  RAInterviewQuestion.jobId String? + @@index([jobId, status]) — links an
//            AI set to the job post it was written from. Until then the job → set
//            link is kept per server process (jobSetIndex.ts), so a cold start
//            writes a new set (counted against the daily limit).
//   SR-59-2  RAQuestionContribution.category String? and .rejectReason String? — the
//            category a user suggested and why staff rejected it. Until then the
//            suggested category is not kept (staff pick one on approval) and the
//            reject reason goes to the contributor's SeekerActivityLog audit row.
//   SR-59-3  RAQuestionReport @@unique([questionId, userId]) — one report per user per
//            question, enforced by the database. Until then addReport runs its
//            check-then-insert at SERIALIZABLE isolation (a concurrent double submit
//            fails one transaction, which is retried and then sees the first report);
//            a P2002 from the future constraint is read as "already reported".

import type { Prisma } from '../../generated/prisma/client.js';

export interface QuestionRow {
  id: string;
  market: string;
  companyId: string | null;
  companyNameNormalized: string | null;
  taxonomyId: string | null;
  category: string;
  difficulty: string | null;
  seniority: string | null;
  title: string;
  body: string;
  locale: string;
  sourceKind: string;
  reportedPeriod: string | null;
  contributionId: string | null;
  guide: unknown;
  guideModel: string | null;
  status: string;
  reportsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewQuestion = Pick<
  QuestionRow,
  'market' | 'companyId' | 'companyNameNormalized' | 'taxonomyId' | 'category' | 'difficulty' | 'seniority' | 'title' | 'body' | 'locale' | 'sourceKind' | 'reportedPeriod' | 'contributionId'
>;

export interface ContributionRow {
  id: string;
  userId: string;
  market: string;
  companyName: string;
  role: string;
  interviewYm: string;
  body: string;
  status: string;
  moderatorId: string | null;
  moderatedAt: Date | null;
  createdAt: Date;
}

export interface ReportRow {
  reason: string;
  note: string | null;
  createdAt: Date;
}

export interface CompanyRecord {
  id: string;
  slug: string;
  displayName: string;
  nameNormalized: string;
}

/** A company key: the company record and/or its normalized name. */
export interface CompanyKey {
  companyId: string | null;
  nameNormalized: string;
}

/** One company (by normalized name — always set on user reports) and its published reports. */
export interface CompanyGroup {
  nameNormalized: string;
  /** A company record id carried by any of the group's rows (older rows may have none). */
  companyId: string | null;
  count: number;
  latestPeriod: string | null;
}

export interface QuestionQuery {
  market: string;
  sourceKind?: string;
  company?: CompanyKey;
  category?: string;
  seniority?: string;
  status?: 'published' | 'hidden';
  /** Only questions with at least one report since the last staff review. */
  reported?: boolean;
  locale?: string;
}

export interface Page {
  cursor?: string | null;
  take: number;
}

export interface Paged<T> {
  rows: T[];
  cursor: string | null;
}

export interface PrepStore {
  createQuestion(row: NewQuestion): Promise<QuestionRow>;
  getQuestion(id: string): Promise<QuestionRow | null>;
  getQuestions(ids: string[]): Promise<QuestionRow[]>;
  listQuestions(q: QuestionQuery, page: Page): Promise<Paged<QuestionRow>>;
  /** `reportsCount: 0` clears the reports counted toward auto-hide (staff reviewed them). */
  updateQuestion(id: string, data: { guide?: unknown; guideModel?: string | null; status?: 'published' | 'hidden'; reportsCount?: number }): Promise<QuestionRow>;
  companyStats(market: string, key: CompanyKey): Promise<{ count: number; latestPeriod: string | null }>;
  listCompanyGroups(market: string, q: { nameContains?: string; offset: number; take: number }): Promise<CompanyGroup[]>;
  companyBySlug(market: string, slug: string): Promise<CompanyRecord | null>;
  companyByNormalizedName(market: string, nameNormalized: string): Promise<CompanyRecord | null>;
  companiesByIds(ids: string[]): Promise<CompanyRecord[]>;
  /** The staff-approved company name for each normalized name (from approved contributions). */
  contributedNames(market: string, names: string[]): Promise<Map<string, string>>;
  /** One report per user per question; returns whether it was new and the new count. */
  addReport(questionId: string, userId: string, reason: string, note: string | null): Promise<{ created: boolean; reportsCount: number }>;
  recentReports(questionId: string, take: number): Promise<ReportRow[]>;
  createContribution(row: Omit<ContributionRow, 'id' | 'status' | 'moderatorId' | 'moderatedAt' | 'createdAt'>): Promise<ContributionRow>;
  getContribution(id: string): Promise<ContributionRow | null>;
  listContributions(market: string, status: string, page: Page): Promise<Paged<ContributionRow>>;
  /** Moves a pending contribution; false when it was no longer pending (another moderator). */
  moderateContribution(id: string, data: { status: 'approved' | 'rejected'; moderatorId: string; moderatedAt: Date }): Promise<boolean>;
  /**
   * Approves a pending contribution and creates its question in ONE transaction:
   * either both are stored or neither is. null when it was no longer pending.
   * `companyName` is the name staff approved; it replaces the typed one on the
   * contribution, because public pages show it (contributedNames).
   */
  approveContribution(id: string, data: { moderatorId: string; moderatedAt: Date; companyName: string }, question: NewQuestion): Promise<QuestionRow | null>;
  /** Titles of other open public posts at the same company (no counts, no personal data). */
  otherPostingTitles(input: { jobId: string; companyId: string | null; companyNameNormalized: string | null; market: string; take: number; where?: Record<string, unknown> }): Promise<string[]>;
  /** Moderation audit row on the contributor's activity log (best effort). */
  audit(userId: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
}

// ── Prisma implementation ────────────────────────────────────────────────

const QUESTION_SELECT = {
  id: true,
  market: true,
  companyId: true,
  companyNameNormalized: true,
  taxonomyId: true,
  category: true,
  difficulty: true,
  seniority: true,
  title: true,
  body: true,
  locale: true,
  sourceKind: true,
  reportedPeriod: true,
  contributionId: true,
  guide: true,
  guideModel: true,
  status: true,
  reportsCount: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RAInterviewQuestionSelect;

const COMPANY_SELECT = { id: true, slug: true, displayName: true, nameNormalized: true } as const satisfies Prisma.RACompanySelect;

/** Attempts for a report transaction that lost a serialization race (P2034). */
const REPORT_TX_ATTEMPTS = 3;

function prismaCode(err: unknown): string | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

function paged<T extends { id: string }>(rows: T[], take: number): Paged<T> {
  const more = rows.length > take;
  const out = more ? rows.slice(0, take) : rows;
  return { rows: out, cursor: more ? (out[out.length - 1]?.id ?? null) : null };
}

function cursorArgs(cursor: string | null | undefined): { cursor?: { id: string }; skip?: number } {
  return cursor ? { cursor: { id: cursor }, skip: 1 } : {};
}

function questionWhere(q: QuestionQuery): Prisma.RAInterviewQuestionWhereInput {
  const where: Prisma.RAInterviewQuestionWhereInput = { market: q.market };
  if (q.sourceKind) where.sourceKind = q.sourceKind;
  if (q.category) where.category = q.category;
  if (q.seniority) where.seniority = q.seniority;
  if (q.status) where.status = q.status;
  if (q.reported) where.reportsCount = { gt: 0 };
  if (q.locale) where.locale = q.locale;
  if (q.company) {
    where.OR = q.company.companyId
      ? [{ companyId: q.company.companyId }, { companyNameNormalized: q.company.nameNormalized }]
      : [{ companyNameNormalized: q.company.nameNormalized }];
  }
  return where;
}

export async function createPrismaPrepStore(): Promise<PrepStore> {
  const { default: prisma } = await import('../../lib/prisma.js');

  return {
    async createQuestion(row) {
      return prisma.rAInterviewQuestion.create({ data: { ...row, status: 'published' }, select: QUESTION_SELECT });
    },

    async getQuestion(id) {
      return prisma.rAInterviewQuestion.findUnique({ where: { id }, select: QUESTION_SELECT });
    },

    async getQuestions(ids) {
      if (!ids.length) return [];
      const rows = await prisma.rAInterviewQuestion.findMany({ where: { id: { in: ids } }, select: QUESTION_SELECT });
      const order = new Map(ids.map((id, i) => [id, i]));
      return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    },

    async listQuestions(q, page) {
      const rows = await prisma.rAInterviewQuestion.findMany({
        where: questionWhere(q),
        orderBy: q.sourceKind === 'user_report' ? [{ reportedPeriod: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take + 1,
        ...cursorArgs(page.cursor),
        select: QUESTION_SELECT,
      });
      return paged(rows, page.take);
    },

    async updateQuestion(id, data) {
      const patch: Prisma.RAInterviewQuestionUpdateInput = {};
      if (data.guide !== undefined) patch.guide = data.guide as Prisma.InputJsonValue;
      if (data.guideModel !== undefined) patch.guideModel = data.guideModel;
      if (data.status !== undefined) patch.status = data.status;
      if (data.reportsCount !== undefined) patch.reportsCount = data.reportsCount;
      return prisma.rAInterviewQuestion.update({ where: { id }, data: patch, select: QUESTION_SELECT });
    },

    async companyStats(market, key) {
      const where = questionWhere({ market, sourceKind: 'user_report', status: 'published', company: key });
      const agg = await prisma.rAInterviewQuestion.aggregate({ where, _count: { _all: true }, _max: { reportedPeriod: true } });
      return { count: agg._count._all, latestPeriod: agg._max.reportedPeriod ?? null };
    },

    async listCompanyGroups(market, q) {
      // One group per normalized name: rows approved before a company record existed
      // have no companyId, later ones do — grouping by both would split the count.
      const groups = await prisma.rAInterviewQuestion.groupBy({
        by: ['companyNameNormalized'],
        where: {
          market,
          sourceKind: 'user_report',
          status: 'published',
          companyNameNormalized: q.nameContains ? { contains: q.nameContains } : { not: null },
        },
        _count: { _all: true },
        _max: { reportedPeriod: true, companyId: true },
        orderBy: [{ _count: { id: 'desc' } }, { companyNameNormalized: 'asc' }],
        skip: q.offset,
        take: q.take,
      });
      return groups
        .filter((g) => g.companyNameNormalized)
        .map((g) => ({
          nameNormalized: g.companyNameNormalized as string,
          companyId: g._max.companyId ?? null,
          count: g._count._all,
          latestPeriod: g._max.reportedPeriod ?? null,
        }));
    },

    async companyBySlug(market, slug) {
      return prisma.rACompany.findUnique({ where: { market_slug: { market, slug } }, select: COMPANY_SELECT });
    },

    async companyByNormalizedName(market, nameNormalized) {
      if (!nameNormalized) return null;
      return prisma.rACompany.findUnique({ where: { market_nameNormalized: { market, nameNormalized } }, select: COMPANY_SELECT });
    },

    async companiesByIds(ids) {
      if (!ids.length) return [];
      return prisma.rACompany.findMany({ where: { id: { in: ids } }, select: COMPANY_SELECT });
    },

    async contributedNames(market, names) {
      const out = new Map<string, string>();
      if (!names.length) return out;
      const rows = await prisma.rAInterviewQuestion.findMany({
        where: { market, sourceKind: 'user_report', companyNameNormalized: { in: names }, contributionId: { not: null } },
        distinct: ['companyNameNormalized'],
        orderBy: { createdAt: 'desc' },
        select: { companyNameNormalized: true, contributionId: true },
      });
      const ids = rows.map((r) => r.contributionId).filter((v): v is string => Boolean(v));
      if (!ids.length) return out;
      const contributions = await prisma.rAQuestionContribution.findMany({ where: { id: { in: ids } }, select: { id: true, companyName: true } });
      const nameById = new Map(contributions.map((c) => [c.id, c.companyName]));
      for (const r of rows) {
        const name = r.contributionId ? nameById.get(r.contributionId) : undefined;
        if (r.companyNameNormalized && name) out.set(r.companyNameNormalized, name);
      }
      return out;
    },

    async addReport(questionId, userId, reason, note) {
      const current = async () => {
        const q = await prisma.rAInterviewQuestion.findUniqueOrThrow({ where: { id: questionId }, select: { reportsCount: true } });
        return { created: false, reportsCount: q.reportsCount };
      };
      // SR-59-3: SERIALIZABLE until @@unique([questionId, userId]) exists, so two
      // concurrent reports by one user cannot both pass the check and count twice.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await prisma.$transaction(
            async (tx) => {
              const existing = await tx.rAQuestionReport.findFirst({ where: { questionId, userId }, select: { id: true } });
              if (existing) {
                const q = await tx.rAInterviewQuestion.findUniqueOrThrow({ where: { id: questionId }, select: { reportsCount: true } });
                return { created: false, reportsCount: q.reportsCount };
              }
              await tx.rAQuestionReport.create({ data: { questionId, userId, reason, note } });
              const q = await tx.rAInterviewQuestion.update({ where: { id: questionId }, data: { reportsCount: { increment: 1 } }, select: { reportsCount: true } });
              return { created: true, reportsCount: q.reportsCount };
            },
            { isolationLevel: 'Serializable' },
          );
        } catch (err) {
          const code = prismaCode(err);
          if (code === 'P2002') return current();
          if (code === 'P2034' && attempt < REPORT_TX_ATTEMPTS) continue;
          throw err;
        }
      }
    },

    async recentReports(questionId, take) {
      return prisma.rAQuestionReport.findMany({
        where: { questionId },
        orderBy: { createdAt: 'desc' },
        take,
        select: { reason: true, note: true, createdAt: true },
      });
    },

    async createContribution(row) {
      return prisma.rAQuestionContribution.create({ data: row });
    },

    async getContribution(id) {
      return prisma.rAQuestionContribution.findUnique({ where: { id } });
    },

    async listContributions(market, status, page) {
      const rows = await prisma.rAQuestionContribution.findMany({
        where: { market, status },
        // The oldest pending first (fair order); decided ones newest first.
        orderBy: status === 'pending' ? [{ createdAt: 'asc' }, { id: 'asc' }] : [{ moderatedAt: 'desc' }, { id: 'desc' }],
        take: page.take + 1,
        ...cursorArgs(page.cursor),
      });
      return paged(rows, page.take);
    },

    async moderateContribution(id, data) {
      const res = await prisma.rAQuestionContribution.updateMany({ where: { id, status: 'pending' }, data });
      return res.count === 1;
    },

    async approveContribution(id, data, question) {
      return prisma.$transaction(async (tx) => {
        // companyName: the staff-approved name replaces the typed one (public pages show it).
        const moved = await tx.rAQuestionContribution.updateMany({ where: { id, status: 'pending' }, data: { status: 'approved', ...data } });
        if (moved.count !== 1) return null;
        // A failure here rolls the approval back: the contribution stays pending.
        return tx.rAInterviewQuestion.create({ data: { ...question, status: 'published' }, select: QUESTION_SELECT });
      });
    },

    async otherPostingTitles(input) {
      if (!input.companyId && !input.companyNameNormalized) return [];
      const company: Prisma.RAJobWhereInput = input.companyId ? { companyId: input.companyId } : { companyNameNormalized: input.companyNameNormalized ?? '' };
      const rows = await prisma.rAJob.findMany({
        where: {
          AND: [
            company,
            { id: { not: input.jobId }, market: input.market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null },
            ...(input.where ? [input.where as Prisma.RAJobWhereInput] : []),
          ],
        },
        orderBy: { lastSeenAt: 'desc' },
        take: input.take * 2,
        select: { title: true },
      });
      return [...new Set(rows.map((r) => r.title.trim()).filter(Boolean))].slice(0, input.take);
    },

    async audit(userId, eventType, payload) {
      const profile = await prisma.seekerProfile.findUnique({ where: { userId }, select: { id: true } });
      if (!profile) return;
      await prisma.seekerActivityLog.create({ data: { seekerProfileId: profile.id, eventType, payload: payload as Prisma.InputJsonValue } });
    },
  };
}
