// server/src/features/retrieval/repo.ts
//
// The database side of the search document and the vectors (MKT-2H; MATCH
// 4.9). Raw SQL for everything Prisma cannot type: `RAJob.searchTsv`
// (Unsupported("tsvector")) and the `embedding` columns of `RAJobEmbedding` and
// `RAUserEmbedding` (Unsupported("halfvec(1024)")). Rules (server/prisma/sql/README.md):
//   - `searchDoc` and `searchTsv` are written in ONE statement, never apart;
//   - raw SQL on RAJob lists its columns: no `SELECT *`, and `searchTsv` is
//     never returned (it is used in WHERE / ORDER BY only);
//   - a vector is passed as a text literal cast `::halfvec(1024)`, after this
//     module checked that it has exactly 1024 finite numbers;
//   - vectors never cross markets: every statement on the embedding tables
//     filters on `market`, and a comparison is always inside one model tag;
//   - timestamps are bound from the application clock (a JS Date, stored as
//     UTC like every Prisma DateTime), never SQL `now()`: the columns are
//     `timestamp` without time zone, and `now()` would be written in the
//     session's zone and then compared with UTC values such as `enrichedAt`.
//
// The Prisma client is imported lazily, so importing the area opens no pool.

import { Prisma } from '../../generated/prisma/client.js';
import type { IndexJobRow } from './jobText.js';

export const VECTOR_DIMENSIONS = 1024;

/** The slice of the Prisma client this module uses (a fake in tests). */
export interface RetrievalDb {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
  rAJob: { findMany(args: { where: { id: { in: string[] } }; select: Record<string, true> }): Promise<unknown[]> };
  appConfig: {
    findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null>;
    upsert(args: { where: { key: string }; create: { key: string; value: string; updatedBy: string }; update: { value: string; updatedBy: string } }): Promise<unknown>;
  };
}

export type UserVectorKind = 'intent' | 'resume';

export interface NearestJob {
  jobId: string;
  /** Cosine distance to the anchor, 0 (same direction) to 2. */
  distance: number;
}

export interface IndexStats {
  /** Live, public, canonical, enriched rows of the market. */
  live: number;
  /** Of them, rows without a search document. */
  missingDoc: number;
  /** Of them, rows whose vector has the given model tag (0 when no tag is given). */
  withTag: number;
  /** Of them, rows without a vector of that tag. */
  missingVector: number;
  /** Characters of card text of the rows without such a vector (an upper estimate from column lengths). */
  missingVectorChars: number;
}

export interface EmbeddingMeta {
  model: string;
  contentHash: string;
}

export interface UserEmbeddingMeta {
  kind: UserVectorKind;
  model: string;
  sourceHash: string;
}

export interface RetrievalRepo {
  /** The RAJob columns indexing reads, for these ids (missing ids are left out). */
  loadIndexJobs(jobIds: string[]): Promise<IndexJobRow[]>;
  /** One statement: searchDoc, searchTsv = to_tsvector('simple', searchDoc), contentHash and lang. */
  writeSearchDoc(jobId: string, input: { searchDoc: string; contentHash: string; lang: string }): Promise<void>;
  jobEmbeddingMeta(jobIds: string[]): Promise<Map<string, EmbeddingMeta>>;
  upsertJobEmbedding(jobId: string, market: string, model: string, contentHash: string, vector: readonly number[]): Promise<void>;
  /** Mark stored vectors as checked now (their card text is unchanged). */
  touchJobEmbeddings(jobIds: string[]): Promise<void>;
  /**
   * Live canonical enriched rows that need indexing: no search document or no
   * content hash; or, when a model tag is given, a public row with no vector,
   * a vector of another model, or a vector older than the row's last
   * enrichment. Rows without a search document or content hash come FIRST
   * (they need no model and must never wait behind rows that only lack a
   * vector), then newest first. Pass a null tag when no vector can be written
   * now: only the rows that lack the lexical part are then returned.
   */
  jobsNeedingIndex(market: string, modelTag: string | null, limit: number): Promise<string[]>;
  indexStats(market: string, modelTag: string | null): Promise<IndexStats>;
  /** Live canonical enriched rows of the market, newest first (a re-index after the tokenizer or the fold table changed). */
  liveJobIds(market: string, limit: number): Promise<string[]>;
  /**
   * Public, canonical, open rows of the same market (and country when given)
   * nearest to the job's vector, the job itself left out, by exact cosine
   * distance. Empty when the job has no vector of this model tag.
   */
  nearestJobsByJob(jobId: string, options: { market: string; country?: string | null; modelTag: string; limit: number }): Promise<NearestJob[]>;
  userEmbeddingMeta(userId: string, market: string): Promise<UserEmbeddingMeta[]>;
  upsertUserEmbedding(userId: string, market: string, kind: UserVectorKind, model: string, sourceHash: string, vector: readonly number[]): Promise<void>;
  /** Delete the person's vectors of a market (all kinds, or the given ones). Returns the number of rows deleted. */
  deleteUserEmbeddings(userId: string, market: string, kinds?: readonly UserVectorKind[]): Promise<number>;
  /** The resume vector, else the intent vector, else null; only vectors of this model tag are read. */
  userVector(userId: string, market: string, modelTag: string): Promise<number[] | null>;
  /**
   * Delete the vectors of the person's own private imports in a market (their
   * text came from the person and was embedded under the AI consent). Returns
   * the number of rows deleted.
   */
  deleteJobEmbeddingsOfOwner(userId: string, market: string): Promise<number>;
  /**
   * User ids with a vector made from their own data in the market: a profile
   * or resume vector, or the vector of a private import they own. In id order
   * after `afterUserId`.
   */
  embeddedUserIds(market: string, afterUserId: string | null, limit: number): Promise<string[]>;
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
}

const INDEX_JOB_SELECT = {
  id: true,
  market: true,
  visibility: true,
  ownerUserId: true,
  title: true,
  primaryTaxonomyId: true,
  seniority: true,
  skills: true,
  skillsDetail: true,
  skillIds: true,
  summary: true,
  qualifications: true,
  descriptionPlain: true,
  archivedAt: true,
} as const satisfies Prisma.RAJobSelect;

/** A vector as the text literal pgvector reads (`[0.1,0.2,…]`). Throws unless it has exactly 1024 finite numbers. */
export function vectorLiteral(vector: readonly number[]): string {
  if (!Array.isArray(vector) || vector.length !== VECTOR_DIMENSIONS || !vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`retrieval: a vector must have exactly ${VECTOR_DIMENSIONS} finite numbers (got ${Array.isArray(vector) ? vector.length : 'no array'})`);
  }
  return `[${vector.join(',')}]`;
}

/** The text form pgvector returns (`[0.1,0.2,…]`) as numbers; null when it is not a 1024-number vector. */
export function parseVector(text: unknown): number[] | null {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!body) return null;
  const numbers = body.split(',').map((n) => Number(n));
  return numbers.length === VECTOR_DIMENSIONS && numbers.every((n) => Number.isFinite(n)) ? numbers : null;
}

const int = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Live canonical rows of a market: the rows the lists read. */
function liveJobs(market: string): Prisma.Sql {
  return Prisma.sql`j."market" = ${market} AND j."isCanonical" = true AND j."archivedAt" IS NULL AND j."closedAt" IS NULL`;
}

export function createRetrievalRepo(getDb: () => Promise<RetrievalDb>, now: () => Date = () => new Date()): RetrievalRepo {
  return {
    async loadIndexJobs(jobIds) {
      if (!jobIds.length) return [];
      const db = await getDb();
      return (await db.rAJob.findMany({ where: { id: { in: jobIds } }, select: INDEX_JOB_SELECT })) as IndexJobRow[];
    },

    async writeSearchDoc(jobId, { searchDoc, contentHash, lang }) {
      const db = await getDb();
      await db.$executeRaw(
        Prisma.sql`UPDATE "RAJob" SET "searchDoc" = ${searchDoc}, "searchTsv" = to_tsvector('simple', ${searchDoc}), "contentHash" = ${contentHash}, "lang" = ${lang} WHERE "id" = ${jobId}`,
      );
    },

    async jobEmbeddingMeta(jobIds) {
      const out = new Map<string, EmbeddingMeta>();
      if (!jobIds.length) return out;
      const db = await getDb();
      const rows = await db.$queryRaw<Array<{ jobId: string; model: string; contentHash: string }>>(
        Prisma.sql`SELECT e."jobId", e."model", e."contentHash" FROM "RAJobEmbedding" e WHERE e."jobId" = ANY(${jobIds}::text[])`,
      );
      for (const r of rows) out.set(r.jobId, { model: r.model, contentHash: r.contentHash });
      return out;
    },

    async upsertJobEmbedding(jobId, market, model, contentHash, vector) {
      const literal = vectorLiteral(vector);
      const db = await getDb();
      await db.$executeRaw(
        Prisma.sql`INSERT INTO "RAJobEmbedding" ("jobId", "market", "model", "contentHash", "embedding", "embeddedAt")
          VALUES (${jobId}, ${market}, ${model}, ${contentHash}, ${literal}::halfvec(1024), ${now()})
          ON CONFLICT ("jobId") DO UPDATE SET
            "market" = EXCLUDED."market",
            "model" = EXCLUDED."model",
            "contentHash" = EXCLUDED."contentHash",
            "embedding" = EXCLUDED."embedding",
            "embeddedAt" = EXCLUDED."embeddedAt"`,
      );
    },

    async touchJobEmbeddings(jobIds) {
      if (!jobIds.length) return;
      const db = await getDb();
      await db.$executeRaw(Prisma.sql`UPDATE "RAJobEmbedding" SET "embeddedAt" = ${now()} WHERE "jobId" = ANY(${jobIds}::text[])`);
    },

    async jobsNeedingIndex(market, modelTag, limit) {
      const db = await getDb();
      const vectorNeed = modelTag
        ? Prisma.sql` OR (j."visibility" = 'public' AND (e."jobId" IS NULL OR e."model" <> ${modelTag} OR e."embeddedAt" < j."enrichedAt"))`
        : Prisma.empty;
      const rows = await db.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT j."id" FROM "RAJob" j
          LEFT JOIN "RAJobEmbedding" e ON e."jobId" = j."id"
          WHERE ${liveJobs(market)} AND j."enrichedAt" IS NOT NULL
            AND (j."searchDoc" IS NULL OR j."contentHash" IS NULL${vectorNeed})
          ORDER BY (j."searchDoc" IS NULL OR j."contentHash" IS NULL) DESC, j."firstSeenAt" DESC, j."id" DESC
          LIMIT ${Math.max(1, Math.floor(limit))}`,
      );
      return rows.map((r) => r.id);
    },

    async indexStats(market, modelTag) {
      const db = await getDb();
      const tag = modelTag ?? '';
      const rows = await db.$queryRaw<Array<Record<keyof IndexStats, unknown>>>(
        Prisma.sql`SELECT
            count(*)::int AS "live",
            (count(*) FILTER (WHERE j."searchDoc" IS NULL))::int AS "missingDoc",
            (count(*) FILTER (WHERE e."model" = ${tag}))::int AS "withTag",
            (count(*) FILTER (WHERE e."model" IS DISTINCT FROM ${tag}))::int AS "missingVector",
            coalesce(sum(least(2000, length(j."title") + coalesce(length(j."summary"), 0) + least(1200, length(coalesce(nullif(j."qualifications", ''), j."descriptionPlain"))) + 200))
              FILTER (WHERE e."model" IS DISTINCT FROM ${tag}), 0)::float8 AS "missingVectorChars"
          FROM "RAJob" j
          LEFT JOIN "RAJobEmbedding" e ON e."jobId" = j."id"
          WHERE ${liveJobs(market)} AND j."visibility" = 'public' AND j."enrichedAt" IS NOT NULL`,
      );
      const r = rows[0];
      return { live: int(r?.live), missingDoc: int(r?.missingDoc), withTag: int(r?.withTag), missingVector: int(r?.missingVector), missingVectorChars: int(r?.missingVectorChars) };
    },

    async liveJobIds(market, limit) {
      const db = await getDb();
      const rows = await db.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT j."id" FROM "RAJob" j WHERE ${liveJobs(market)} AND j."enrichedAt" IS NOT NULL ORDER BY j."firstSeenAt" DESC, j."id" DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      );
      return rows.map((r) => r.id);
    },

    async nearestJobsByJob(jobId, { market, country, modelTag, limit }) {
      const db = await getDb();
      const inCountry = country ? Prisma.sql` AND j."locationCountry" = ${country}` : Prisma.empty;
      // The anchor row is joined, so a job without a vector of this model gives no rows. Exact distance, no index.
      const rows = await db.$queryRaw<Array<{ jobId: string; distance: number | string }>>(
        Prisma.sql`SELECT e."jobId", (e."embedding" <=> a."embedding")::float8 AS "distance"
          FROM "RAJobEmbedding" a
          JOIN "RAJobEmbedding" e ON e."market" = a."market" AND e."model" = a."model" AND e."jobId" <> a."jobId"
          JOIN "RAJob" j ON j."id" = e."jobId"
          WHERE a."jobId" = ${jobId} AND a."market" = ${market} AND a."model" = ${modelTag}
            AND ${liveJobs(market)} AND j."visibility" = 'public'${inCountry}
          ORDER BY e."embedding" <=> a."embedding", e."jobId"
          LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`,
      );
      return rows.map((r) => ({ jobId: r.jobId, distance: Number(r.distance) }));
    },

    async userEmbeddingMeta(userId, market) {
      const db = await getDb();
      const rows = await db.$queryRaw<Array<{ kind: string; model: string; sourceHash: string }>>(
        Prisma.sql`SELECT u."kind", u."model", u."sourceHash" FROM "RAUserEmbedding" u WHERE u."userId" = ${userId} AND u."market" = ${market}`,
      );
      return rows.filter((r): r is UserEmbeddingMeta => r.kind === 'intent' || r.kind === 'resume');
    },

    async upsertUserEmbedding(userId, market, kind, model, sourceHash, vector) {
      const literal = vectorLiteral(vector);
      const db = await getDb();
      await db.$executeRaw(
        Prisma.sql`INSERT INTO "RAUserEmbedding" ("userId", "market", "kind", "model", "sourceHash", "embedding", "updatedAt")
          VALUES (${userId}, ${market}, ${kind}, ${model}, ${sourceHash}, ${literal}::halfvec(1024), ${now()})
          ON CONFLICT ("userId", "market", "kind") DO UPDATE SET
            "model" = EXCLUDED."model",
            "sourceHash" = EXCLUDED."sourceHash",
            "embedding" = EXCLUDED."embedding",
            "updatedAt" = EXCLUDED."updatedAt"`,
      );
    },

    async deleteUserEmbeddings(userId, market, kinds) {
      if (kinds && kinds.length === 0) return 0;
      const db = await getDb();
      const ofKind = kinds ? Prisma.sql` AND "kind" = ANY(${[...kinds]}::text[])` : Prisma.empty;
      return db.$executeRaw(Prisma.sql`DELETE FROM "RAUserEmbedding" WHERE "userId" = ${userId} AND "market" = ${market}${ofKind}`);
    },

    async userVector(userId, market, modelTag) {
      const db = await getDb();
      const rows = await db.$queryRaw<Array<{ kind: string; embedding: string }>>(
        Prisma.sql`SELECT u."kind", u."embedding"::text AS "embedding" FROM "RAUserEmbedding" u
          WHERE u."userId" = ${userId} AND u."market" = ${market} AND u."model" = ${modelTag}`,
      );
      const pick = rows.find((r) => r.kind === 'resume') ?? rows.find((r) => r.kind === 'intent');
      return pick ? parseVector(pick.embedding) : null;
    },

    async deleteJobEmbeddingsOfOwner(userId, market) {
      const db = await getDb();
      return db.$executeRaw(
        Prisma.sql`DELETE FROM "RAJobEmbedding" e USING "RAJob" j
          WHERE j."id" = e."jobId" AND j."ownerUserId" = ${userId} AND j."visibility" = 'private' AND e."market" = ${market}`,
      );
    },

    async embeddedUserIds(market, afterUserId, limit) {
      const db = await getDb();
      const after = afterUserId ? Prisma.sql` WHERE x."userId" > ${afterUserId}` : Prisma.empty;
      // UNION removes duplicates: a person with both kinds of vector is listed once.
      const rows = await db.$queryRaw<Array<{ userId: string }>>(
        Prisma.sql`SELECT x."userId" FROM (
            SELECT u."userId" FROM "RAUserEmbedding" u WHERE u."market" = ${market}
            UNION
            SELECT j."ownerUserId" AS "userId" FROM "RAJobEmbedding" e JOIN "RAJob" j ON j."id" = e."jobId"
              WHERE e."market" = ${market} AND j."visibility" = 'private' AND j."ownerUserId" IS NOT NULL
          ) x${after} ORDER BY x."userId" LIMIT ${Math.max(1, Math.floor(limit))}`,
      );
      return rows.map((r) => r.userId);
    },

    async getConfig(key) {
      const db = await getDb();
      return (await db.appConfig.findUnique({ where: { key }, select: { value: true } }))?.value ?? null;
    },

    async setConfig(key, value) {
      const db = await getDb();
      await db.appConfig.upsert({ where: { key }, create: { key, value, updatedBy: 'retrieval' }, update: { value, updatedBy: 'retrieval' } });
    },
  };
}

async function defaultDb(): Promise<RetrievalDb> {
  return (await import('../../lib/prisma.js')).default as unknown as RetrievalDb;
}

/** The process-wide repository (the Prisma client is loaded on first use). */
export const defaultRetrievalRepo: RetrievalRepo = createRetrievalRepo(defaultDb);
