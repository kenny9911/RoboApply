// server/src/features/alerts/repo.ts
//
// The alerts area's narrow, typed data adapter (no `as any`; Prisma is
// imported lazily so importing the area never opens a pool). The service and
// its tests talk to `AlertsRepo` only.

import type { BrandId, Market } from '../../platform/brand/registry.js';
import { coerceFilterSet } from '../search/index.js';
import { jobWhereForFilters } from './jobFilters.js';
import { isLiveAccount } from './preferences.js';
import { resolveTimeZone } from './time.js';

export interface AlertProfileRow {
  id: string;
  userId: string;
  name: string;
  filters: unknown;
  alertInstantMax: number;
  alertDigest: string | null;
  alertLastInstantAt: Date | null;
  alertLastDigestAt: Date | null;
}

/** Who a message goes to. `email` is null when there is no deliverable address. */
export interface Recipient {
  userId: string;
  brand: BrandId;
  email: string | null;
  locale: string | null;
  /** IANA zone, already resolved with the brand fallback. */
  timeZone: string;
  /** Needed for the in-app row (SeekerNotification); null → no in-app copy. */
  seekerProfileId: string | null;
}

export interface JobCardRow {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  locationCity: string | null;
  workModel: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryText: string | null;
  /** TW-03: 面議 (even with a floor) is not disclosed pay; only the posting's text shows. */
  salaryDisclosed: boolean;
}

export interface AlertsRepo {
  /** Saved searches with alerts on whose user belongs to the brand, paged by id. */
  dueProfiles(input: { brandId: BrandId; now: Date; afterId: string | null; limit: number }): Promise<AlertProfileRow[]>;
  recipients(userIds: readonly string[]): Promise<Map<string, Recipient>>;
  /** Public canonical open jobs of the market in the search, first seen after `since`, newest first. */
  candidateJobIds(input: { market: Market; filters: unknown; since: Date; postedSince: Date | null; limit: number }): Promise<{ ids: string[]; truncated: boolean }>;
  /** Of `jobIds`: hidden / Not interested, tracked, or already sent for this search. */
  excludedJobIds(input: { userId: string; searchProfileId: string; jobIds: readonly string[] }): Promise<Set<string>>;
  /** Instant alerts sent since `since` (the user's local midnight), in total and per saved search. */
  instantCountsSince(userId: string, since: Date): Promise<{ total: number; byProfile: Map<string, number> }>;
  /** Optimistic claim: set `alertLastInstantAt = now` only if it still equals `previous`. */
  claimInstant(profileId: string, previous: Date | null, now: Date): Promise<boolean>;
  claimDigest(profileId: string, previous: Date | null, now: Date): Promise<boolean>;
  /** Undo a claim whose send did not happen: back to `previous`, only if it still equals `claimedAt`. */
  releaseInstant(profileId: string, claimedAt: Date, previous: Date | null): Promise<void>;
  releaseDigest(profileId: string, claimedAt: Date, previous: Date | null): Promise<void>;
  createDelivery(input: { userId: string; searchProfileId: string; kind: 'instant' | 'digest_daily' | 'digest_weekly'; jobIds: string[] }): Promise<{ id: string }>;
  jobCards(jobIds: readonly string[]): Promise<JobCardRow[]>;
  /** Applications in "applied" with no change for 10 days (real count). */
  noReplyCount(userId: string, now: Date): Promise<number>;
  /** Exact count of jobs in the search first seen after `since` (re-engagement N). */
  countMatchingJobs(input: { market: Market; filters: unknown; since: Date }): Promise<number>;
}

async function db() {
  return (await import('../../lib/prisma.js')).default;
}

async function expandTaxonomy(): Promise<(ids: readonly string[]) => string[]> {
  const { expandTaxonomyIds } = await import('../jobs/taxonomy/index.js');
  return expandTaxonomyIds;
}

function hasFraudFlags(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

export function deliverableEmail(email: string | null | undefined, placeholder: boolean): string | null {
  if (!email || placeholder) return null;
  const e = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.toLowerCase().endsWith('.invalid')) return null;
  return e;
}

const DAY_MS = 24 * 3_600_000;
const NO_REPLY_DAYS = 10;
/** A sent job is not sent again for the same search within this window. */
const RESEND_WINDOW_MS = 30 * DAY_MS;

export function createPrismaAlertsRepo(): AlertsRepo {
  return {
    async dueProfiles({ brandId, now, afterId, limit }) {
      const p = await db();
      const instantBefore = new Date(now.getTime() - 3 * 3_600_000);
      const digestBefore = new Date(now.getTime() - 20 * 3_600_000);
      const rows = await p.rASearchProfile.findMany({
        where: {
          ...(afterId ? { id: { gt: afterId } } : {}),
          user: { brand: brandId, isActive: true, seekerProfile: { is: { deletedAt: null } } },
          OR: [
            { alertInstantMax: { gt: 0 }, OR: [{ alertLastInstantAt: null }, { alertLastInstantAt: { lt: instantBefore } }] },
            { alertDigest: { in: ['daily', 'weekly'] }, OR: [{ alertLastDigestAt: null }, { alertLastDigestAt: { lt: digestBefore } }] },
          ],
        },
        select: {
          id: true,
          userId: true,
          name: true,
          filters: true,
          alertInstantMax: true,
          alertDigest: true,
          alertLastInstantAt: true,
          alertLastDigestAt: true,
        },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows;
    },

    async recipients(userIds) {
      const out = new Map<string, Recipient>();
      if (!userIds.length) return out;
      const p = await db();
      const rows = await p.user.findMany({
        where: { id: { in: [...new Set(userIds)] } },
        select: {
          id: true,
          brand: true,
          isActive: true,
          email: true,
          emailIsPlaceholder: true,
          seekerProfile: { select: { id: true, locale: true, timezone: true, deletedAt: true } },
        },
      });
      for (const r of rows) {
        // Deactivated and soft-deleted accounts are not recipients at all (no in-app row, no email).
        if (!isLiveAccount(r)) continue;
        const brand: BrandId = r.brand === 'goapply' ? 'goapply' : 'roboapply';
        const sp = r.seekerProfile;
        out.set(r.id, {
          userId: r.id,
          brand,
          email: deliverableEmail(r.email, r.emailIsPlaceholder),
          locale: sp?.locale ?? null,
          timeZone: resolveTimeZone(sp?.timezone, brand),
          seekerProfileId: sp?.id ?? null,
        });
      }
      return out;
    },

    async candidateJobIds({ market, filters, since, postedSince, limit }) {
      const p = await db();
      const fs = coerceFilterSet(filters, { market }).value;
      const where = jobWhereForFilters(fs, market, await expandTaxonomy());
      const rows = await p.rAJob.findMany({
        where: {
          AND: [
            where,
            { firstSeenAt: { gt: since } },
            ...(postedSince ? [{ OR: [{ postedAt: null }, { postedAt: { gte: postedSince } }] }] : []),
          ],
        },
        select: { id: true, fraudFlags: true },
        orderBy: { firstSeenAt: 'desc' },
        take: limit + 1,
      });
      const truncated = rows.length > limit;
      return { ids: rows.slice(0, limit).filter((r) => !hasFraudFlags(r.fraudFlags)).map((r) => r.id), truncated };
    },

    async excludedJobIds({ userId, searchProfileId, jobIds }) {
      const out = new Set<string>();
      if (!jobIds.length) return out;
      const p = await db();
      const ids = [...new Set(jobIds)];
      const [hidden, tracked, sent] = await Promise.all([
        p.rAJobUserState.findMany({ where: { userId, jobId: { in: ids }, hiddenAt: { not: null } }, select: { jobId: true } }),
        p.rATrackerEntry.findMany({ where: { userId, jobId: { in: ids }, deletedAt: null }, select: { jobId: true } }),
        p.rAAlertDelivery.findMany({
          where: { searchProfileId, jobIds: { hasSome: ids }, sentAt: { gte: new Date(Date.now() - RESEND_WINDOW_MS) } },
          select: { jobIds: true },
        }),
      ]);
      for (const r of hidden) out.add(r.jobId);
      for (const r of tracked) if (r.jobId) out.add(r.jobId);
      const wanted = new Set(ids);
      for (const r of sent) for (const j of r.jobIds) if (wanted.has(j)) out.add(j);
      return out;
    },

    async instantCountsSince(userId, since) {
      const p = await db();
      const rows = await p.rAAlertDelivery.findMany({
        where: { userId, kind: 'instant', sentAt: { gte: since } },
        select: { searchProfileId: true },
      });
      const byProfile = new Map<string, number>();
      for (const r of rows) byProfile.set(r.searchProfileId, (byProfile.get(r.searchProfileId) ?? 0) + 1);
      return { total: rows.length, byProfile };
    },

    async claimInstant(profileId, previous, now) {
      const p = await db();
      const r = await p.rASearchProfile.updateMany({ where: { id: profileId, alertLastInstantAt: previous }, data: { alertLastInstantAt: now } });
      return r.count === 1;
    },

    async claimDigest(profileId, previous, now) {
      const p = await db();
      const r = await p.rASearchProfile.updateMany({ where: { id: profileId, alertLastDigestAt: previous }, data: { alertLastDigestAt: now } });
      return r.count === 1;
    },

    async releaseInstant(profileId, claimedAt, previous) {
      const p = await db();
      await p.rASearchProfile.updateMany({ where: { id: profileId, alertLastInstantAt: claimedAt }, data: { alertLastInstantAt: previous } });
    },

    async releaseDigest(profileId, claimedAt, previous) {
      const p = await db();
      await p.rASearchProfile.updateMany({ where: { id: profileId, alertLastDigestAt: claimedAt }, data: { alertLastDigestAt: previous } });
    },

    async createDelivery({ userId, searchProfileId, kind, jobIds }) {
      const p = await db();
      const row = await p.rAAlertDelivery.create({ data: { userId, searchProfileId, kind, jobIds }, select: { id: true } });
      return row;
    },

    async jobCards(jobIds) {
      if (!jobIds.length) return [];
      const p = await db();
      return p.rAJob.findMany({
        where: { id: { in: [...jobIds] } },
        select: {
          id: true,
          title: true,
          companyName: true,
          location: true,
          locationCity: true,
          workModel: true,
          salaryMin: true,
          salaryMax: true,
          salaryCurrency: true,
          salaryPeriod: true,
          salaryText: true,
          salaryDisclosed: true,
        },
      });
    },

    async noReplyCount(userId, now) {
      const p = await db();
      const before = new Date(now.getTime() - NO_REPLY_DAYS * DAY_MS);
      return p.rATrackerEntry.count({
        where: { userId, deletedAt: null, status: 'applied', dateApplied: { lte: before }, updatedAt: { lte: before } },
      });
    },

    async countMatchingJobs({ market, filters, since }) {
      const p = await db();
      const fs = coerceFilterSet(filters, { market }).value;
      const where = jobWhereForFilters(fs, market, await expandTaxonomy());
      const { Prisma } = await import('../../generated/prisma/client.js');
      // Flagged jobs never count (same rule as the candidate list).
      const noFraud = { OR: [{ fraudFlags: { equals: Prisma.AnyNull } }, { fraudFlags: { equals: [] } }] };
      return p.rAJob.count({ where: { AND: [where, noFraud, { firstSeenAt: { gt: since } }] } });
    },
  };
}
