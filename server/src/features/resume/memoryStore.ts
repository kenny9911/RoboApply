// server/src/features/resume/memoryStore.ts
//
// In-memory ResumeCheckStore for tests (WP-22 and later resume WPs). No
// vitest imports; compiles with the server.

import { grantClaimKey, resumeContentHashOf, type FitRow, type GradeRow, type JobRow, type ResumeCheckStore, type VariantRow } from './store.js';

export interface MemoryResumeCheckStore extends ResumeCheckStore {
  variants: Map<string, VariantRow>;
  grades: GradeRow[];
  jobs: Map<string, JobRow & { visibility?: string; ownerUserId?: string | null }>;
  extractions: Map<string, { keywords: unknown }>;
  fitRows: Array<FitRow & { userId: string; jobId: string; variantId: string }>;
  grantReasons: Array<{ userId: string; reason: string }>;
}

const sha = resumeContentHashOf;

export function memoryVariant(userId: string, id: string, markdown: string, layout: unknown = null): VariantRow {
  return { id, userId, resumeMarkdown: markdown, resumeContentHash: sha(markdown), layout };
}

export function createMemoryResumeCheckStore(options: { now?: () => Date } = {}): MemoryResumeCheckStore {
  const now = options.now ?? (() => new Date());
  let seq = 0;
  const variants = new Map<string, VariantRow>();
  const grades: GradeRow[] = [];
  const jobs = new Map<string, JobRow & { visibility?: string; ownerUserId?: string | null }>();
  const extractions = new Map<string, { keywords: unknown }>();
  const fitRows: MemoryResumeCheckStore['fitRows'] = [];
  const grantReasons: MemoryResumeCheckStore['grantReasons'] = [];
  const claimLocks = new Map<string, Promise<void>>();

  return {
    variants,
    grades,
    jobs,
    extractions,
    fitRows,
    grantReasons,
    async findVariant(userId, variantId) {
      const v = variants.get(variantId);
      return v && v.userId === userId ? { ...v } : null;
    },
    async createGrade(input) {
      seq += 1;
      const row: GradeRow = {
        id: `grade_${seq}`,
        userId: input.userId,
        variantId: input.variantId,
        contentHash: input.contentHash,
        targetTitle: input.targetTitle,
        status: 'running',
        grade: null,
        score: null,
        counts: null,
        issues: null,
        model: null,
        creditLedgerId: input.creditLedgerId,
        // Strictly increasing, so "newest first" is stable within one test.
        createdAt: new Date(now().getTime() + seq),
        completedAt: null,
      };
      grades.push(row);
      return { ...row };
    },
    async updateGrade(gradeId, data) {
      const row = grades.find((g) => g.id === gradeId);
      if (!row) throw new Error(`grade ${gradeId} not found`);
      Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return { ...row };
    },
    async completeRunningGrade(gradeId, data) {
      const row = grades.find((g) => g.id === gradeId);
      if (!row || row.status !== 'running') return null;
      Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return { ...row };
    },
    async cancelRunningGrade(userId, gradeId) {
      const row = grades.find((g) => g.id === gradeId && g.userId === userId);
      if (!row || row.status !== 'running') return null;
      row.status = 'cancelled';
      row.completedAt = now();
      return { ...row };
    },
    async findGrade(userId, gradeId) {
      const row = grades.find((g) => g.id === gradeId && g.userId === userId);
      return row ? { ...row } : null;
    },
    async listGrades(userId, variantId, limit) {
      return grades
        .filter((g) => g.userId === userId && g.variantId === variantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((g) => ({ ...g }));
    },
    async findJob(userId, jobId) {
      const j = jobs.get(jobId);
      if (!j) return null;
      if ((j.visibility ?? 'public') !== 'public' && j.ownerUserId !== userId) return null;
      return { ...j };
    },
    async findKeywordExtraction(jobId) {
      return extractions.get(jobId) ?? null;
    },
    async findFitRow(userId, jobId, variantId) {
      return fitRows.find((f) => f.userId === userId && f.jobId === jobId && f.variantId === variantId) ?? null;
    },
    async saveMarkdown(userId, variantId, markdown) {
      const v = variants.get(variantId);
      if (!v || v.userId !== userId) throw new Error('variant not found');
      v.resumeMarkdown = markdown;
      v.resumeContentHash = sha(markdown);
      return { resumeContentHash: v.resumeContentHash };
    },
    async withGrantClaim(userId, reason, fn) {
      // Mirrors the advisory lock: one claim per (user, reason) at a time,
      // whichever service instance asks.
      const key = grantClaimKey(userId, reason);
      const prev = claimLocks.get(key) ?? Promise.resolve();
      let unlock!: () => void;
      const mine = new Promise<void>((r) => (unlock = r));
      const chained = prev.then(() => mine);
      claimLocks.set(key, chained);
      await prev;
      try {
        const already = grantReasons.some((g) => g.userId === userId && g.reason === reason);
        const { created, value } = await fn(already);
        if (created) grantReasons.push({ userId, reason });
        return value;
      } finally {
        unlock();
        if (claimLocks.get(key) === chained) claimLocks.delete(key);
      }
    },
  };
}
