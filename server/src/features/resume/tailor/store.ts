// server/src/features/resume/tailor/store.ts
//
// The narrow, typed Prisma adapter for tailor sessions (WP-36a). The service
// talks to this interface only; tests use the in-memory twin
// (tailor/memoryStore.ts) and never touch the database. Every read is scoped
// to the user.

import type { Prisma } from '../../../generated/prisma/client.js';
import type { FitSnapshot } from '../../match/contract.js';
import { resumeContentHashOf } from '../store.js';

export interface TailorVariantRow {
  id: string;
  userId: string;
  name: string;
  resumeMarkdown: string;
  resumeContentHash: string;
  unverifiedClaims: number;
}

export interface TailorJobRow {
  id: string;
  title: string;
  companyName: string;
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  skills: string[];
}

export interface TailorSessionRow {
  id: string;
  userId: string;
  baseVariantId: string;
  resultVariantId: string | null;
  jobId: string | null;
  jdSnapshot: unknown;
  mode: string;
  sections: string[];
  customPrompt: string | null;
  keywordsSelected: string[];
  scoreBefore: number | null;
  scoreAfter: number | null;
  /**
   * `{ before, after }`, each a `FitSnapshot` (match/contract.ts) or null:
   * what the two numbers were, with kind, versions and time (strategy 2.2 I6).
   * Written in the same update as the numbers. Null on a session written
   * before the column existed.
   */
  fitSnapshot?: unknown;
  claims: unknown;
  status: string;
  creditLedgerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The stored value of `RATailorSession.fitSnapshot`. */
export interface TailorFitSnapshots {
  before: FitSnapshot | null;
  after: FitSnapshot | null;
}

export interface NewTailorSession {
  userId: string;
  baseVariantId: string;
  jobId: string | null;
  jdSnapshot: unknown;
  mode: string;
  sections: string[];
  customPrompt: string | null;
  keywordsSelected: string[];
  creditLedgerId: string;
}

export interface GenerationResult {
  variant: {
    name: string;
    markdown: string;
    targetJobId: string | null;
    basedOnVariantId: string;
    unverifiedClaims: number;
  };
  claims: unknown;
}

export interface TailorStore {
  findVariant(userId: string, variantId: string): Promise<TailorVariantRow | null>;
  /**
   * A job the user may see in this market: public, or one the user added. On
   * GoApply the recruitment-info mode applies too (R-14): with the mode off
   * only the user's own imports can be tailored for, so a third-party posting
   * never reaches the model or a session's target line.
   */
  findJob(userId: string, jobId: string, market: string): Promise<TailorJobRow | null>;
  /** The job's stored keyword extraction terms ([] when none). */
  findKeywordTerms(jobId: string): Promise<string[]>;
  findSession(userId: string, sessionId: string): Promise<TailorSessionRow | null>;
  /** The session a credit reservation paid for (idempotent replays). */
  findSessionByLedger(userId: string, ledgerId: string): Promise<TailorSessionRow | null>;
  createSession(input: NewTailorSession): Promise<TailorSessionRow>;
  /** Status / score writes. A score is written together with its snapshot (`fitSnapshot`), never alone. */
  updateSession(
    sessionId: string,
    data: { status?: string; scoreBefore?: number | null; scoreAfter?: number | null; fitSnapshot?: TailorFitSnapshots },
  ): Promise<TailorSessionRow>;
  /**
   * generating → review in one transaction: create the tailored version
   * (kind 'tailored_for_jd', sourceKind 'tailored', `unverifiedClaims`) and
   * link it. Null when the session is no longer `generating`.
   */
  completeGeneration(sessionId: string, result: GenerationResult): Promise<TailorSessionRow | null>;
  /**
   * While the session is in `review`: write the claims and, in the same
   * transaction, the tailored version's markdown (new content hash) and its
   * `unverifiedClaims`. Null when the session left `review`.
   */
  saveReview(userId: string, sessionId: string, data: { claims: unknown; markdown: string; unverifiedClaims: number }): Promise<TailorSessionRow | null>;
  /** review → finalized (and the version's unverifiedClaims → 0). False when another request got there first. */
  finalize(userId: string, sessionId: string): Promise<boolean>;
  /** `RAResumeVariant.unverifiedClaims` of a version (0 when unknown). */
  unverifiedClaims(variantId: string): Promise<number>;
  /**
   * The user's sessions still in `review` whose tailored version is one of
   * `variantIds` (the hub's "Verify details" links), newest first.
   */
  findReviewSessions(userId: string, variantIds: readonly string[]): Promise<Array<{ id: string; resultVariantId: string }>>;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

const SESSION_SELECT = {
  id: true,
  userId: true,
  baseVariantId: true,
  resultVariantId: true,
  jobId: true,
  jdSnapshot: true,
  mode: true,
  sections: true,
  customPrompt: true,
  keywordsSelected: true,
  scoreBefore: true,
  scoreAfter: true,
  fitSnapshot: true,
  claims: true,
  status: true,
  creditLedgerId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function createPrismaTailorStore(): TailorStore {
  const db = async () => (await import('../../../lib/prisma.js')).default;
  return {
    async findVariant(userId, variantId) {
      const p = await db();
      return p.rAResumeVariant.findFirst({
        where: { id: variantId, userId, deletedAt: null },
        select: { id: true, userId: true, name: true, resumeMarkdown: true, resumeContentHash: true, unverifiedClaims: true },
      });
    },
    async findJob(userId, jobId, market) {
      const p = await db();
      // GoApply (R-14): the same rule every other job reader applies.
      const modeScope = market === 'cn' ? [(await import('../../cn/jobs/index.js')).cnPostingsWhere(userId)] : [];
      return p.rAJob.findFirst({
        where: { id: jobId, market, AND: [{ OR: [{ visibility: 'public' }, { ownerUserId: userId }] }, ...modeScope] },
        select: { id: true, title: true, companyName: true, descriptionPlain: true, qualifications: true, responsibilities: true, skills: true },
      });
    },
    async findKeywordTerms(jobId) {
      const p = await db();
      const row = await p.rAKeywordExtraction.findUnique({ where: { jobId }, select: { keywords: true } });
      const list = Array.isArray(row?.keywords) ? (row!.keywords as Array<{ keyword?: unknown }>) : [];
      return list.map((k) => (typeof k?.keyword === 'string' ? k.keyword : '')).filter(Boolean);
    },
    async findSession(userId, sessionId) {
      const p = await db();
      return p.rATailorSession.findFirst({ where: { id: sessionId, userId }, select: SESSION_SELECT });
    },
    async findSessionByLedger(userId, ledgerId) {
      const p = await db();
      return p.rATailorSession.findFirst({ where: { userId, creditLedgerId: ledgerId }, select: SESSION_SELECT, orderBy: { createdAt: 'desc' } });
    },
    async createSession(input) {
      const p = await db();
      return p.rATailorSession.create({
        data: {
          userId: input.userId,
          baseVariantId: input.baseVariantId,
          jobId: input.jobId,
          ...(input.jdSnapshot ? { jdSnapshot: json(input.jdSnapshot) } : {}),
          mode: input.mode,
          sections: input.sections,
          customPrompt: input.customPrompt,
          keywordsSelected: input.keywordsSelected,
          status: 'generating',
          creditLedgerId: input.creditLedgerId,
        },
        select: SESSION_SELECT,
      });
    },
    async updateSession(sessionId, data) {
      const p = await db();
      const { fitSnapshot, ...rest } = data;
      return p.rATailorSession.update({
        where: { id: sessionId },
        data: { ...rest, ...(fitSnapshot !== undefined ? { fitSnapshot: json(fitSnapshot) } : {}) },
        select: SESSION_SELECT,
      });
    },
    async completeGeneration(sessionId, result) {
      const p = await db();
      return p.$transaction(async (tx) => {
        const session = await tx.rATailorSession.findFirst({ where: { id: sessionId, status: 'generating' }, select: { userId: true } });
        if (!session) return null;
        const md = result.variant.markdown;
        const variant = await tx.rAResumeVariant.create({
          data: {
            userId: session.userId,
            name: result.variant.name,
            kind: 'tailored_for_jd',
            targetJobId: result.variant.targetJobId,
            basedOnVariantId: result.variant.basedOnVariantId,
            resumeMarkdown: md,
            resumeContentHash: resumeContentHashOf(md),
            sourceKind: 'tailored',
            unverifiedClaims: result.variant.unverifiedClaims,
            lastEditedAt: new Date(),
          },
          select: { id: true },
        });
        return tx.rATailorSession.update({
          where: { id: sessionId },
          data: { status: 'review', resultVariantId: variant.id, claims: json(result.claims) },
          select: SESSION_SELECT,
        });
      });
    },
    async saveReview(userId, sessionId, data) {
      const p = await db();
      return p.$transaction(async (tx) => {
        const res = await tx.rATailorSession.updateMany({ where: { id: sessionId, userId, status: 'review' }, data: { claims: json(data.claims) } });
        if (res.count === 0) return null;
        const session = await tx.rATailorSession.findFirst({ where: { id: sessionId, userId }, select: SESSION_SELECT });
        if (session?.resultVariantId) {
          await tx.rAResumeVariant.updateMany({
            where: { id: session.resultVariantId, userId, deletedAt: null },
            data: {
              resumeMarkdown: data.markdown,
              resumeContentHash: resumeContentHashOf(data.markdown),
              unverifiedClaims: data.unverifiedClaims,
              lastEditedAt: new Date(),
            },
          });
        }
        return session;
      });
    },
    async finalize(userId, sessionId) {
      const p = await db();
      return p.$transaction(async (tx) => {
        const res = await tx.rATailorSession.updateMany({ where: { id: sessionId, userId, status: 'review' }, data: { status: 'finalized' } });
        if (res.count === 0) return false;
        const session = await tx.rATailorSession.findFirst({ where: { id: sessionId, userId }, select: { resultVariantId: true } });
        if (session?.resultVariantId) {
          await tx.rAResumeVariant.updateMany({ where: { id: session.resultVariantId, userId }, data: { unverifiedClaims: 0 } });
        }
        return true;
      });
    },
    async unverifiedClaims(variantId) {
      const p = await db();
      const row = await p.rAResumeVariant.findUnique({ where: { id: variantId }, select: { unverifiedClaims: true } });
      return row?.unverifiedClaims ?? 0;
    },
    async findReviewSessions(userId, variantIds) {
      if (variantIds.length === 0) return [];
      const p = await db();
      const rows = await p.rATailorSession.findMany({
        where: { userId, status: 'review', resultVariantId: { in: [...variantIds] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, resultVariantId: true },
      });
      return rows.flatMap((r) => (r.resultVariantId ? [{ id: r.id, resultVariantId: r.resultVariantId }] : []));
    },
  };
}
