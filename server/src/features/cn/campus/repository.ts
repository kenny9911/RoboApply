// server/src/features/cn/campus/repository.ts — RACampusEvent /
// RACampusSubscription access behind a narrow interface, so the service and
// the reminder producer are tested without a database. Typed Prisma only
// (TASK_PLAN.md §2.1 rule 5).

import type prismaClient from '../../../lib/prisma.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import {
  CAMPUS_EVENT_SELECT,
  CAMPUS_LIST_ORDER,
  campusListWhere,
  type CampusEventRow,
  type CampusListFilter,
  type CampusSubscriptionRow,
} from './views.js';

type Db = typeof prismaClient;

/** Columns a create/update may write (the service validates them first). */
export interface CampusEventWrite {
  companyName?: string;
  companyId?: string | null;
  title?: string;
  graduationClass?: string;
  kind?: string;
  applyOpensAt?: Date | null;
  applyClosesAt?: Date | null;
  stages?: unknown;
  cities?: string[];
  roles?: string[];
  officialUrl?: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  sourceNote?: string | null;
  status?: string;
  verifiedAt?: Date | null;
  verifiedByUserId?: string | null;
}

export interface CampusRepository {
  /** Published, verified rows of the market matching the filter, closing soonest first. */
  listPublished(market: string, filter: CampusListFilter, now: Date, skip: number, take: number): Promise<CampusEventRow[]>;
  /**
   * Published, verified rows of the market whose company name gives `slug`
   * under `campusCompanySlug` (case-insensitive). Resolved in the database,
   * because a slug cannot be turned back into a name: '-' may be a space or a
   * hyphen of the name ('TP-LINK 普联' → 'TP-LINK-普联').
   */
  listPublishedByCompanySlug(market: string, slug: string, now: Date, take: number): Promise<CampusEventRow[]>;
  findEvent(id: string): Promise<CampusEventRow | null>;
  eventsByIds(ids: string[]): Promise<CampusEventRow[]>;
  adminList(market: string, status: string | undefined, skip: number, take: number): Promise<CampusEventRow[]>;
  createEvent(data: CampusEventWrite & { market: string; createdBy: string; companyName: string; title: string; graduationClass: string; officialUrl: string }): Promise<CampusEventRow>;
  updateEvent(id: string, data: CampusEventWrite): Promise<CampusEventRow>;
  deleteEvent(id: string): Promise<void>;
  /** Display label (name, else email) per user id. */
  userLabels(ids: string[]): Promise<Map<string, string>>;

  listSubscriptions(userId: string): Promise<CampusSubscriptionRow[]>;
  subscribedEventIds(userId: string, eventIds: string[]): Promise<Set<string>>;
  upsertEventSubscription(userId: string, eventId: string, channel: string): Promise<CampusSubscriptionRow>;
  upsertCompanySubscription(userId: string, companyNameNormalized: string, graduationClass: string, channel: string): Promise<CampusSubscriptionRow>;
  /** Delete the user's own subscription; false when it is not theirs or missing. */
  deleteSubscription(userId: string, id: string): Promise<boolean>;
  /** The user's 届别 from RAProfile.cnFields.graduationClass (e.g. 2027), or null. */
  graduationClassOf(userId: string): Promise<number | null>;
}

const SUB_SELECT = {
  id: true,
  kind: true,
  eventId: true,
  companyNameNormalized: true,
  graduationClass: true,
  channel: true,
  createdAt: true,
} as const satisfies Prisma.RACampusSubscriptionSelect;

export function createCampusRepository(getDb: () => Promise<Db>): CampusRepository {
  return {
    async listPublished(market, filter, now, skip, take) {
      const db = await getDb();
      return db.rACampusEvent.findMany({ where: campusListWhere(market, filter, now), orderBy: CAMPUS_LIST_ORDER, skip, take, select: CAMPUS_EVENT_SELECT });
    },
    async listPublishedByCompanySlug(market, slug, now, take) {
      const db = await getDb();
      // Same steps as campusCompanySlug: NFKC, trim, every whitespace run → '-'.
      // Compared with lower() on both sides (not ILIKE: '%' and '_' are not wildcards in a slug).
      // POSIX classes, not \s: a cooked template string would turn '\s' into 's'.
      const matches = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "RACampusEvent"
        WHERE "market" = ${market}
          AND "status" = 'published'
          AND lower(regexp_replace(regexp_replace(normalize("companyName", NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '[[:space:]]+', '-', 'g')) = lower(${slug})
        LIMIT 500`;
      if (!matches.length) return [];
      const where = campusListWhere(market, {}, now);
      return db.rACampusEvent.findMany({
        where: { AND: [where, { id: { in: matches.map((m) => m.id) } }] },
        orderBy: CAMPUS_LIST_ORDER,
        take,
        select: CAMPUS_EVENT_SELECT,
      });
    },
    async findEvent(id) {
      const db = await getDb();
      return db.rACampusEvent.findUnique({ where: { id }, select: CAMPUS_EVENT_SELECT });
    },
    async eventsByIds(ids) {
      if (!ids.length) return [];
      const db = await getDb();
      return db.rACampusEvent.findMany({ where: { id: { in: ids } }, select: CAMPUS_EVENT_SELECT });
    },
    async adminList(market, status, skip, take) {
      const db = await getDb();
      return db.rACampusEvent.findMany({
        where: { market, ...(status ? { status } : {}) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
        select: CAMPUS_EVENT_SELECT,
      });
    },
    async createEvent(data) {
      const db = await getDb();
      return db.rACampusEvent.create({ data: toData(data) as Prisma.RACampusEventUncheckedCreateInput, select: CAMPUS_EVENT_SELECT });
    },
    async updateEvent(id, data) {
      const db = await getDb();
      return db.rACampusEvent.update({ where: { id }, data: toData(data), select: CAMPUS_EVENT_SELECT });
    },
    async deleteEvent(id) {
      const db = await getDb();
      await db.rACampusEvent.delete({ where: { id } });
    },
    async userLabels(ids) {
      const out = new Map<string, string>();
      if (!ids.length) return out;
      const db = await getDb();
      const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
      for (const u of users) out.set(u.id, u.name?.trim() || u.email);
      return out;
    },

    async listSubscriptions(userId) {
      const db = await getDb();
      return db.rACampusSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 500, select: SUB_SELECT });
    },
    async subscribedEventIds(userId, eventIds) {
      if (!eventIds.length) return new Set();
      const db = await getDb();
      const rows = await db.rACampusSubscription.findMany({ where: { userId, eventId: { in: eventIds } }, select: { eventId: true } });
      return new Set(rows.map((r) => r.eventId).filter((x): x is string => !!x));
    },
    async upsertEventSubscription(userId, eventId, channel) {
      const db = await getDb();
      return db.rACampusSubscription.upsert({
        where: { userId_eventId: { userId, eventId } },
        create: { userId, eventId, kind: 'event', channel },
        update: { channel },
        select: SUB_SELECT,
      });
    },
    async upsertCompanySubscription(userId, companyNameNormalized, graduationClass, channel) {
      const db = await getDb();
      return db.rACampusSubscription.upsert({
        where: { userId_kind_companyNameNormalized: { userId, kind: 'company', companyNameNormalized } },
        create: { userId, kind: 'company', companyNameNormalized, graduationClass, channel },
        update: { graduationClass, channel },
        select: SUB_SELECT,
      });
    },
    async deleteSubscription(userId, id) {
      const db = await getDb();
      const r = await db.rACampusSubscription.deleteMany({ where: { id, userId } });
      return r.count > 0;
    },
    async graduationClassOf(userId) {
      const db = await getDb();
      const row = await db.rAProfile.findUnique({ where: { userId }, select: { cnFields: true } });
      const cls = (row?.cnFields as { graduationClass?: unknown } | null | undefined)?.graduationClass;
      return typeof cls === 'number' && Number.isInteger(cls) ? cls : null;
    },
  };
}

function toData(data: CampusEventWrite & { market?: string; createdBy?: string }): Prisma.RACampusEventUncheckedUpdateInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = k === 'stages' ? (v as Prisma.InputJsonValue) : v;
  }
  return out as Prisma.RACampusEventUncheckedUpdateInput;
}

const defaultGetDb = async (): Promise<Db> => (await import('../../../lib/prisma.js')).default;

export const defaultCampusRepository = (): CampusRepository => createCampusRepository(defaultGetDb);
