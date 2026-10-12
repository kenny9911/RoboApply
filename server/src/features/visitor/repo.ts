// server/src/features/visitor/repo.ts — storage for logged-out job alerts (WP-78).
//
// Typed Prisma over `RAAnonAlertSubscription` (ra-notify), `RAAuthToken`
// (kind `anon_alert_confirm`, sha256 of the token only) and `RAJob` (the new
// public jobs an alert lists). The service and the digest runner depend on
// the `VisitorAlertsRepo` interface; tests use `createMemoryVisitorAlertsRepo`.

import { Prisma } from '../../generated/prisma/client.js';
import prisma from '../../lib/prisma.js';
import type { Market } from '../../platform/brand/registry.js';
import { allowedPublicBoards, basePublicWhere } from '../seo/index.js';
import { ANON_ALERT_TOKEN_KIND, type AnonAlertCadence, type AnonAlertFilters, type AnonAlertState } from './contract.js';

export interface AnonAlertRow {
  id: string;
  brand: string;
  email: string;
  emailHash: string;
  locale: string;
  filters: unknown;
  cadence: string;
  status: string;
  confirmedAt: Date | null;
  unsubscribedAt: Date | null;
  lastSentAt: Date | null;
  createdAt: Date;
}

export interface ConfirmTokenRow {
  id: string;
  brand: string;
  kind: string;
  payload: unknown;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface AlertJobRow {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  locationCity: string | null;
  workModel: string | null;
  salaryDisclosed: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryText: string | null;
}

export interface NewJobsQuery {
  market: Market;
  filters: AnonAlertFilters;
  since: Date;
  now: Date;
  take: number;
}

export interface VisitorAlertsRepo {
  /** Pending or confirmed subscriptions of one address on one brand. */
  liveByEmail(brand: string, emailHash: string): Promise<AnonAlertRow[]>;
  create(data: { brand: string; email: string; emailHash: string; locale: string; filters: AnonAlertFilters; cadence: AnonAlertCadence }): Promise<AnonAlertRow>;
  /** `createdAt` is moved only when a pending sign-up is sent a new confirm link (it is the pending purge clock). */
  update(id: string, data: Partial<Pick<AnonAlertRow, 'locale' | 'cadence' | 'status' | 'confirmedAt' | 'lastSentAt' | 'createdAt'>>): Promise<void>;
  find(id: string): Promise<AnonAlertRow | null>;
  createToken(data: { brand: string; tokenHash: string; subscriptionId: string; expiresAt: Date }): Promise<void>;
  findToken(tokenHash: string): Promise<ConfirmTokenRow | null>;
  consumeToken(id: string, at: Date): Promise<void>;
  unsubscribeByEmailHash(brand: string, emailHash: string, at: Date): Promise<number>;
  /** Confirmed subscriptions whose next email is due, oldest first. */
  due(brand: string, cut: { daily: Date; weekly: Date }, limit: number): Promise<AnonAlertRow[]>;
  /** Delete never-confirmed rows created before `pendingBefore` and rows unsubscribed before `unsubscribedBefore`. */
  purge(brand: string, cut: { pendingBefore: Date; unsubscribedBefore: Date }): Promise<{ pending: number; unsubscribed: number }>;
  /** Public jobs (ARCH §9.4 predicate) first seen after `since` that match the filters: newest `take` and the total. */
  newJobs(q: NewJobsQuery): Promise<{ rows: AlertJobRow[]; total: number }>;
}

// ── Filters → RAJob where ────────────────────────────────────────────────

/** The alert filters as RAJob conditions (no conditions = any public job). */
export function filtersWhere(filters: AnonAlertFilters): Prisma.RAJobWhereInput[] {
  const and: Prisma.RAJobWhereInput[] = [];
  const q = filters.q?.trim();
  if (q) and.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }, { titleNormalized: { contains: q.toLowerCase() } }] });
  if (filters.taxonomyIds?.length) and.push({ taxonomyIds: { hasSome: [...filters.taxonomyIds] } });
  if (filters.locations?.length) {
    and.push({
      OR: filters.locations.map((l) => ({
        locationCity: { equals: (l.city ?? l.label).trim(), mode: 'insensitive' as const },
        ...(l.country ? { locationCountry: l.country.toUpperCase() } : {}),
      })),
    });
  } else if (filters.country) {
    and.push({ OR: [{ locationCountry: filters.country }, { workModel: 'remote', remoteScope: { in: [filters.country, 'global'] } }] });
  }
  if (filters.workModels?.length) and.push({ workModel: { in: [...filters.workModels] } });
  return and;
}

const JOB_SELECT = {
  id: true,
  title: true,
  companyName: true,
  location: true,
  locationCity: true,
  workModel: true,
  salaryDisclosed: true,
  salaryMin: true,
  salaryMax: true,
  salaryCurrency: true,
  salaryPeriod: true,
  salaryText: true,
} as const;

type VisitorDb = Pick<typeof prisma, 'rAAnonAlertSubscription' | 'rAAuthToken' | 'rAJob'>;

/**
 * The ids among `ids` that a public job page may show right now (ARCH §9.4, the
 * seo predicate: not expired, no fraud flag, a provider still in
 * PUBLIC_DISPLAY_PROVIDERS or a consenting recruiter bank). The same rule the
 * visitor feed applies (feed/publicRoutes.ts); used for the assistant's job cards.
 */
export function prismaPublicJobIds(db: Pick<typeof prisma, 'rAJob'> = prisma) {
  return async (ids: string[], brand: { market: Market }, now: Date): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    const base = basePublicWhere({ market: brand.market, now, publicBoards: allowedPublicBoards() });
    const rows = await db.rAJob.findMany({ where: { ...base, id: { in: ids } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  };
}

export function createPrismaVisitorAlertsRepo(db: VisitorDb = prisma): VisitorAlertsRepo {
  const live: AnonAlertState[] = ['pending', 'confirmed'];
  return {
    liveByEmail: (brand, emailHash) => db.rAAnonAlertSubscription.findMany({ where: { brand, emailHash, status: { in: live } }, orderBy: { createdAt: 'asc' } }),
    create: (data) =>
      db.rAAnonAlertSubscription.create({
        data: { ...data, filters: data.filters as Prisma.InputJsonValue, status: 'pending' },
      }),
    async update(id, data) {
      await db.rAAnonAlertSubscription.update({ where: { id }, data });
    },
    find: (id) => db.rAAnonAlertSubscription.findUnique({ where: { id } }),
    async createToken({ brand, tokenHash, subscriptionId, expiresAt }) {
      await db.rAAuthToken.create({ data: { brand, kind: ANON_ALERT_TOKEN_KIND, tokenHash, payload: { subscriptionId }, expiresAt } });
    },
    findToken: (tokenHash) =>
      db.rAAuthToken.findUnique({ where: { tokenHash }, select: { id: true, brand: true, kind: true, payload: true, expiresAt: true, consumedAt: true } }),
    async consumeToken(id, at) {
      await db.rAAuthToken.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: at } });
    },
    async unsubscribeByEmailHash(brand, emailHash, at) {
      const r = await db.rAAnonAlertSubscription.updateMany({ where: { brand, emailHash, status: { in: live } }, data: { status: 'unsubscribed', unsubscribedAt: at } });
      return r.count;
    },
    due: (brand, cut, limit) =>
      db.rAAnonAlertSubscription.findMany({
        where: {
          brand,
          status: 'confirmed',
          OR: [
            { cadence: 'daily', OR: [{ lastSentAt: { lte: cut.daily } }, { lastSentAt: null, confirmedAt: { lte: cut.daily } }] },
            { cadence: 'weekly', OR: [{ lastSentAt: { lte: cut.weekly } }, { lastSentAt: null, confirmedAt: { lte: cut.weekly } }] },
          ],
        },
        orderBy: [{ lastSentAt: { sort: 'asc', nulls: 'first' } }, { confirmedAt: 'asc' }],
        take: limit,
      }),
    async purge(brand, cut) {
      const pending = await db.rAAnonAlertSubscription.deleteMany({ where: { brand, status: 'pending', createdAt: { lt: cut.pendingBefore } } });
      const unsubscribed = await db.rAAnonAlertSubscription.deleteMany({ where: { brand, status: 'unsubscribed', unsubscribedAt: { lt: cut.unsubscribedBefore } } });
      return { pending: pending.count, unsubscribed: unsubscribed.count };
    },
    async newJobs({ market, filters, since, now, take }) {
      const base = basePublicWhere({ market, now, publicBoards: allowedPublicBoards() });
      const where: Prisma.RAJobWhereInput = {
        ...base,
        AND: [...((base.AND as Prisma.RAJobWhereInput[]) ?? []), { firstSeenAt: { gt: since } }, ...filtersWhere(filters)],
      };
      const [rows, total] = await Promise.all([
        db.rAJob.findMany({ where, select: JOB_SELECT, orderBy: { firstSeenAt: 'desc' }, take }),
        db.rAJob.count({ where }),
      ]);
      return { rows, total };
    },
  };
}
