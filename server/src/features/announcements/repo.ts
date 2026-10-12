// server/src/features/announcements/repo.ts — `RAAnnouncement` access (typed Prisma).
//
// The publish switch (SR-61-1). SCHEMA-4 added `RAAnnouncement.active
// Boolean?` — nullable, no default, and no backfill has run. So:
//   - writes set the COLUMN (create always; update whenever the switch or the
//     cohort changes) and keep the same value under the reserved `active` key
//     of the `cohort` JSON, where it lived before the column, so a row written
//     now still reads right for code that only knows the JSON key (a rollback,
//     an older deployment during a release);
//   - reads use the column when it is non-null, else `cohort.active` (null = a
//     row from before the column). Rows with neither read as drafts, so
//     nothing is shown by accident;
//   - the "published" filter is `PUBLISHED_WHERE`, an OR of both forms. Never
//     `{ active: true }` alone until the owner has run the backfill: rows
//     published before the column would silently disappear.
// The reserved key is never part of the cohort the admin edits
// (`AnnouncementCohortSchema` is strict and the adapter strips it).

import type { Prisma } from '../../generated/prisma/client.js';
import type prismaClient from '../../lib/prisma.js';
import { AnnouncementCohortSchema, AnnouncementContentSchema, type AnnouncementCohort, type AnnouncementContent } from './contract.js';

export interface AnnouncementRecord {
  id: string;
  key: string;
  brand: string;
  locales: string[];
  content: AnnouncementContent;
  cohort: AnnouncementCohort;
  active: boolean;
  priority: number;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

export type NewAnnouncement = Omit<AnnouncementRecord, 'id' | 'createdAt'>;
export type AnnouncementUpdate = Partial<Omit<AnnouncementRecord, 'id' | 'key' | 'brand' | 'createdAt'>>;

export interface AnnouncementsRepo {
  /**
   * Published rows of a brand whose window contains `now` (drafts never take
   * a slot). `excludeIds` (the person's seen list, capped at 200) is filtered
   * in the query, so the row limit counts unseen rows only.
   */
  listInWindow(brand: string, now: Date, excludeIds?: readonly string[]): Promise<AnnouncementRecord[]>;
  list(filter: { brand?: string }): Promise<AnnouncementRecord[]>;
  get(id: string): Promise<AnnouncementRecord | null>;
  getByKey(key: string): Promise<AnnouncementRecord | null>;
  create(input: NewAnnouncement): Promise<AnnouncementRecord>;
  update(id: string, patch: AnnouncementUpdate): Promise<AnnouncementRecord>;
  delete(id: string): Promise<boolean>;
}

type Db = Pick<typeof prismaClient, 'rAAnnouncement'>;

interface Row {
  id: string;
  key: string;
  brand: string;
  locales: string[];
  content: Prisma.JsonValue;
  cohort: Prisma.JsonValue;
  /** The column (SR-61-1); null/absent = a row written before it existed. */
  active?: boolean | null;
  priority: number;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The publish switch: the column when it is set, else the reserved key in
 * the cohort JSON (rows from before the column).
 */
export function readActive(cohortJson: unknown, column?: boolean | null): boolean {
  if (typeof column === 'boolean') return column;
  return isObject(cohortJson) && cohortJson.active === true;
}

/** Tolerant read: malformed locale entries or cohort parts are dropped. */
export function fromRow(row: Row): AnnouncementRecord {
  const content: AnnouncementContent = {};
  if (isObject(row.content)) {
    for (const [locale, value] of Object.entries(row.content)) {
      const parsed = AnnouncementContentSchema.safeParse({ [locale]: value });
      if (parsed.success) content[locale] = parsed.data[locale]!;
    }
  }
  const rawCohort = isObject(row.cohort) ? { ...row.cohort } : {};
  delete rawCohort.active;
  const cohort = AnnouncementCohortSchema.safeParse(rawCohort);
  return {
    id: row.id,
    key: row.key,
    brand: row.brand,
    locales: [...row.locales],
    content,
    cohort: cohort.success ? cohort.data : {},
    active: readActive(row.cohort, row.active),
    priority: row.priority,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
  };
}

/** The stored cohort JSON (cohort + the mirrored publish switch; see the file header). */
export function cohortJson(cohort: AnnouncementCohort, active: boolean): Prisma.InputJsonValue {
  return { ...cohort, active } as Prisma.InputJsonValue;
}

/**
 * The "published" filter, applied in the query so drafts never take one of
 * the `take` slots of `listInWindow`: the column says so, or the column is
 * still null and the JSON key says so. Do not reduce it to `{ active: true }`
 * (index `[brand, active, startsAt, endsAt]`) before the backfill has run.
 */
export const PUBLISHED_WHERE = {
  OR: [{ active: true }, { active: null, cohort: { path: ['active'], equals: true } }],
} satisfies Prisma.RAAnnouncementWhereInput;

/** Rows `listInWindow` reads at most (published, in window, not seen, lowest priority first). */
export const LIST_IN_WINDOW_LIMIT = 50;

const SELECT = {
  id: true,
  key: true,
  brand: true,
  locales: true,
  content: true,
  cohort: true,
  active: true,
  priority: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
} as const;

async function defaultDb(): Promise<Db> {
  return (await import('../../lib/prisma.js')).default;
}

export function createPrismaAnnouncementsRepo(getDb: () => Promise<Db> = defaultDb): AnnouncementsRepo {
  return {
    async listInWindow(brand, now, excludeIds = []) {
      const db = await getDb();
      const seen = excludeIds.length ? { id: { notIn: [...excludeIds] } } : {};
      const rows = await db.rAAnnouncement.findMany({
        where: { brand, startsAt: { lte: now }, endsAt: { gt: now }, ...PUBLISHED_WHERE, ...seen },
        orderBy: [{ priority: 'asc' }, { startsAt: 'desc' }],
        take: LIST_IN_WINDOW_LIMIT,
        select: SELECT,
      });
      // The filter is in the query; the in-memory check guards adapters that ignore JSON paths.
      return rows.map(fromRow).filter((r) => r.active);
    },
    async list(filter) {
      const db = await getDb();
      const rows = await db.rAAnnouncement.findMany({
        where: filter.brand ? { brand: filter.brand } : {},
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: SELECT,
      });
      return rows.map(fromRow);
    },
    async get(id) {
      const db = await getDb();
      const row = await db.rAAnnouncement.findUnique({ where: { id }, select: SELECT });
      return row ? fromRow(row) : null;
    },
    async getByKey(key) {
      const db = await getDb();
      const row = await db.rAAnnouncement.findUnique({ where: { key }, select: SELECT });
      return row ? fromRow(row) : null;
    },
    async create(input) {
      const db = await getDb();
      const row = await db.rAAnnouncement.create({
        data: {
          key: input.key,
          brand: input.brand,
          locales: input.locales,
          content: input.content as Prisma.InputJsonValue,
          cohort: cohortJson(input.cohort, input.active),
          active: input.active,
          priority: input.priority,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        },
        select: SELECT,
      });
      return fromRow(row);
    },
    async update(id, patch) {
      const db = await getDb();
      const current = await db.rAAnnouncement.findUnique({ where: { id }, select: SELECT });
      if (!current) throw new Error('announcement not found');
      const now = fromRow(current);
      const data: Prisma.RAAnnouncementUpdateInput = {};
      if (patch.locales) data.locales = patch.locales;
      if (patch.content) data.content = patch.content as Prisma.InputJsonValue;
      if (patch.cohort !== undefined || patch.active !== undefined) {
        const active = patch.active ?? now.active;
        data.cohort = cohortJson(patch.cohort ?? now.cohort, active);
        // Also moves a row from before the column onto it (same value it read as).
        data.active = active;
      }
      if (patch.priority !== undefined) data.priority = patch.priority;
      if (patch.startsAt) data.startsAt = patch.startsAt;
      if (patch.endsAt) data.endsAt = patch.endsAt;
      const row = await db.rAAnnouncement.update({ where: { id }, data, select: SELECT });
      return fromRow(row);
    },
    async delete(id) {
      const db = await getDb();
      const { count } = await db.rAAnnouncement.deleteMany({ where: { id } });
      return count > 0;
    },
  };
}
