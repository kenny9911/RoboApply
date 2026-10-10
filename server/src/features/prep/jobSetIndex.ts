// server/src/features/prep/jobSetIndex.ts — which AI-written questions belong
// to which job post (WP-59).
//
// SR-59-1 asks for `RAInterviewQuestion.jobId`; until SCHEMA-4 adds it the
// link lives in this per-process map (the question rows themselves are
// stored). On Vercel that means a cold start or another instance does not
// know the set: the page shows "not written yet" and the next "Write practice
// questions" writes a new set (counted against the daily limit; the earlier
// rows stay stored but unreachable). Only explicit user actions write
// (generateJobSet, planForJob with `write: true`), so a miss never costs a
// model call on its own. SR-59-1 must land before WP-50 offers a write from
// the Assistant. After the push, a Prisma-backed index
// (`where: { jobId, sourceKind: 'ai_practice' }`) replaces
// `createMemoryJobSetIndex()` in index.ts with no other change.

export interface JobSetEntry {
  questionIds: string[];
  generatedAt: Date;
}

export interface JobSetIndex {
  get(key: string): Promise<JobSetEntry | null>;
  put(key: string, entry: JobSetEntry): Promise<void>;
}

/** Key of one set: the market, the job and the language it was written in. */
export function jobSetKey(market: string, jobId: string, locale: string): string {
  return `${market}:${jobId}:${locale}`;
}

export function createMemoryJobSetIndex(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}): JobSetIndex {
  const maxEntries = options.maxEntries ?? 2_000;
  const ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, JobSetEntry>();
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (now() - entry.generatedAt.getTime() > ttlMs) {
        map.delete(key);
        return null;
      }
      // Refresh recency (Map keeps insertion order: oldest first).
      map.delete(key);
      map.set(key, entry);
      return entry;
    },
    async put(key, entry) {
      map.delete(key);
      map.set(key, entry);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}
