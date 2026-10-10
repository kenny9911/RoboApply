// @vitest-environment node
//
// WP-64 / D3: posted pay for the role comes from our index only, in the
// offer's currency, published only at N ≥ MIN_SAMPLE.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { MIN_SAMPLE } from '../../platform/http.js';
import { createPrismaPostedPay, postedPayWhere, roleScopeFor, summarizePostedPay, type PostedPayDb, type PostedPayRow } from './postedRange.js';

const AS_OF = new Date('2026-10-10T00:00:00.000Z');
const row = (min: number | null, max: number | null, currency = 'USD', period = 'year'): PostedPayRow => ({ salaryMin: min, salaryMax: max, salaryCurrency: currency, salaryPeriod: period });
const many = (n: number, f: (i: number) => PostedPayRow) => Array.from({ length: n }, (_v, i) => f(i));

describe('summarizePostedPay', () => {
  it('suppresses the range below MIN_SAMPLE (counts only)', () => {
    const out = summarizePostedPay(many(MIN_SAMPLE - 1, (i) => row(100000 + i, 120000 + i)), { currency: 'USD', preferredPeriod: 'year', totalCount: 50, asOf: AS_OF });
    expect(out).toEqual({ postedRange: null, totalCount: 50, listedCount: MIN_SAMPLE - 1 });
  });

  it('publishes p25/median/p75 of the midpoints as Sourced index values with N', () => {
    const rows = many(21, (i) => row(90000 + i * 1000, 110000 + i * 1000)); // midpoints 100000..120000
    const out = summarizePostedPay(rows, { currency: 'USD', preferredPeriod: 'year', totalCount: 40, asOf: AS_OF });
    expect(out.listedCount).toBe(21);
    expect(out.postedRange).toMatchObject({ currency: 'USD', period: 'year', sampleSize: 21, source: 'index', asOf: AS_OF.toISOString() });
    expect(out.postedRange!.low).toEqual({ value: 105000, source: 'index', sampleSize: 21, asOf: AS_OF.toISOString(), method: 'computed' });
    expect(out.postedRange!.median.value).toBe(110000);
    expect(out.postedRange!.high.value).toBe(115000);
  });

  it('only counts rows in the offer currency with a period and a positive bound; one-sided ranges use the bound', () => {
    const rows = [
      ...many(20, () => row(null, 100000)),
      ...many(30, () => row(100000, 120000, 'EUR')),
      ...many(30, () => ({ ...row(100000, 120000), salaryPeriod: null })),
      ...many(30, () => row(0, 0)),
    ];
    const out = summarizePostedPay(rows, { currency: 'USD', preferredPeriod: 'year', totalCount: 110, asOf: AS_OF });
    expect(out.listedCount).toBe(20);
    expect(out.postedRange!.median.value).toBe(100000);
  });

  it("uses the offer's period when it meets the rule, else the largest group", () => {
    const rows = [...many(25, () => row(8000, 10000, 'USD', 'month')), ...many(30, () => row(100000, 120000))];
    expect(summarizePostedPay(rows, { currency: 'USD', preferredPeriod: 'month', totalCount: 55, asOf: AS_OF }).postedRange!.period).toBe('month');
    const few = [...many(5, () => row(8000, 10000, 'USD', 'month')), ...many(30, () => row(100000, 120000))];
    expect(summarizePostedPay(few, { currency: 'USD', preferredPeriod: 'month', totalCount: 35, asOf: AS_OF }).postedRange!.period).toBe('year');
  });
});

describe('postedPayWhere', () => {
  it('applies the public-aggregate filter, market, role and place', () => {
    const w = postedPayWhere({ market: 'intl', taxonomyId: 'data_analyst', title: null, country: 'US', city: 'Austin', now: AS_OF }) as { AND: Array<Record<string, unknown>> };
    expect(w.AND[0]).toEqual({ market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null });
    expect(w.AND).toContainEqual({ taxonomyIds: { has: 'data_analyst' } });
    expect(w.AND).toContainEqual({ locationCountry: 'US' });
    expect(w.AND).toContainEqual({ locationCity: { equals: 'Austin', mode: 'insensitive' } });
    expect(JSON.stringify(w)).not.toContain('fraudFlags');
  });

  it('falls back to the title and excludes fraud-flagged postings on GoApply', () => {
    const w = postedPayWhere({ market: 'cn', taxonomyId: null, title: '数据分析师', country: null, city: null, now: AS_OF }) as { AND: unknown[] };
    expect(w.AND).toContainEqual({ title: { contains: '数据分析师', mode: 'insensitive' } });
    expect(JSON.stringify(w)).toContain('fraudFlags');
  });
});

describe('roleScopeFor', () => {
  it('prefers a known primary taxonomy node, else a specific tagged node, else the title', () => {
    expect(roleScopeFor({ title: 'X', taxonomyIds: [], primaryTaxonomyId: 'backend_engineer', locationCountry: 'us', locationCity: ' Austin ' }, null)).toEqual({
      title: null,
      taxonomyId: 'backend_engineer',
      country: 'US',
      city: 'Austin',
    });
    expect(roleScopeFor({ title: 'X', taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'], primaryTaxonomyId: null, locationCountry: null, locationCity: null }, null).taxonomyId).toBe(
      'backend_engineer',
    );
    const free = roleScopeFor(null, 'Zyxwv Specialist');
    expect(free).toEqual({ title: 'Zyxwv Specialist', taxonomyId: null, country: null, city: null });
    expect(roleScopeFor(null, null)).toEqual({ title: null, taxonomyId: null, country: null, city: null });
  });
});

describe('createPrismaPostedPay', () => {
  it('reads listed pay in the currency and counts all matching postings', async () => {
    const findMany = vi.fn(async () => many(20, () => row(100, 200)));
    const count = vi.fn(async () => 33);
    const findFirst = vi.fn(async () => ({ title: 'Data Analyst', taxonomyIds: [], primaryTaxonomyId: null, locationCountry: 'US', locationCity: null }));
    const db = { rAJob: { findMany, count, findFirst } } as unknown as PostedPayDb;
    const src = createPrismaPostedPay(async () => db);
    expect(await src.jobScope('job_1')).toMatchObject({ title: 'Data Analyst' });
    const out = await src.summary({ market: 'intl', currency: 'USD', preferredPeriod: 'year', title: 'Data Analyst', taxonomyId: null, country: 'US', city: null, now: AS_OF });
    expect(out).toMatchObject({ totalCount: 33, listedCount: 20 });
    const listedWhere = (findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(JSON.stringify(listedWhere)).toContain('"salaryCurrency":"USD"');
    const countWhere = (count.mock.calls[0] as unknown as [{ where: unknown }])[0].where;
    expect(JSON.stringify(countWhere)).not.toContain('salaryCurrency');
  });
});
