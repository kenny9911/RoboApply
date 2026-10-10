// server/src/features/admin/safety.ts — read-only GoApply content-safety view
// (WP-24 request): `contentSafetyReadiness()` (provider, usable, CN-1 ready,
// problems; never secrets) and the recent non-pass `RAContentSafetyEvent`
// rows. Rows hold no full user text (a hash, a length and, for block/review
// only, an excerpt of at most 200 characters); the excerpt is redacted again
// here before it is shown.

import prisma from '../../lib/prisma.js';
import type { EnvSource } from '../../platform/brand/index.js';
import { contentSafetyReadiness } from '../../platform/llm/contentSafety/index.js';
import { redactPii } from '../../platform/pii/index.js';
import type { SafetyEventView, SafetyResponse } from './contract.js';

export const SAFETY_PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60_000;

export interface SafetyRow {
  id: string;
  brand: string;
  surface: string;
  direction: string;
  verdict: string;
  provider: string | null;
  matched: unknown;
  createdAt: Date;
}

export interface SafetyStore {
  list(query: { verdict?: string; cursor?: string; take: number }): Promise<SafetyRow[]>;
  verdictCounts(since: Date): Promise<Array<{ verdict: string; count: number }>>;
}

type Db = Pick<typeof prisma, 'rAContentSafetyEvent'>;

export function createPrismaSafetyStore(db: Db = prisma): SafetyStore {
  return {
    list({ verdict, cursor, take }) {
      return db.rAContentSafetyEvent.findMany({
        where: verdict ? { verdict } : { verdict: { in: ['review', 'block', 'error'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, brand: true, surface: true, direction: true, verdict: true, provider: true, matched: true, createdAt: true },
      });
    },
    async verdictCounts(since) {
      const rows = await db.rAContentSafetyEvent.groupBy({ by: ['verdict'], where: { createdAt: { gte: since } }, _count: { _all: true } });
      return rows.map((r) => ({ verdict: r.verdict, count: r._count._all })).sort((a, b) => a.verdict.localeCompare(b.verdict));
    },
  };
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function toSafetyView(row: SafetyRow): SafetyEventView {
  const m = rec(row.matched);
  const excerpt = typeof m.excerpt === 'string' && m.excerpt ? redactPii(m.excerpt.slice(0, 200)).text : null;
  return {
    id: row.id,
    brand: row.brand,
    surface: row.surface,
    direction: row.direction,
    verdict: row.verdict,
    provider: row.provider,
    reason: typeof m.reason === 'string' ? m.reason : null,
    labels: Array.isArray(m.labels) ? m.labels.filter((l): l is string => typeof l === 'string').slice(0, 10) : [],
    excerpt,
    excerptAnchor: typeof m.excerptAnchor === 'string' ? m.excerptAnchor : null,
    finalScan: typeof m.finalScan === 'boolean' ? m.finalScan : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getSafety(
  store: SafetyStore,
  query: { verdict?: string; cursor?: string },
  options: { now?: Date; env?: EnvSource } = {},
): Promise<SafetyResponse> {
  const now = options.now ?? new Date();
  const [rows, last7d] = await Promise.all([
    store.list({ ...query, take: SAFETY_PAGE_SIZE + 1 }),
    store.verdictCounts(new Date(now.getTime() - 7 * DAY_MS)),
  ]);
  const page = rows.slice(0, SAFETY_PAGE_SIZE);
  const r = contentSafetyReadiness(options.env ?? process.env);
  return {
    readiness: { provider: r.provider, usable: r.usable, cn1Ready: r.cn1Ready, keywordList: r.keywordList, timeoutMs: r.timeoutMs, problems: r.problems },
    last7d,
    items: page.map(toSafetyView),
    cursor: rows.length > SAFETY_PAGE_SIZE ? page[page.length - 1]!.id : null,
  };
}
