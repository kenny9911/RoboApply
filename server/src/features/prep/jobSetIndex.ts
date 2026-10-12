// server/src/features/prep/jobSetIndex.ts — which AI-written questions belong
// to which job post (WP-59; SR-59-1).
//
// The link is `RAInterviewQuestion.jobId` (SCHEMA-4), read and written through
// `createPrismaJobSetIndex`, so a set survives a cold start and is the same on
// every instance:
//   put  stamps `jobId` on the set's question rows and takes it off any older
//        `ai_practice` set of the same job, market and language;
//   get  reads `{ jobId, market, locale, sourceKind: 'ai_practice',
//        status: 'published' }` and returns the newest generation only — the
//        rows written together (see GENERATION_GAP_MS).
// D3: the column links a set to the post it was written FROM. It never
// attributes a question to the company (only `user_report` rows carry one).
//
// `createMemoryJobSetIndex` is the per-process twin for unit tests.

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

// ── Prisma-backed index (SR-59-1) ──────────────────────────────────────────

/** The part of `prisma.rAInterviewQuestion` the index uses (narrow, so tests can fake it). */
export interface JobSetQuestionDelegate {
  findMany(args: {
    where: { jobId: string; market: string; locale: string; sourceKind: 'ai_practice'; status: 'published' };
    orderBy: Array<{ createdAt: 'desc' } | { id: 'desc' }>;
    take: number;
    select: { id: true; createdAt: true };
  }): Promise<Array<{ id: string; createdAt: Date }>>;
  updateMany(args: {
    where:
      | { id: { in: string[] }; market: string; locale: string; sourceKind: 'ai_practice' }
      | { jobId: string; market: string; locale: string; sourceKind: 'ai_practice'; id: { notIn: string[] } };
    data: { jobId: string | null };
  }): Promise<{ count: number }>;
}

/**
 * Rows of one generation are inserted one after another within a few seconds.
 * A gap longer than this between two neighbouring rows starts an older
 * generation (a set written again after staff hid the first one).
 */
export const GENERATION_GAP_MS = 60_000;

/** No set is larger than a handful of questions; this bounds the read. */
const MAX_SET_ROWS = 50;

/** Split `market:jobId:locale` (jobSetKey). null when the key is not one. */
export function parseJobSetKey(key: string): { market: string; jobId: string; locale: string } | null {
  const first = key.indexOf(':');
  const last = key.lastIndexOf(':');
  if (first <= 0 || last <= first + 1 || last === key.length - 1) return null;
  return { market: key.slice(0, first), jobId: key.slice(first + 1, last), locale: key.slice(last + 1) };
}

/** The newest generation among rows sorted newest first: rows with no long gap between neighbours. */
export function newestGeneration<T extends { createdAt: Date }>(rowsNewestFirst: readonly T[], gapMs: number = GENERATION_GAP_MS): T[] {
  const out: T[] = [];
  for (const row of rowsNewestFirst) {
    const prev = out[out.length - 1];
    if (prev && prev.createdAt.getTime() - row.createdAt.getTime() > gapMs) break;
    out.push(row);
  }
  return out;
}

export function createPrismaJobSetIndex(db: { rAInterviewQuestion: JobSetQuestionDelegate }): JobSetIndex {
  return {
    async get(key) {
      const k = parseJobSetKey(key);
      if (!k) return null;
      const rows = await db.rAInterviewQuestion.findMany({
        where: { jobId: k.jobId, market: k.market, locale: k.locale, sourceKind: 'ai_practice', status: 'published' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_SET_ROWS,
        select: { id: true, createdAt: true },
      });
      const set = newestGeneration(rows);
      if (!set.length) return null;
      // Written order (oldest first), as the set was generated.
      return { questionIds: set.map((r) => r.id).reverse(), generatedAt: set[0]!.createdAt };
    },
    async put(key, entry) {
      const k = parseJobSetKey(key);
      if (!k || !entry.questionIds.length) return;
      const scope = { market: k.market, locale: k.locale, sourceKind: 'ai_practice' as const };
      await db.rAInterviewQuestion.updateMany({ where: { id: { in: entry.questionIds }, ...scope }, data: { jobId: k.jobId } });
      // An older set of the same job and language is no longer the job's set.
      await db.rAInterviewQuestion.updateMany({ where: { jobId: k.jobId, ...scope, id: { notIn: entry.questionIds } }, data: { jobId: null } });
    },
  };
}
