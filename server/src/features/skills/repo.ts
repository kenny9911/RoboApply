// server/src/features/skills/repo.ts
//
// Reads and writes of the scalar columns of RASkill. The label vector
// (`embedding`, an Unsupported halfvec column) is not here: the client cannot
// write it, so canonicalize.ts writes and searches it with raw SQL.
//
// `createPrismaSkillRepo()` imports the Prisma client inside its first call,
// so importing this file opens no database connection.
// `createMemorySkillRepo()` is the same contract over a Map, for tests and for
// the dry runs of the review tooling.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';

/** One RASkill row without its vector. `aliases` are comparison keys (keys.ts `aliasKey`), never spellings. */
export interface SkillRow {
  id: string;
  kind: string;
  labelEn: string;
  labelZh: string | null;
  labelZhHant: string | null;
  aliases: string[];
  parentId: string | null;
  esco: string | null;
  onet: string | null;
  /** 'reviewed' | 'unreviewed' | 'dropped' | 'seed' (types.ts: SKILL_STATUS_DROPPED, SKILL_STATUS_SEED). */
  status: string;
  mentionCount: number;
}

/** What a write gives; `mentionCount` is only set when a row is created. */
export type SkillWrite = Omit<SkillRow, 'mentionCount'> & { mentionCount?: number };

export interface SkillRepo {
  /** Every row, ordered by id. */
  list(): Promise<SkillRow[]>;
  /** Rows by frequency, most mentioned first (the review list), without the rows of status `notStatus`. */
  listByMentions(options: { limit: number; notStatus?: string }): Promise<SkillRow[]>;
  /** Create or replace the scalar columns of each row (the mention count of an existing row is kept). Returns the number of rows written. */
  upsert(rows: readonly SkillWrite[]): Promise<number>;
  /** Insert the rows that do not exist yet; an existing row is left exactly as it is. Returns the number inserted. */
  createMissing(rows: readonly SkillWrite[]): Promise<number>;
  /** Add comparison keys to a row's aliases (no duplicates). Returns false when the row does not exist. */
  addAliasKeys(id: string, keys: readonly string[]): Promise<boolean>;
  /** Count one more mention for each id (the review list is ordered by it). */
  incrementMentions(ids: readonly string[], by?: number): Promise<void>;
  /** Set esco and/or onet on one row. */
  setExternalIds(id: string, ids: { esco?: string; onet?: string }): Promise<void>;
}

const SELECT = {
  id: true,
  kind: true,
  labelEn: true,
  labelZh: true,
  labelZhHant: true,
  aliases: true,
  parentId: true,
  esco: true,
  onet: true,
  status: true,
  mentionCount: true,
} as const;

type SkillDb = Pick<ExtendedPrismaClient, 'rASkill' | '$transaction'>;

/** Rows per transaction of `upsert` (a reviewed sheet has about a thousand). */
const UPSERT_CHUNK = 100;

function scalars(row: SkillWrite) {
  return {
    kind: row.kind,
    labelEn: row.labelEn,
    labelZh: row.labelZh,
    labelZhHant: row.labelZhHant,
    aliases: [...new Set(row.aliases)],
    parentId: row.parentId,
    esco: row.esco,
    onet: row.onet,
    status: row.status,
  };
}

/** The repo over the real table. `getDb` defaults to the process's Prisma client, imported on first use. */
export function createPrismaSkillRepo(getDb: () => Promise<SkillDb> = async () => (await import('../../lib/prisma.js')).default): SkillRepo {
  return {
    async list() {
      const db = await getDb();
      return db.rASkill.findMany({ select: SELECT, orderBy: { id: 'asc' } });
    },
    async listByMentions({ limit, notStatus }) {
      const db = await getDb();
      return db.rASkill.findMany({
        select: SELECT,
        ...(notStatus ? { where: { status: { not: notStatus } } } : {}),
        orderBy: [{ mentionCount: 'desc' }, { id: 'asc' }],
        take: limit,
      });
    },
    async upsert(rows) {
      if (!rows.length) return 0;
      const db = await getDb();
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        await db.$transaction(
          rows.slice(i, i + UPSERT_CHUNK).map((row) =>
            db.rASkill.upsert({
              where: { id: row.id },
              create: { id: row.id, ...scalars(row), mentionCount: row.mentionCount ?? 0 },
              update: scalars(row),
            }),
          ),
        );
      }
      return rows.length;
    },
    async createMissing(rows) {
      if (!rows.length) return 0;
      const db = await getDb();
      const result = await db.rASkill.createMany({
        data: rows.map((row) => ({ id: row.id, ...scalars(row), mentionCount: row.mentionCount ?? 0 })),
        skipDuplicates: true,
      });
      return result.count;
    },
    async addAliasKeys(id, keys) {
      const db = await getDb();
      const row = await db.rASkill.findUnique({ where: { id }, select: { aliases: true } });
      if (!row) return false;
      const add = [...new Set(keys)].filter((k) => k && !row.aliases.includes(k));
      if (add.length) await db.rASkill.update({ where: { id }, data: { aliases: { push: add } } });
      return true;
    },
    async incrementMentions(ids, by = 1) {
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return;
      const db = await getDb();
      await db.rASkill.updateMany({ where: { id: { in: unique } }, data: { mentionCount: { increment: by } } });
    },
    async setExternalIds(id, ids) {
      const data = { ...(ids.esco !== undefined ? { esco: ids.esco } : {}), ...(ids.onet !== undefined ? { onet: ids.onet } : {}) };
      if (!Object.keys(data).length) return;
      const db = await getDb();
      await db.rASkill.update({ where: { id }, data });
    },
  };
}

export interface MemorySkillRepo extends SkillRepo {
  /** The rows, for assertions. */
  readonly rows: Map<string, SkillRow>;
  /** Number of calls that changed something. A dry run must leave it at 0. */
  writes: number;
  /** Number of `list` / `listByMentions` calls. */
  reads: number;
}

/** The same contract over a Map. */
export function createMemorySkillRepo(initial: readonly SkillWrite[] = []): MemorySkillRepo {
  const rows = new Map<string, SkillRow>();
  const toRow = (row: SkillWrite, mentionCount: number): SkillRow => ({ id: row.id, ...scalars(row), mentionCount });
  for (const row of initial) rows.set(row.id, toRow(row, row.mentionCount ?? 0));
  const sorted = () => [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => ({ ...r, aliases: [...r.aliases] }));
  const repo: MemorySkillRepo = {
    rows,
    writes: 0,
    reads: 0,
    async list() {
      repo.reads++;
      return sorted();
    },
    async listByMentions({ limit, notStatus }) {
      repo.reads++;
      return sorted()
        .filter((r) => !notStatus || r.status !== notStatus)
        .sort((a, b) => b.mentionCount - a.mentionCount)
        .slice(0, limit);
    },
    async upsert(writes) {
      for (const row of writes) rows.set(row.id, toRow(row, rows.get(row.id)?.mentionCount ?? row.mentionCount ?? 0));
      if (writes.length) repo.writes++;
      return writes.length;
    },
    async createMissing(writes) {
      let n = 0;
      for (const row of writes) {
        if (rows.has(row.id)) continue;
        rows.set(row.id, toRow(row, row.mentionCount ?? 0));
        n++;
      }
      if (n) repo.writes++;
      return n;
    },
    async addAliasKeys(id, keys) {
      const row = rows.get(id);
      if (!row) return false;
      const add = [...new Set(keys)].filter((k) => k && !row.aliases.includes(k));
      if (add.length) {
        row.aliases.push(...add);
        repo.writes++;
      }
      return true;
    },
    async incrementMentions(ids, by = 1) {
      for (const id of new Set(ids)) {
        const row = rows.get(id);
        if (row) row.mentionCount += by;
      }
      if (ids.length) repo.writes++;
    },
    async setExternalIds(id, ids) {
      const row = rows.get(id);
      if (!row) return;
      if (ids.esco !== undefined) row.esco = ids.esco;
      if (ids.onet !== undefined) row.onet = ids.onet;
      repo.writes++;
    },
  };
  return repo;
}
