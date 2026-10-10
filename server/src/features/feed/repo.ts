// server/src/features/feed/repo.ts — the feed's typed data adapter (WP-32).
//
// The services talk to `FeedRepo` only, so tests use an in-memory fake and
// never touch a database. `createPrismaFeedRepo()` is the production
// implementation: typed delegates plus `$queryRaw` for the statements built
// in sql.ts (the Prisma client is imported lazily, so importing the area
// never opens a pool).

import type { Prisma } from '../../generated/prisma/client.js';
import type prismaClient from '../../lib/prisma.js';
import type { Market } from '../../platform/brand/registry.js';
import type { AffinityState } from './affinity.js';
import { readWeights } from './affinity.js';
import type { FeedJobRow } from './types.js';

type Db = Pick<
  typeof prismaClient,
  | '$queryRaw'
  | '$executeRaw'
  | 'rAJob'
  | 'rAJobUserState'
  | 'rAJobInteraction'
  | 'rAJobReview'
  | 'rAFeedSession'
  | 'rAFeedRating'
  | 'rAUserAffinity'
  | 'rAUserUiState'
  | 'rATrackerEntry'
  | 'rAProfile'
  | 'rAJobMatchScore'
  | 'seekerProfile'
>;

export interface FeedSessionRecord {
  id: string;
  userId: string;
  searchProfileId: string | null;
  profileVersion: number | null;
  sort: string;
  queryHash: string;
  jobIds: string[];
  ranks: unknown;
  totalEstimate: number;
  windowEndsAt: Date;
  /** Last row id of a full window (keyset with windowEndsAt); null when the window was not full. */
  windowEndsId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export type FeedSessionWrite = Omit<FeedSessionRecord, 'id' | 'createdAt'>;

/** The job fields the hide / report actions need. */
export interface ActionJob {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  title: string;
  companyName: string;
  companyNameNormalized: string;
  primaryTaxonomyId: string | null;
  taxonomyIds: string[];
  skills: string[];
  seniority: string | null;
  salaryDisclosed: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  archivedAt: Date | null;
  closedAt: Date | null;
}

export interface InteractionWrite {
  userId: string;
  jobId: string;
  kind: string;
  reasonCode?: string | null;
  detail?: Record<string, unknown> | null;
  feedSessionId?: string | null;
  position?: number | null;
}

/** `cardExtrasSql` row: the fields the market card hooks read beyond the list columns. */
export interface CardExtrasRow extends Record<string, unknown> {
  id: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  locations: unknown;
  fraudFlags: unknown;
  descriptionPlain: string | null;
}

export interface FeedRepo {
  /** Run a retrieval statement from sql.ts. */
  queryRows(sql: Prisma.Sql): Promise<FeedJobRow[]>;
  /** Run an id-only statement (`jobIdsSql`): ids in the statement's order. */
  queryIds(sql: Prisma.Sql): Promise<string[]>;
  /** Run `cardExtrasSql`. */
  queryCardExtras(sql: Prisma.Sql): Promise<CardExtrasRow[]>;
  /** Of `ids`, the jobs a public page may show now (the SEO pages' predicate, seo `basePublicWhere`). */
  publicPageIds(ids: string[], market: Market, now: Date): Promise<Set<string>>;
  /** The boards whose rows may be redisplayed publicly right now (seo `allowedPublicBoards`). */
  publicBoards(): Promise<string[]>;
  /** Run a count statement from sql.ts (`SELECT count(*)::int AS "count"`). */
  queryCount(sql: Prisma.Sql): Promise<number>;
  /** Run the Explore count statement. */
  queryCategoryCounts(sql: Prisma.Sql): Promise<Array<{ taxonomyId: string; count: number }>>;
  /** Cached v3 AI scores for this user's current resume (content hash + prompt version must match). */
  aiScores(
    userId: string,
    jobIds: string[],
    resume: { id: string; resumeContentHash: string } | null,
    promptVersion: string,
  ): Promise<Map<string, { score: number; tier: string | null; dimensions?: unknown }>>;
  trackerStates(userId: string, jobIds: string[]): Promise<Map<string, string>>;
  createSession(data: FeedSessionWrite): Promise<FeedSessionRecord>;
  getSession(id: string, userId: string): Promise<FeedSessionRecord | null>;
  /** `windowEndsId` is its own column (SR-32-4); a session written before the column keeps its id in `ranks`. */
  updateSession(id: string, data: Partial<Pick<FeedSessionRecord, 'jobIds' | 'ranks' | 'totalEstimate' | 'windowEndsAt' | 'windowEndsId'>>): Promise<void>;
  actionJob(jobId: string): Promise<ActionJob | null>;
  setHidden(userId: string, jobId: string, hidden: { at: Date; reason: string } | null): Promise<void>;
  logInteractions(rows: InteractionWrite[]): Promise<void>;
  /**
   * Distinct users who reported the job with one of `reasons` since its
   * latest admin decision (RAJobReview; before that table, the newest
   * `admin_review` interaction). Reports an admin already decided on do not
   * count again, so a job an admin kept does not close on its next report.
   */
  distinctReporters(jobId: string, reasons: readonly string[]): Promise<number>;
  /** Close a public job as reported (no-op when already closed). True when this call closed it. */
  closeAsReported(jobId: string, at: Date): Promise<boolean>;
  recordImpressions(userId: string, jobIds: string[], at: Date): Promise<void>;
  /** Insert the day's rating; false when one exists for (user, dayKey). */
  createRating(row: { userId: string; dayKey: string; score: number; reasons: string[]; note: string | null; feedSessionId: string | null }): Promise<boolean>;
  getAffinity(userId: string): Promise<AffinityState | null>;
  saveAffinity(userId: string, state: AffinityState): Promise<void>;
  lastFeedVisit(userId: string): Promise<Date | null>;
  stampFeedVisit(userId: string, at: Date): Promise<void>;
  /** RAProfile.skills names (`[{ name, confirmed }]`). */
  profileSkills(userId: string): Promise<string[]>;
  trackerCounts(userId: string): Promise<{ saved: number; applied: number }>;
  /** The user's own imported jobs ("Added by you"): `sourceBoard = 'user_import'`, theirs, not archived. */
  importedCount(userId: string, market: string): Promise<number>;
  /** `SeekerProfile.onboardingAnswers.goal.goal`, else `RAProfile.careerGoal`. */
  careerGoal(userId: string): Promise<string | null>;
}

/**
 * `RAFeedSession.windowEndsId` is its own column (SCHEMA-3, SR-32-4) and
 * `ranks` is the bare entries array. Sessions written before the column
 * stored the envelope `{ entries, windowEndsId }` in `ranks` (30-minute TTL):
 * `unpackRanks` still reads it, and `sessionFromRow` prefers the column.
 */
export function unpackRanks(json: unknown): { ranks: unknown[]; windowEndsId: string | null } {
  if (Array.isArray(json)) return { ranks: json, windowEndsId: null };
  if (json && typeof json === 'object') {
    const o = json as { entries?: unknown; windowEndsId?: unknown };
    return { ranks: Array.isArray(o.entries) ? o.entries : [], windowEndsId: typeof o.windowEndsId === 'string' && o.windowEndsId ? o.windowEndsId : null };
  }
  return { ranks: [], windowEndsId: null };
}

/** A stored session row → record: the column's boundary id, else the legacy envelope's. */
export function sessionFromRow<T extends { ranks: unknown; windowEndsId?: string | null }>(row: T): Omit<T, 'ranks' | 'windowEndsId'> & { ranks: unknown[]; windowEndsId: string | null } {
  const legacy = unpackRanks(row.ranks);
  return { ...row, ranks: legacy.ranks, windowEndsId: row.windowEndsId ?? legacy.windowEndsId };
}

async function db(): Promise<Db> {
  return (await import('../../lib/prisma.js')).default;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The newer of the review-table decision and the legacy `admin_review` interaction (null when neither exists). */
export function latestDecisionAt(reviewAt: Date | null, legacyAt: Date | null): Date | null {
  if (reviewAt && legacyAt) return reviewAt.getTime() >= legacyAt.getTime() ? reviewAt : legacyAt;
  return reviewAt ?? legacyAt;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

export function createPrismaFeedRepo(getDb: () => Promise<Db> = db): FeedRepo {
  return {
    async queryRows(sql) {
      const p = await getDb();
      return p.$queryRaw<FeedJobRow[]>(sql);
    },

    async queryIds(sql) {
      const p = await getDb();
      const rows = await p.$queryRaw<Array<{ id: string }>>(sql);
      return rows.map((r) => r.id);
    },

    async queryCardExtras(sql) {
      const p = await getDb();
      return p.$queryRaw<CardExtrasRow[]>(sql);
    },

    async publicPageIds(ids, market, now) {
      if (!ids.length) return new Set();
      const p = await getDb();
      // Lazy: the seo area imports nothing from the feed, but its module graph is not needed to rank a list.
      const { allowedPublicBoards, basePublicWhere } = await import('../seo/index.js');
      const base = basePublicWhere({ market, now, publicBoards: allowedPublicBoards() });
      const rows = await p.rAJob.findMany({ where: { ...base, id: { in: ids } }, select: { id: true } });
      return new Set(rows.map((r) => r.id));
    },

    async publicBoards() {
      const { allowedPublicBoards } = await import('../seo/index.js');
      return allowedPublicBoards();
    },

    async queryCount(sql) {
      const p = await getDb();
      const rows = await p.$queryRaw<Array<{ count: number | bigint }>>(sql);
      return Number(rows[0]?.count ?? 0);
    },

    async queryCategoryCounts(sql) {
      const p = await getDb();
      const rows = await p.$queryRaw<Array<{ taxonomyId: string; count: number | bigint }>>(sql);
      return rows.map((r) => ({ taxonomyId: r.taxonomyId, count: Number(r.count) }));
    },

    async aiScores(userId, jobIds, resume, promptVersion) {
      const out = new Map<string, { score: number; tier: string | null; dimensions?: unknown }>();
      if (!resume || !jobIds.length) return out;
      const p = await getDb();
      const rows = await p.rAJobMatchScore.findMany({
        where: {
          userId,
          resumeVariantId: resume.id,
          jobId: { in: jobIds },
          scoreKind: 'ai',
          promptVersion,
          resumeContentHashAtScore: resume.resumeContentHash,
        },
        select: { jobId: true, score: true, tier: true, dimensions: true },
      });
      for (const r of rows) out.set(r.jobId, { score: r.score, tier: r.tier, dimensions: r.dimensions });
      return out;
    },

    async trackerStates(userId, jobIds) {
      const out = new Map<string, string>();
      if (!jobIds.length) return out;
      const p = await getDb();
      const rows = await p.rATrackerEntry.findMany({
        where: { userId, jobId: { in: jobIds }, deletedAt: null },
        select: { jobId: true, status: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      });
      for (const r of rows) if (r.jobId && !out.has(r.jobId)) out.set(r.jobId, r.status);
      return out;
    },

    async createSession(data) {
      const p = await getDb();
      const { ranks, ...rest } = data;
      const row = await p.rAFeedSession.create({ data: { ...rest, ranks: (Array.isArray(ranks) ? ranks : []) as Prisma.InputJsonValue } });
      return sessionFromRow(row);
    },

    async getSession(id, userId) {
      const p = await getDb();
      const row = await p.rAFeedSession.findFirst({ where: { id, userId } });
      return row ? sessionFromRow(row) : null;
    },

    async updateSession(id, data) {
      const p = await getDb();
      const { ranks, ...rest } = data;
      await p.rAFeedSession.update({
        where: { id },
        data: { ...rest, ...(ranks !== undefined ? { ranks: (Array.isArray(ranks) ? ranks : []) as Prisma.InputJsonValue } : {}) },
      });
    },

    async actionJob(jobId) {
      const p = await getDb();
      return p.rAJob.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          market: true,
          visibility: true,
          ownerUserId: true,
          title: true,
          companyName: true,
          companyNameNormalized: true,
          primaryTaxonomyId: true,
          taxonomyIds: true,
          skills: true,
          seniority: true,
          salaryDisclosed: true,
          salaryMin: true,
          salaryMax: true,
          salaryCurrency: true,
          salaryPeriod: true,
          archivedAt: true,
          closedAt: true,
        },
      });
    },

    async setHidden(userId, jobId, hidden) {
      const p = await getDb();
      const data = { hiddenAt: hidden?.at ?? null, hiddenReason: hidden?.reason ?? null };
      await p.rAJobUserState.upsert({
        where: { userId_jobId: { userId, jobId } },
        create: { userId, jobId, ...data },
        update: data,
      });
    },

    async logInteractions(rows) {
      if (!rows.length) return;
      const p = await getDb();
      await p.rAJobInteraction.createMany({
        data: rows.map((r) => ({
          userId: r.userId,
          jobId: r.jobId,
          kind: r.kind,
          reasonCode: r.reasonCode ?? null,
          detail: (r.detail ?? undefined) as Prisma.InputJsonValue | undefined,
          feedSessionId: r.feedSessionId ?? null,
          position: r.position ?? null,
        })),
      });
    },

    async distinctReporters(jobId, reasons) {
      const p = await getDb();
      const [review, legacy] = await Promise.all([
        p.rAJobReview.findFirst({ where: { jobId }, orderBy: { at: 'desc' }, select: { at: true } }),
        // Decisions made before RAJobReview existed (admin console, Wave 5).
        p.rAJobInteraction.findFirst({ where: { jobId, kind: 'admin_review' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      ]);
      const decidedAt = latestDecisionAt(review?.at ?? null, legacy?.createdAt ?? null);
      const rows = await p.rAJobInteraction.findMany({
        where: { jobId, kind: 'report', reasonCode: { in: [...reasons] }, ...(decidedAt ? { createdAt: { gt: decidedAt } } : {}) },
        select: { userId: true },
        distinct: ['userId'],
      });
      return rows.length;
    },

    async closeAsReported(jobId, at) {
      const p = await getDb();
      const { count } = await p.rAJob.updateMany({
        where: { id: jobId, visibility: 'public', closedAt: null },
        data: { closedAt: at, closeReason: 'reported' },
      });
      return count > 0;
    },

    async recordImpressions(userId, jobIds, at) {
      if (!jobIds.length) return;
      const p = await getDb();
      // One statement: insert missing (user, job) rows, bump the counter on the rest.
      await p.$executeRaw`
        INSERT INTO "RAJobUserState" ("userId", "jobId", "impressions", "lastImpressionAt")
        SELECT ${userId}, j.id, 1, ${at}::timestamp(3) FROM unnest(${jobIds}::text[]) AS j(id)
        ON CONFLICT ("userId", "jobId") DO UPDATE
          SET "impressions" = "RAJobUserState"."impressions" + 1, "lastImpressionAt" = EXCLUDED."lastImpressionAt"`;
    },

    async createRating(row) {
      const p = await getDb();
      try {
        await p.rAFeedRating.create({ data: row });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    async getAffinity(userId) {
      const p = await getDb();
      const row = await p.rAUserAffinity.findUnique({ where: { userId } });
      if (!row) return null;
      return {
        taxonomy: readWeights(row.taxonomyWeights),
        company: readWeights(row.companyWeights),
        skill: readWeights(row.skillWeights),
        updatedAt: row.updatedAt,
      };
    },

    async saveAffinity(userId, state) {
      const p = await getDb();
      const data = { taxonomyWeights: state.taxonomy, companyWeights: state.company, skillWeights: state.skill };
      await p.rAUserAffinity.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    },

    async lastFeedVisit(userId) {
      const p = await getDb();
      const row = await p.rAUserUiState.findUnique({ where: { userId }, select: { lastFeedVisitAt: true } });
      return row?.lastFeedVisitAt ?? null;
    },

    async stampFeedVisit(userId, at) {
      const p = await getDb();
      await p.rAUserUiState.upsert({ where: { userId }, create: { userId, lastFeedVisitAt: at }, update: { lastFeedVisitAt: at } });
    },

    async profileSkills(userId) {
      const p = await getDb();
      const row = await p.rAProfile.findUnique({ where: { userId }, select: { skills: true } });
      const skills = row?.skills;
      if (!Array.isArray(skills)) return [];
      return skills
        .map((s) => (isRecord(s) && typeof s.name === 'string' ? s.name : typeof s === 'string' ? s : null))
        .filter((s): s is string => !!s && !!s.trim());
    },

    async trackerCounts(userId) {
      const p = await getDb();
      const [saved, applied] = await Promise.all([
        p.rATrackerEntry.count({ where: { userId, deletedAt: null, status: 'bookmarked' } }),
        p.rATrackerEntry.count({ where: { userId, deletedAt: null, status: 'applied' } }),
      ]);
      return { saved, applied };
    },

    async importedCount(userId, market) {
      const p = await getDb();
      return p.rAJob.count({ where: { ownerUserId: userId, sourceBoard: 'user_import', market, archivedAt: null } });
    },

    async careerGoal(userId) {
      const p = await getDb();
      const [seeker, profile] = await Promise.all([
        p.seekerProfile.findUnique({ where: { userId }, select: { onboardingAnswers: true } }),
        p.rAProfile.findUnique({ where: { userId }, select: { careerGoal: true } }),
      ]);
      const answers = seeker?.onboardingAnswers;
      const goal = isRecord(answers) && isRecord(answers.goal) ? answers.goal.goal : null;
      if (typeof goal === 'string' && goal) return goal;
      return profile?.careerGoal ?? null;
    },
  };
}
