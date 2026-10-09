// server/src/features/resume/store.ts
//
// The narrow, typed Prisma adapter for the resume check (WP-22). The service
// talks to this interface only, so tests run against an in-memory twin and
// never touch the database. Every read is scoped to the user.

import crypto from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';

export interface VariantRow {
  id: string;
  userId: string;
  resumeMarkdown: string;
  resumeContentHash: string;
  /** `RAResumeVariant.layout` (template etc.), when set. */
  layout: unknown;
}

export interface GradeRow {
  id: string;
  userId: string;
  variantId: string;
  contentHash: string;
  targetTitle: string | null;
  status: string;
  grade: string | null;
  score: number | null;
  counts: unknown;
  issues: unknown;
  model: string | null;
  creditLedgerId: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface NewGrade {
  userId: string;
  variantId: string;
  contentHash: string;
  targetTitle: string | null;
  creditLedgerId: string | null;
}

export interface GradeUpdate {
  status?: string;
  grade?: string | null;
  score?: number | null;
  counts?: unknown;
  issues?: unknown;
  model?: string | null;
  completedAt?: Date | null;
}

export interface JobRow {
  id: string;
  title: string;
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  minYears: number | null;
  educationLevel: string | null;
  skills: string[];
}

export interface FitRow {
  score: number;
  tier: string | null;
  generatedAt: Date;
  resumeContentHashAtScore: string;
}

export interface ResumeCheckStore {
  findVariant(userId: string, variantId: string): Promise<VariantRow | null>;
  createGrade(input: NewGrade): Promise<GradeRow>;
  updateGrade(gradeId: string, data: GradeUpdate): Promise<GradeRow>;
  /**
   * The same update, only while the row is still `running` (completion and
   * failure writes); null when a cancel got there first.
   */
  completeRunningGrade(gradeId: string, data: GradeUpdate): Promise<GradeRow | null>;
  /** Only when the status is still `running` (cancel); null otherwise. */
  cancelRunningGrade(userId: string, gradeId: string): Promise<GradeRow | null>;
  findGrade(userId: string, gradeId: string): Promise<GradeRow | null>;
  /** Newest first. */
  listGrades(userId: string, variantId: string, limit: number): Promise<GradeRow[]>;
  /** A job the user may see: public, or one the user added. */
  findJob(userId: string, jobId: string): Promise<JobRow | null>;
  findKeywordExtraction(jobId: string): Promise<{ keywords: unknown } | null>;
  findFitRow(userId: string, jobId: string, variantId: string): Promise<FitRow | null>;
  /**
   * Writes new markdown the way RAResumeService.patch does: new
   * `resumeContentHash` (which marks fit scores stale) and `lastEditedAt`.
   */
  saveMarkdown(userId: string, variantId: string, markdown: string): Promise<{ resumeContentHash: string }>;
  /**
   * At-most-once grant per (user, reason), across server instances: runs `fn`
   * while holding a per-(user, reason) lock (Postgres: a transaction-scoped
   * advisory lock), passing whether a grant with that reason already exists.
   * `fn` returns true when it created the grant.
   */
  withGrantClaim<T>(userId: string, reason: string, fn: (alreadyGranted: boolean) => Promise<{ created: boolean; value: T }>): Promise<T>;
}

/** The advisory-lock key of a (user, grant reason) claim. */
export function grantClaimKey(userId: string, reason: string): string {
  return `ra_credit_grant:${userId}:${reason}`;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Same format as RAResumeService's `sha256()` (`sha256:` + 32 hex chars). */
export function resumeContentHashOf(markdown: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(markdown).digest('hex').slice(0, 32);
}

function gradeData(data: GradeUpdate) {
  return {
    ...(data.status !== undefined ? { status: data.status } : {}),
    ...(data.grade !== undefined ? { grade: data.grade } : {}),
    ...(data.score !== undefined ? { score: data.score } : {}),
    ...(data.counts !== undefined ? { counts: json(data.counts) } : {}),
    ...(data.issues !== undefined ? { issues: json(data.issues) } : {}),
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
  };
}

export function createPrismaResumeCheckStore(): ResumeCheckStore {
  const db = async () => (await import('../../lib/prisma.js')).default;
  return {
    async findVariant(userId, variantId) {
      const p = await db();
      return p.rAResumeVariant.findFirst({
        where: { id: variantId, userId, deletedAt: null },
        select: { id: true, userId: true, resumeMarkdown: true, resumeContentHash: true, layout: true },
      });
    },
    async createGrade(input) {
      const p = await db();
      return p.rAResumeGrade.create({
        data: {
          userId: input.userId,
          variantId: input.variantId,
          contentHash: input.contentHash,
          targetTitle: input.targetTitle,
          status: 'running',
          creditLedgerId: input.creditLedgerId,
        },
      });
    },
    async updateGrade(gradeId, data) {
      const p = await db();
      return p.rAResumeGrade.update({ where: { id: gradeId }, data: gradeData(data) });
    },
    async completeRunningGrade(gradeId, data) {
      const p = await db();
      const res = await p.rAResumeGrade.updateMany({ where: { id: gradeId, status: 'running' }, data: gradeData(data) });
      if (res.count === 0) return null;
      return p.rAResumeGrade.findUnique({ where: { id: gradeId } });
    },
    async cancelRunningGrade(userId, gradeId) {
      const p = await db();
      const res = await p.rAResumeGrade.updateMany({
        where: { id: gradeId, userId, status: 'running' },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      if (res.count === 0) return null;
      return p.rAResumeGrade.findFirst({ where: { id: gradeId, userId } });
    },
    async findGrade(userId, gradeId) {
      const p = await db();
      return p.rAResumeGrade.findFirst({ where: { id: gradeId, userId } });
    },
    async listGrades(userId, variantId, limit) {
      const p = await db();
      return p.rAResumeGrade.findMany({ where: { userId, variantId }, orderBy: { createdAt: 'desc' }, take: limit });
    },
    async findJob(userId, jobId) {
      const p = await db();
      return p.rAJob.findFirst({
        where: { id: jobId, OR: [{ visibility: 'public' }, { ownerUserId: userId }] },
        select: {
          id: true,
          title: true,
          descriptionPlain: true,
          qualifications: true,
          responsibilities: true,
          minYears: true,
          educationLevel: true,
          skills: true,
        },
      });
    },
    async findKeywordExtraction(jobId) {
      const p = await db();
      return p.rAKeywordExtraction.findUnique({ where: { jobId }, select: { keywords: true } });
    },
    async findFitRow(userId, jobId, variantId) {
      const p = await db();
      return p.rAJobMatchScore.findFirst({
        where: { userId, jobId, resumeVariantId: variantId, scoreKind: 'ai' },
        select: { score: true, tier: true, generatedAt: true, resumeContentHashAtScore: true },
      });
    },
    async saveMarkdown(userId, variantId, markdown) {
      const p = await db();
      const resumeContentHash = resumeContentHashOf(markdown);
      const res = await p.rAResumeVariant.updateMany({
        where: { id: variantId, userId, deletedAt: null },
        data: { resumeMarkdown: markdown, resumeContentHash, lastEditedAt: new Date() },
      });
      if (res.count === 0) throw new Error('resume variant not found');
      return { resumeContentHash };
    },
    async withGrantClaim(userId, reason, fn) {
      const p = await db();
      // The lock is held until this transaction ends, so a second instance
      // waits here and then sees the grant the first one wrote (the grant
      // itself commits on its own connection inside `fn`, before the unlock).
      return p.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${grantClaimKey(userId, reason)}))`;
          const row = await tx.rACreditGrant.findFirst({ where: { userId, reason }, select: { id: true } });
          const { value } = await fn(row !== null);
          return value;
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
    },
  };
}
