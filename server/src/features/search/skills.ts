// server/src/features/search/skills.ts
//
// The skills typeahead behind GET /taxonomy/skills?q= (WP-20; TASK_PLAN C17).
//
// Suggestions come from what job posts in the brand's market actually ask
// for: the keywords of `RAKeywordExtraction` and the `RAJob.skills` column,
// over public, canonical, unarchived jobs of `market` only (the D3 aggregate
// filter). Nothing is invented: a skill appears only when at least one post
// names it. A short table of well-known alternative names ("k8s" →
// "Kubernetes") only WIDENS the query, so typing an alias finds the posts'
// own spelling; an alias no post in the market names is never suggested.
// Every row is therefore `source: 'postings'`. The client always offers the
// typed text as a custom entry.
//
// Counts rank the list but are never returned (they would be an unsourced
// number on screen).
//
// Cost: each lookup scans the market's keyword JSON with ILIKE (no index can
// serve it), so the route is rate-limited (60/min per user) and answers are
// memoised per market + query for a short TTL.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import type { Market } from '../../platform/brand/registry.js';
import type { SkillSuggestionWire } from './contract.js';

/** Well-known alternative names → the usual spelling (public common knowledge, not data about jobs). */
export const SKILL_ALIASES: Readonly<Record<string, string>> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  py: 'Python',
  golang: 'Go',
  k8s: 'Kubernetes',
  postgres: 'PostgreSQL',
  psql: 'PostgreSQL',
  'react.js': 'React',
  reactjs: 'React',
  'vue.js': 'Vue',
  vuejs: 'Vue',
  'node.js': 'Node.js',
  nodejs: 'Node.js',
  node: 'Node.js',
  'c#': 'C#',
  csharp: 'C#',
  'c++': 'C++',
  cpp: 'C++',
  ml: 'Machine learning',
  ai: 'Artificial intelligence',
  nlp: 'Natural language processing',
  gcp: 'Google Cloud',
  aws: 'Amazon Web Services',
  excel: 'Microsoft Excel',
  ppt: 'PowerPoint',
  ps: 'Photoshop',
  sql: 'SQL',
};

const CJK = /[㐀-鿿豈-﫿]/;
const MAX_LEN = 60;

/** Minimum query: 2 characters, or 1 Chinese character. */
export function skillQueryLongEnough(q: string): boolean {
  const t = q.trim();
  return t.length >= 2 || (t.length === 1 && CJK.test(t));
}

/** Escape LIKE wildcards so user text matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The search terms for a query: the text itself and, when it is an alias, the usual spelling. */
export function skillSearchTerms(q: string): string[] {
  const t = q.trim();
  const alias = SKILL_ALIASES[t.toLowerCase()];
  return alias && alias.toLowerCase() !== t.toLowerCase() ? [t, alias] : [t];
}

export interface SkillRow {
  label: string;
  n: number;
}

type SkillsDb = Pick<ExtendedPrismaClient, '$queryRaw'>;

/** Aggregate posting skills containing `term` (case-insensitive) in one market. */
export async function querySkillRows(db: SkillsDb, market: Market, term: string, limit: number): Promise<SkillRow[]> {
  const pattern = `%${escapeLike(term)}%`;
  const prefix = `${escapeLike(term.toLowerCase())}%`;
  const rows = await db.$queryRaw<Array<{ label: string; n: number | bigint }>>`
    WITH jobs AS (
      SELECT j."id", j."skills" FROM "RAJob" j
      WHERE j."market" = ${market} AND j."visibility" = 'public' AND j."isCanonical" = true AND j."archivedAt" IS NULL
    ),
    terms AS (
      SELECT trim(e->>'keyword') AS term
      FROM "RAKeywordExtraction" x
      JOIN jobs ON jobs."id" = x."jobId"
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x."keywords") = 'array' THEN x."keywords" ELSE '[]'::jsonb END) e
      WHERE (e->>'keyword') ILIKE ${pattern}
      UNION ALL
      SELECT trim(s) AS term FROM jobs CROSS JOIN LATERAL unnest(jobs."skills") s
      WHERE s ILIKE ${pattern}
    )
    SELECT mode() WITHIN GROUP (ORDER BY term) AS label, count(*)::int AS n
    FROM terms
    WHERE length(term) BETWEEN 1 AND ${MAX_LEN}
    GROUP BY lower(term)
    ORDER BY (lower(term) LIKE ${prefix}) DESC, count(*) DESC, lower(term)
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ label: r.label, n: Number(r.n) }));
}

/** Merge rows from several terms and rank them. Every row is from a job post. */
export function rankSkillSuggestions(q: string, rowsByTerm: SkillRow[][], limit: number): SkillSuggestionWire[] {
  const byKey = new Map<string, { label: string; n: number }>();
  for (const rows of rowsByTerm) {
    for (const r of rows) {
      const key = r.label.trim().toLowerCase();
      if (!key) continue;
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { label: r.label.trim(), n: r.n });
      else cur.n += r.n;
    }
  }
  const query = q.trim().toLowerCase();
  const out: SkillSuggestionWire[] = [...byKey.entries()]
    .sort(([ka, a], [kb, b]) => Number(kb.startsWith(query)) - Number(ka.startsWith(query)) || b.n - a.n || ka.localeCompare(kb))
    .slice(0, limit)
    .map(([, v]) => ({ value: v.label, label: v.label, source: 'postings' as const }));
  return out;
}

export interface SkillSuggestService {
  suggest(q: string, market: Market, limit?: number): Promise<SkillSuggestionWire[]>;
}

export interface SkillSuggestMemoOptions {
  /** How long an answer is reused (default 60 s; 0 turns the memo off). */
  ttlMs?: number;
  /** Most answers kept (oldest dropped first; default 500). */
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MEMO_TTL_MS = 60_000;
const DEFAULT_MEMO_MAX = 500;

export function createSkillSuggestService(
  getDb: () => Promise<SkillsDb> = async () => (await import('../../lib/prisma.js')).default,
  memo: SkillSuggestMemoOptions = {},
): SkillSuggestService {
  const ttlMs = memo.ttlMs ?? DEFAULT_MEMO_TTL_MS;
  const maxEntries = memo.maxEntries ?? DEFAULT_MEMO_MAX;
  const now = memo.now ?? Date.now;
  // In-flight and settled answers per market + normalised query + limit.
  const cache = new Map<string, { at: number; value: Promise<SkillSuggestionWire[]> }>();

  async function compute(q: string, market: Market, limit: number): Promise<SkillSuggestionWire[]> {
    const db = await getDb();
    const rowsByTerm = await Promise.all(skillSearchTerms(q).map((t) => querySkillRows(db, market, t, limit)));
    return rankSkillSuggestions(q, rowsByTerm, limit);
  }

  return {
    async suggest(q, market, limit = 10) {
      if (!skillQueryLongEnough(q)) return [];
      if (ttlMs <= 0) return compute(q, market, limit);
      const key = `${market}\u0000${limit}\u0000${q.trim().toLowerCase()}`;
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = compute(q, market, limit);
      cache.delete(key);
      cache.set(key, { at: t, value });
      // A failure is not remembered: the next keystroke tries again.
      value.catch(() => {
        if (cache.get(key)?.value === value) cache.delete(key);
      });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return value;
    },
  };
}

export const skillSuggestService = createSkillSuggestService();
