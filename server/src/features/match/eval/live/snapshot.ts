// server/src/features/match/eval/live/snapshot.ts
//
// A frozen snapshot of the real index for the live evaluation (strategy 2.6):
// per synthetic persona, the pooled candidates = the union of the top 50 of
// every retrieval variant under test. Everything is read inside ONE read-only
// transaction (`SET TRANSACTION READ ONLY` as its first statement, so the
// database itself refuses a write and nothing leaks to a pooled connection).
// The result is written under eval/.snapshots/<yyyy-mm-dd>/, which is
// git-ignored: real posting text is never committed.
//
// Raw SQL on RAJob lists its columns (never SELECT *, never searchTsv).
// Only postings are read. No user row, resume or profile is read: the people
// in this evaluation are the synthetic personas of fixtures/.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma } from '../../../../generated/prisma/client.js';
import type { MatchJobRecord } from '../../context.js';
import type { Persona } from '../fixtures/schema.js';
import { loadSeam } from '../seams.js';

export type SnapshotQuery = <T>(sql: Prisma.Sql) => Promise<T[]>;

/** Run `fn` with a query function that can only read. */
export type WithReadOnly = <T>(fn: (query: SnapshotQuery) => Promise<T>) => Promise<T>;

export interface RetrievalVariant {
  name: string;
  /** Candidate job ids for one persona, best first, at most `limit`. */
  candidateIds(persona: Persona, ctx: { query: SnapshotQuery; market: 'intl' | 'cn'; now: Date; limit: number }): Promise<string[]>;
}

/** Top of each variant that enters the pool (strategy 2.6: "the top 50 from every retrieval variant"). */
export const POOL_PER_VARIANT = 50;
const AGE_FLOOR_DAYS = 120;

/** Today's retrieval: the feed's own statement for the persona's role and place, newest first. */
export const recencyVariant: RetrievalVariant = {
  name: 'recency',
  async candidateIds(persona, ctx) {
    const jobIdsSql = await loadSeam<(input: Record<string, unknown>) => Prisma.Sql>('server/src/features/feed/sql.ts#jobIdsSql');
    const filters = { taxonomyIds: [persona.targetRoleId], locations: [persona.location] };
    const sql = jobIdsSql({
      scope: { market: ctx.market, userId: null, now: ctx.now, publicOnly: true, ignoreHidden: true },
      filters,
      fields: ['taxonomyIds', 'locations'],
      from: null,
      ageFloor: new Date(ctx.now.getTime() - AGE_FLOOR_DAYS * 86_400_000),
      orderBy: 'posted',
      limit: ctx.limit,
    });
    return (await ctx.query<{ id: string }>(sql)).map((r) => r.id);
  },
};

/** The variants a snapshot pools. A later bundle adds the lexical, dense and fused variants here. */
export const RETRIEVAL_VARIANTS: RetrievalVariant[] = [recencyVariant];

export interface SnapshotRow extends MatchJobRecord {
  postedAt: string | null;
}

interface RawRow extends Omit<MatchJobRecord, 'description' | 'responsibilities' | 'benefits' | 'archivedAt' | 'companyIndustries'> {
  postedAt: Date | string | null;
  companyIndustries: string[] | null;
}

/** The posting columns the matcher and the judge read, for live public rows of one market. */
export function snapshotRowsSql(ids: readonly string[], market: 'intl' | 'cn'): Prisma.Sql {
  return Prisma.sql`SELECT j."id", j."market", j."visibility", j."ownerUserId", j."title", j."companyName", j."descriptionPlain", j."qualifications",
  j."taxonomyIds", j."primaryTaxonomyId", j."seniority", j."minYears", j."maxYears", j."educationLevel", j."skills", j."skillsDetail",
  j."workModel", j."remoteScope", j."location", j."locationCity", j."locationCountry", j."geoLat", j."geoLng",
  j."salaryAnnualMin", j."salaryAnnualMax", j."salaryCurrency", j."salaryText", j."sponsorship", j."sponsorshipEvidence", j."marketTags",
  j."postedAt", c."industries" AS "companyIndustries"
FROM "RAJob" j LEFT JOIN "RACompany" c ON c."id" = j."companyId"
WHERE j."id" = ANY(${[...ids]}::text[]) AND j."market" = ${market} AND j."visibility" = 'public' AND j."archivedAt" IS NULL`;
}

function toRow(r: RawRow): SnapshotRow {
  return {
    ...r,
    description: r.descriptionPlain,
    responsibilities: null,
    benefits: null,
    archivedAt: null,
    companyIndustries: r.companyIndustries ?? [],
    postedAt: r.postedAt instanceof Date ? r.postedAt.toISOString() : r.postedAt,
  };
}

export interface PersonaPool {
  personaId: string;
  /** variant name → its ids, best first. */
  variants: Record<string, string[]>;
  /** The union, each id once, in first-seen order. */
  pooled: string[];
}

export interface Snapshot {
  date: string;
  market: 'intl' | 'cn';
  takenAt: string;
  variants: string[];
  pools: PersonaPool[];
  rows: SnapshotRow[];
}

export function snapshotDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Take the snapshot of one market inside one read-only transaction. Writes nothing to the database. */
export async function takeSnapshot(input: { market: 'intl' | 'cn'; personas: Persona[]; withReadOnly: WithReadOnly; variants?: RetrievalVariant[]; now: Date; perVariant?: number }): Promise<Snapshot> {
  const variants = input.variants ?? RETRIEVAL_VARIANTS;
  const limit = input.perVariant ?? POOL_PER_VARIANT;
  return input.withReadOnly(async (query) => {
    const pools: PersonaPool[] = [];
    const all = new Set<string>();
    for (const persona of input.personas) {
      const byVariant: Record<string, string[]> = {};
      const pooled: string[] = [];
      for (const v of variants) {
        const ids = (await v.candidateIds(persona, { query, market: input.market, now: input.now, limit })).slice(0, limit);
        byVariant[v.name] = ids;
        for (const id of ids) if (!pooled.includes(id)) pooled.push(id);
      }
      pools.push({ personaId: persona.id, variants: byVariant, pooled });
      for (const id of pooled) all.add(id);
    }
    const rows: SnapshotRow[] = [];
    const ids = [...all];
    for (let i = 0; i < ids.length; i += 500) rows.push(...(await query<RawRow>(snapshotRowsSql(ids.slice(i, i + 500), input.market))).map(toRow));
    return { date: snapshotDate(input.now), market: input.market, takenAt: input.now.toISOString(), variants: variants.map((v) => v.name), pools, rows };
  });
}

/** Write a snapshot under `<snapshotsDir>/<date>/snapshot.<market>.json` and answer the file. */
export function writeSnapshot(snapshot: Snapshot, snapshotsDir: string): string {
  const dir = path.join(snapshotsDir, snapshot.date);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `snapshot.${snapshot.market}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

/** The production reader: one Prisma transaction made read-only by its first statement. */
export const defaultWithReadOnly: WithReadOnly = async (fn) => {
  const { prisma } = await import('../../../../lib/prisma.js');
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      return fn(<T>(sql: Prisma.Sql) => tx.$queryRaw<T[]>(sql));
    },
    { timeout: 300_000, maxWait: 20_000 },
  );
};
