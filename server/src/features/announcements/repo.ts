// server/src/features/announcements/repo.ts — `RAAnnouncement` access (typed Prisma).
//
// NARROW ADAPTER for schema request SR-61-1. The contract has a publish switch
// (`active`); the table has no column for it yet. Until SCHEMA-4 adds
// `RAAnnouncement.active Boolean @default(false)`, the switch is kept inside
// the `cohort` JSON under the reserved key `active` (never part of the
// cohort the admin edits: `AnnouncementCohortSchema` is strict and the
// adapter strips it). Rows without the key read as drafts, so nothing is
// shown by accident. After the push, switch `readActive`/`writeRow` to the
// column (reading the JSON key as a fallback for rows written before).

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
  priority: number;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** SR-61-1 interim: the publish switch inside the cohort JSON. */
export function readActive(cohortJson: unknown): boolean {
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
    active: readActive(row.cohort),
    priority: row.priority,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
  };
}

/** The stored cohort JSON (cohort + the interim publish switch). */
export function cohortJson(cohort: AnnouncementCohort, active: boolean): Prisma.InputJsonValue {
  return { ...cohort, active } as Prisma.InputJsonValue;
}

/**
 * SR-61-1 interim: the "published" filter on the JSON key, so drafts never
 * take one of the `take` slots of `listInWindow`. Once the column exists this
 * becomes `{ active: true }` (index `[brand, active, startsAt, endsAt]`).
 */
export const PUBLISHED_WHERE = { cohort: { path: ['active'], equals: true } } satisfies Prisma.RAAnnouncementWhereInput;

/** Rows `listInWindow` reads at most (published, in window, not seen, lowest priority first). */
export const LIST_IN_WINDOW_LIMIT = 50;

const SELECT = {
  id: true,
  key: true,
  brand: true,
  locales: true,
  content: true,
  cohort: true,
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
        data.cohort = cohortJson(patch.cohort ?? now.cohort, patch.active ?? now.active);
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
