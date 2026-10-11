// server/src/features/resume/tailor/memoryStore.ts
//
// In-memory TailorStore for tests (WP-36a and later resume WPs). No vitest
// imports; compiles with the server.

import { resumeContentHashOf } from '../store.js';
import type { TailorJobRow, TailorSessionRow, TailorStore, TailorVariantRow } from './store.js';

export interface MemoryVariant extends TailorVariantRow {
  kind: string;
  sourceKind: string | null;
  targetJobId: string | null;
  basedOnVariantId: string | null;
  deleted: boolean;
}

export interface MemoryTailorStore extends TailorStore {
  variants: Map<string, MemoryVariant>;
  jobs: Map<string, TailorJobRow & { market: string; visibility: string; ownerUserId: string | null }>;
  keywordTerms: Map<string, string[]>;
  sessions: Map<string, TailorSessionRow>;
}

export function memoryTailorVariant(userId: string, id: string, markdown: string, name = 'Resume'): MemoryVariant {
  return {
    id,
    userId,
    name,
    resumeMarkdown: markdown,
    resumeContentHash: resumeContentHashOf(markdown),
    unverifiedClaims: 0,
    kind: 'base',
    sourceKind: null,
    targetJobId: null,
    basedOnVariantId: null,
    deleted: false,
  };
}

export function memoryTailorJob(
  id: string,
  over: Partial<TailorJobRow & { market: string; visibility: string; ownerUserId: string | null }> = {},
): TailorJobRow & { market: string; visibility: string; ownerUserId: string | null } {
  return {
    id,
    title: 'Data Analyst',
    companyName: 'Acme Analytics',
    descriptionPlain: '',
    qualifications: null,
    responsibilities: null,
    skills: [],
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    ...over,
  };
}

export function createMemoryTailorStore(options: { now?: () => Date } = {}): MemoryTailorStore {
  const now = options.now ?? (() => new Date());
  let seq = 0;
  const variants = new Map<string, MemoryVariant>();
  const jobs: MemoryTailorStore['jobs'] = new Map();
  const keywordTerms = new Map<string, string[]>();
  const sessions = new Map<string, TailorSessionRow>();
  const copy = (s: TailorSessionRow): TailorSessionRow => ({ ...s, sections: [...s.sections], keywordsSelected: [...s.keywordsSelected], claims: structuredClone(s.claims) });

  return {
    variants,
    jobs,
    keywordTerms,
    sessions,
    async findVariant(userId, variantId) {
      const v = variants.get(variantId);
      return v && v.userId === userId && !v.deleted ? { ...v } : null;
    },
    async findJob(userId, jobId, market) {
      const j = jobs.get(jobId);
      if (!j || j.market !== market) return null;
      if (j.visibility !== 'public' && j.ownerUserId !== userId) return null;
      const { market: _m, visibility: _v, ownerUserId: _o, ...row } = j;
      return row;
    },
    async findKeywordTerms(jobId) {
      return [...(keywordTerms.get(jobId) ?? [])];
    },
    async findSession(userId, sessionId) {
      const s = sessions.get(sessionId);
      return s && s.userId === userId ? copy(s) : null;
    },
    async findSessionByLedger(userId, ledgerId) {
      const s = [...sessions.values()].find((x) => x.userId === userId && x.creditLedgerId === ledgerId);
      return s ? copy(s) : null;
    },
    async createSession(input) {
      seq += 1;
      const row: TailorSessionRow = {
        id: `ts_${seq}`,
        userId: input.userId,
        baseVariantId: input.baseVariantId,
        resultVariantId: null,
        jobId: input.jobId,
        jdSnapshot: input.jdSnapshot ?? null,
        mode: input.mode,
        sections: [...input.sections],
        customPrompt: input.customPrompt,
        keywordsSelected: [...input.keywordsSelected],
        scoreBefore: null,
        scoreAfter: null,
        fitSnapshot: null,
        claims: [],
        status: 'generating',
        creditLedgerId: input.creditLedgerId,
        createdAt: now(),
        updatedAt: now(),
      };
      sessions.set(row.id, row);
      return copy(row);
    },
    async updateSession(sessionId, data) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error('session not found');
      Object.assign(s, data, { updatedAt: now() });
      return copy(s);
    },
    async completeGeneration(sessionId, result) {
      const s = sessions.get(sessionId);
      if (!s || s.status !== 'generating') return null;
      seq += 1;
      const id = `rv_t${seq}`;
      variants.set(id, {
        ...memoryTailorVariant(s.userId, id, result.variant.markdown, result.variant.name),
        kind: 'tailored_for_jd',
        sourceKind: 'tailored',
        targetJobId: result.variant.targetJobId,
        basedOnVariantId: result.variant.basedOnVariantId,
        unverifiedClaims: result.variant.unverifiedClaims,
      });
      Object.assign(s, { status: 'review', resultVariantId: id, claims: structuredClone(result.claims), updatedAt: now() });
      return copy(s);
    },
    async saveReview(userId, sessionId, data) {
      const s = sessions.get(sessionId);
      if (!s || s.userId !== userId || s.status !== 'review') return null;
      s.claims = structuredClone(data.claims);
      s.updatedAt = now();
      const v = s.resultVariantId ? variants.get(s.resultVariantId) : undefined;
      if (v && !v.deleted) {
        v.resumeMarkdown = data.markdown;
        v.resumeContentHash = resumeContentHashOf(data.markdown);
        v.unverifiedClaims = data.unverifiedClaims;
      }
      return copy(s);
    },
    async finalize(userId, sessionId) {
      const s = sessions.get(sessionId);
      if (!s || s.userId !== userId || s.status !== 'review') return false;
      s.status = 'finalized';
      s.updatedAt = now();
      const v = s.resultVariantId ? variants.get(s.resultVariantId) : undefined;
      if (v) v.unverifiedClaims = 0;
      return true;
    },
    async unverifiedClaims(variantId) {
      return variants.get(variantId)?.unverifiedClaims ?? 0;
    },
    async findReviewSessions(userId, variantIds) {
      return [...sessions.values()]
        .filter((s) => s.userId === userId && s.status === 'review' && s.resultVariantId !== null && variantIds.includes(s.resultVariantId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((s) => ({ id: s.id, resultVariantId: s.resultVariantId as string }));
    },
  };
}
