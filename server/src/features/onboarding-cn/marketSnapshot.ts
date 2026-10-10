// server/src/features/onboarding-cn/marketSnapshot.ts — G4 "现在开放的机会" and the G7 counts.
//
// Counts come from our own GoApply index only (GoHire bank, the curated campus
// calendar and other public sources the inventory pipeline stores), never from
// a third party and never estimated (D3):
//   - jobCount: RAJob rows with market='cn', visibility='public', isCanonical,
//     archivedAt IS NULL, not closed, not fraud-flagged, seen in the last WINDOW_DAYS, matching
//     the chosen roles (taxonomy id or title) and cities. Users' imported jobs
//     are private and never count.
//   - campusOpenCount: published RACampusEvent rows whose 网申 window is open
//     now, for the chosen 届别 and cities.
//   - pay: only when at least MIN_SAMPLE (20) of those postings state monthly
//     CNY pay; the median of each range's midpoint, with N ("按发布薪资统计").

import { Prisma } from '../../generated/prisma/client.js';
import prisma from '../../lib/prisma.js';
import { MIN_SAMPLE } from '../../platform/http.js';
import { CN_ANY_CITY, type CnMarketSnapshotQuery, type CnMarketSnapshotResponse } from './contract.js';
import { median, monthlyMidpointYuan, quantile } from './salary.js';

export const SNAPSHOT_WINDOW_DAYS = 30;
/** Upper bound on pay rows read for a median (the sample size is reported). */
export const SNAPSHOT_PAY_ROWS = 2000;

export type SnapshotDb = Pick<typeof prisma, 'rAJob' | 'rACampusEvent'>;

/**
 * Not flagged as fraudulent (R-17): `RAJob.fraudFlags` is a JSON array of
 * `{ rule, evidence, at }` (WP-17 / WP-41); null or [] = no flag. A flagged
 * posting never counts toward 在招职位 or the pay figures.
 */
export const NOT_FRAUD_FLAGGED: Prisma.RAJobWhereInput = {
  OR: [{ fraudFlags: { equals: Prisma.DbNull } }, { fraudFlags: { equals: Prisma.JsonNull } }, { fraudFlags: { equals: [] } }],
};

/** The shared D3 predicate plus the user's roles and cities. Exported for tests. */
export function cnJobWhere(q: CnMarketSnapshotQuery, now: Date): Prisma.RAJobWhereInput {
  const since = new Date(now.getTime() - SNAPSHOT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const and: Prisma.RAJobWhereInput[] = [NOT_FRAUD_FLAGGED];
  const roleOr: Prisma.RAJobWhereInput[] = [];
  if (q.taxonomyIds?.length) roleOr.push({ taxonomyIds: { hasSome: q.taxonomyIds } });
  for (const label of q.roles ?? []) roleOr.push({ title: { contains: label, mode: 'insensitive' } });
  if (roleOr.length) and.push({ OR: roleOr });
  const cities = (q.cities ?? []).filter((c) => c !== CN_ANY_CITY);
  if (cities.length) and.push({ OR: [{ locationCity: { in: cities } }, ...cities.map((c) => ({ location: { contains: c } }))] });
  return {
    market: 'cn',
    visibility: 'public',
    isCanonical: true,
    archivedAt: null,
    closedAt: null,
    lastSeenAt: { gte: since },
    AND: and,
  };
}

export function cnCampusWhere(q: CnMarketSnapshotQuery, now: Date): Prisma.RACampusEventWhereInput {
  const cities = (q.cities ?? []).filter((c) => c !== CN_ANY_CITY);
  return {
    market: 'cn',
    status: 'published',
    applyClosesAt: { gte: now },
    ...(q.class ? { graduationClass: `${q.class}届` } : {}),
    AND: [
      { OR: [{ applyOpensAt: null }, { applyOpensAt: { lte: now } }] },
      // A programme that names no city is open to every city.
      ...(cities.length ? [{ OR: [{ cities: { isEmpty: true } }, { cities: { hasSome: cities } }] }] : []),
    ],
  };
}

export async function cnMarketSnapshot(q: CnMarketSnapshotQuery, deps: { db?: SnapshotDb; now?: Date } = {}): Promise<CnMarketSnapshotResponse> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? new Date();
  const asOf = now.toISOString();
  const where = cnJobWhere(q, now);
  const payWhere: Prisma.RAJobWhereInput = {
    AND: [where, { salaryDisclosed: true, salaryCurrency: 'CNY', salaryPeriod: 'month', OR: [{ salaryMin: { gt: 0 } }, { salaryMax: { gt: 0 } }] }],
  };
  const [jobCount, campusOpenCount, listedCount] = await Promise.all([
    db.rAJob.count({ where }),
    db.rACampusEvent.count({ where: cnCampusWhere(q, now) }),
    db.rAJob.count({ where: payWhere }),
  ]);

  let pay: CnMarketSnapshotResponse['pay'] = null;
  if (listedCount >= MIN_SAMPLE) {
    const rows = await db.rAJob.findMany({ where: payWhere, select: { salaryMin: true, salaryMax: true }, orderBy: { lastSeenAt: 'desc' }, take: SNAPSHOT_PAY_ROWS });
    const mids = rows.map((r) => monthlyMidpointYuan(r.salaryMin, r.salaryMax)).filter((v): v is number => v !== null);
    const m = median(mids);
    if (m !== null && mids.length >= MIN_SAMPLE) {
      pay = {
        medianMonthly: Math.round(m),
        p25Monthly: Math.round(quantile(mids, 0.25)!),
        p75Monthly: Math.round(quantile(mids, 0.75)!),
        listedCount, sampleSize: mids.length, currency: 'CNY', period: 'month', source: 'index', asOf };
    }
  }

  return {
    jobCount: { value: jobCount, source: 'index', asOf },
    campusOpenCount: { value: campusOpenCount, source: 'campus_calendar', asOf },
    pay,
    windowDays: SNAPSHOT_WINDOW_DAYS,
  };
}
