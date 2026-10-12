// server/src/features/feed/indexProof.ts — the feed's index proof (WP-32 acceptance; ruling F25).
//
//   1. `pg_indexes` lists every index the feed SQL relies on (PLANNED_FEED_INDEXES).
//   2. Under `SET LOCAL enable_seqscan = off` (inside a read-only transaction),
//      `EXPLAIN (FORMAT JSON)` of the retrieval, count and hidden-state
//      statements uses them.
//
// Read-only: it never writes. Run it against the clone Neon branch with
//   FEED_INDEX_PROOF=1 npx vitest run server/src/features/feed/indexProof.test.ts
// (the test is skipped otherwise, so the default suite never opens a database).

import { Prisma } from '../../generated/prisma/client.js';
import type prismaClient from '../../lib/prisma.js';
import { FILTER_FIELDS, type FilterSet } from '../search/index.js';
import { countSql, retrievalSql } from './sql.js';

/** Index names (Prisma's default `<Model>_<fields>_idx|key|pkey`) the feed queries rely on, by what uses them. */
export const PLANNED_FEED_INDEXES: Readonly<Record<string, string>> = {
  RAJob_market_isCanonical_archivedAt_postedAt_idx: 'scope + posted-date window and order (retrieval, counts)',
  RAJob_market_locationCountry_workModel_archivedAt_idx: 'country / work-model predicates',
  RAJob_taxonomyIds_idx: 'role overlap (GIN)',
  RAJob_skills_idx: 'skills include / exclude (GIN)',
  RAJob_searchText_idx: 'keyword q (trigram GIN)',
  RAJob_salaryCurrency_salaryAnnualMax_idx: 'pay floor',
  RAJob_companyId_archivedAt_idx: 'company join',
  RAJobUserState_pkey: 'hidden-state NOT EXISTS (userId, jobId)',
  RAJobUserState_userId_hiddenAt_idx: 'hidden jobs per user',
  RAJobInteraction_jobId_kind_idx: 'distinct reporters per job',
  RAFeedSession_userId_createdAt_idx: 'session lookup',
  RAFeedRating_userId_dayKey_key: 'one rating a day',
  RAJobMatchScore_userId_jobId_resumeVariantId_key: 'cached AI scores join',
  // Added by SCHEMA-3 (handoff SR-32-1…3).
  RAJob_market_isCanonical_archivedAt_firstSeenAt_idx: 'SR-32-1: new-count (firstSeenAt > last visit)',
  RAJob_employerTags_idx: 'SR-32-2: GoApply employer-tag / 户口 filters (GIN)',
  RAJob_geoLat_geoLng_idx: 'SR-32-3: radius bounding box',
};

/** Indexes requested from a later SCHEMA-n gate; reported, not required, until they land. None open after SCHEMA-3. */
export const REQUESTED_FEED_INDEXES: Readonly<Record<string, string>> = {};

type Db = Pick<typeof prismaClient, '$queryRaw' | '$transaction'>;

export interface IndexProofResult {
  missing: string[];
  missingRequested: string[];
  /** Index names seen in each EXPLAIN plan. */
  plans: Record<string, string[]>;
}

/** Every `"Index Name"` in an EXPLAIN (FORMAT JSON) plan tree. */
export function indexNamesInPlan(plan: unknown): string[] {
  const out = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'Index Name' && typeof v === 'string') out.add(v);
      else walk(v);
    }
  };
  walk(plan);
  return [...out].sort();
}

/**
 * Sample statements the proof explains: a typical intl saved search
 * (retrieval, keyset refill, count), and the statements whose indexes are
 * still schema requests (new-count, GoApply employer tags, radius search),
 * so the proof reports what they use today and after SCHEMA-3.
 */
export function proofStatements(now: Date): Record<string, Prisma.Sql> {
  const day = 86_400_000;
  const filters: FilterSet = { taxonomyIds: ['software_engineering'], workModels: ['remote', 'hybrid'], country: 'US', skills: ['python'], q: 'engineer' };
  const scope = { market: 'intl' as const, userId: 'index-proof-user', now };
  const cnScope = { market: 'cn' as const, userId: 'index-proof-user', now };
  return {
    retrieval: retrievalSql({ scope, filters, fields: FILTER_FIELDS, from: new Date(now.getTime() - 14 * day), to: null, limit: 400 }),
    refill: retrievalSql({ scope, filters, fields: FILTER_FIELDS, from: new Date(now.getTime() - 59 * day), to: new Date(now.getTime() - 14 * day), toId: 'index-proof-boundary', limit: 400 }),
    count: countSql({ scope, filters, fields: FILTER_FIELDS, cap: 5000 }),
    newCount: countSql({ scope: cnScope, filters: {}, fields: FILTER_FIELDS, cap: 5000, firstSeenAfter: new Date(now.getTime() - day) }),
    cnEmployerTags: countSql({ scope: cnScope, filters: { employerTags: ['soe'], hukouTag: true }, fields: FILTER_FIELDS, cap: 5000 }),
    geo: countSql({ scope, filters: { locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US', lat: 30.27, lng: -97.74, radiusKm: 40 }] }, fields: FILTER_FIELDS, cap: 5000 }),
  };
}

/** Which proof statement each SCHEMA-3 index (SR-32-1…3, now planned) must appear in. */
export const REQUESTED_INDEX_STATEMENT: Readonly<Record<string, string>> = {
  RAJob_market_isCanonical_archivedAt_firstSeenAt_idx: 'newCount',
  RAJob_employerTags_idx: 'cnEmployerTags',
  RAJob_geoLat_geoLng_idx: 'geo',
};

export async function runIndexProof(db: Db, now: Date = new Date()): Promise<IndexProofResult> {
  const tables = ['RAJob', 'RAJobUserState', 'RAJobInteraction', 'RAFeedSession', 'RAFeedRating', 'RAJobMatchScore'];
  const rows = await db.$queryRaw<Array<{ indexname: string }>>(Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = ANY(${tables}::text[])`);
  const present = new Set(rows.map((r) => r.indexname));
  const plans: Record<string, string[]> = {};
  await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
    await tx.$executeRaw(Prisma.sql`SET LOCAL enable_seqscan = off`);
    for (const [name, sql] of Object.entries(proofStatements(now))) {
      const plan = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`);
      plans[name] = indexNamesInPlan(plan.map((p) => p['QUERY PLAN']));
    }
  });
  return {
    missing: Object.keys(PLANNED_FEED_INDEXES).filter((i) => !present.has(i)),
    missingRequested: Object.keys(REQUESTED_FEED_INDEXES).filter((i) => !present.has(i)),
    plans,
  };
}
