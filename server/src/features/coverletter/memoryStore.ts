// server/src/features/coverletter/memoryStore.ts
//
// In-memory twin of the cover-letter store (WP-37 tests). Same semantics as
// the Prisma adapter: user-scoped reads, soft delete, newest-first listing
// with an id cursor. No vitest imports.

import type { CoverLetterStore, JobRow, LetterRow, NewArtifact, VariantRow } from './store.js';

export interface MemoryCoverLetterStore extends CoverLetterStore {
  letters: Map<string, LetterRow & { deletedAt: Date | null }>;
  variants: Map<string, VariantRow>;
  jobs: Map<string, JobRow & { market: 'intl' | 'cn'; ownerUserId: string | null }>;
  trackerEntries: Map<string, { id: string; userId: string; coverLetterId: string | null }>;
  artifacts: Array<NewArtifact & { id: string }>;
}

export function createMemoryCoverLetterStore(options: { now?: () => Date } = {}): MemoryCoverLetterStore {
  const now = options.now ?? (() => new Date());
  let seq = 0;
  let tick = 0;
  // Strictly increasing timestamps so "newest first" is deterministic.
  const stamp = () => new Date(now().getTime() + tick++);
  const letters = new Map<string, LetterRow & { deletedAt: Date | null }>();
  const variants = new Map<string, VariantRow>();
  const jobs = new Map<string, JobRow & { market: 'intl' | 'cn'; ownerUserId: string | null }>();
  const trackerEntries = new Map<string, { id: string; userId: string; coverLetterId: string | null }>();
  const artifacts: Array<NewArtifact & { id: string }> = [];
  const live = (userId: string, id: string) => {
    const row = letters.get(id);
    return row && row.userId === userId && !row.deletedAt ? row : null;
  };
  const view = (row: LetterRow & { deletedAt: Date | null }): LetterRow => {
    const { deletedAt: _d, ...rest } = row;
    return structuredClone(rest);
  };

  return {
    letters,
    variants,
    jobs,
    trackerEntries,
    artifacts,
    async findVariant(userId, variantId) {
      const v = variants.get(variantId);
      return v && v.userId === userId ? { ...v } : null;
    },
    async findJob(userId, jobId, market) {
      const j = jobs.get(jobId);
      if (!j) return null;
      if (j.ownerUserId === userId || (j.ownerUserId === null && j.market === market)) {
        const { market: _m, ownerUserId: _o, ...row } = j;
        return row;
      }
      return null;
    },
    async ownsTrackerEntry(userId, entryId) {
      return trackerEntries.get(entryId)?.userId === userId;
    },
    async createLetter(data) {
      const at = stamp();
      const row = { ...structuredClone(data), id: `cl_${++seq}`, createdAt: at, updatedAt: at, deletedAt: null };
      letters.set(row.id, row);
      return view(row);
    },
    async findLetter(userId, letterId) {
      const row = live(userId, letterId);
      return row ? view(row) : null;
    },
    async updateLetter(userId, letterId, data) {
      const row = live(userId, letterId);
      if (!row) return null;
      for (const [k, v] of Object.entries(data)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = structuredClone(v);
      row.updatedAt = stamp();
      return view(row);
    },
    async listLetters(userId, { jobId, cursor, limit }) {
      const rows = [...letters.values()]
        .filter((r) => r.userId === userId && !r.deletedAt && (!jobId || r.jobId === jobId))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
      const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
      return rows.slice(start, start + limit).map(view);
    },
    async softDelete(userId, letterId, at) {
      const row = live(userId, letterId);
      if (!row) return false;
      row.deletedAt = at;
      for (const e of trackerEntries.values()) if (e.userId === userId && e.coverLetterId === letterId) e.coverLetterId = null;
      return true;
    },
    async linkTrackerEntry(userId, letterId, entryId, previousEntryId) {
      if (previousEntryId && previousEntryId !== entryId) {
        const prev = trackerEntries.get(previousEntryId);
        if (prev && prev.userId === userId && prev.coverLetterId === letterId) prev.coverLetterId = null;
      }
      if (entryId) {
        const e = trackerEntries.get(entryId);
        if (e && e.userId === userId) e.coverLetterId = letterId;
        for (const other of letters.values()) {
          if (other.userId === userId && other.id !== letterId && !other.deletedAt && other.trackerEntryId === entryId) other.trackerEntryId = null;
        }
      }
    },
    async recordArtifact(data) {
      const row = { ...data, id: `art_${artifacts.length + 1}` };
      artifacts.push(row);
      return { id: row.id };
    },
  };
}
