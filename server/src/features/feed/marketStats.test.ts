// @vitest-environment node
//
// REQ-50-01 / REQ-64-01: `marketStats.salary` — posted pay from our own index
// only, over the public-aggregate rows (TASK_PLAN §2.2), published only at
// N ≥ MIN_SAMPLE; on GoApply the figures show by default (D5) and nothing is
// shown while CN_RECRUITMENT_INFO_MODE is set to off.
// A fake database evaluates the `where`: no Prisma, no network.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { MIN_SAMPLE } from '../../platform/http.js';
import { cnPostingsWhere } from '../cn/jobs/index.js';
import { cnAggregateWhere, createMarketStats, salaryWhere, summarizePay, type MarketStatsDb, type PayRow } from './marketStats.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');
type Row = Record<string, unknown>;

/** The Prisma `where` operators the seam uses; anything else throws. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as Row[]).every((w) => matches(row, w))) return false;
    } else if (k === 'OR') {
      if (!(v as Row[]).some((w) => matches(row, w))) return false;
    } else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Row;
      const cell = row[k];
      for (const key of Object.keys(op)) {
        if (key === 'mode') continue;
        if (key === 'in') {
          if (!(op.in as unknown[]).includes(cell)) return false;
        } else if (key === 'gte') {
          if (!(cell instanceof Date && cell.getTime() >= (op.gte as Date).getTime())) return false;
        } else if (key === 'gt') {
          if (!(typeof cell === 'number' && cell > (op.gt as number))) return false;
        } else if (key === 'has') {
          if (!(Array.isArray(cell) && cell.includes(op.has))) return false;
        } else if (key === 'contains') {
          if (!(typeof cell === 'string' && cell.toLowerCase().includes(String(op.contains).toLowerCase()))) return false;
        } else if (key === 'equals') {
          const eq = op.equals;
          if (typeof eq === 'string') {
            if (!(typeof cell === 'string' && cell.toLowerCase() === eq.toLowerCase())) return false;
          } else if (Array.isArray(eq)) {
            if (!(Array.isArray(cell) && cell.length === 0)) return false;
          } else if (cell != null) return false; // Prisma.DbNull / JsonNull sentinels match a null cell
        } else {
          throw new Error(`fake where: unsupported operator ${key} on ${k}`);
        }
      }
    } else if ((row[k] ?? null) !== v) {
      return false;
    }
  }
  return true;
}

function fakeDb(rows: Row[]): MarketStatsDb {
  const pick = (r: Row, select: Record<string, true>) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null]));
  return {
    rAJob: {
      findMany: async ({ where, select, take }) => rows.filter((r) => matches(r, where as Row)).slice(0, take).map((r) => pick(r, select)) as never,
      count: async ({ where }) => rows.filter((r) => matches(r, where as Row)).length,
      findFirst: async ({ where, select }) => {
        const r = rows.find((x) => matches(x, where as Row));
        return r ? (pick(r, select) as never) : null;
      },
    },
  };
}

const job = (over: Row): Row => ({
  market: 'intl',
  visibility: 'public',
  isCanonical: true,
  archivedAt: null,
  closedAt: null,
  postedAt: new Date('2026-09-20T00:00:00Z'),
  title: 'Data Analyst',
  taxonomyIds: ['data_analytics', 'data_analyst'],
  primaryTaxonomyId: 'data_analyst',
  locationCountry: 'US',
  locationCity: 'Austin',
  fraudFlags: null,
  salaryMin: 90_000,
  salaryMax: 110_000,
  salaryCurrency: 'USD',
  salaryPeriod: 'year',
  ...over,
});
const many = (n: number, f: (i: number) => Row) => Array.from({ length: n }, (_v, i) => f(i));
const pay = (min: number | null, max: number | null, currency = 'USD', period = 'year'): PayRow => ({ salaryMin: min, salaryMax: max, salaryCurrency: currency, salaryPeriod: period });

describe('marketStats.salary', () => {
  it('n < MIN_SAMPLE is suppressed: counts only, no median or quartiles', async () => {
    const stats = createMarketStats({ db: async () => fakeDb(many(MIN_SAMPLE - 1, (i) => job({ id: `j${i}` }))), env: {} });
    const out = await stats.salary({ market: 'intl', taxonomyId: 'data_analyst', now: NOW });
    expect(out).toMatchObject({ totalCount: MIN_SAMPLE - 1, listedCount: MIN_SAMPLE - 1, median: null, p25: null, p75: null, minSample: MIN_SAMPLE });
  });

  it('n ≥ MIN_SAMPLE publishes Sourced quartiles of the midpoints with the sample size and date', async () => {
    const rows = many(21, (i) => job({ id: `j${i}`, salaryMin: 90_000 + i * 1000, salaryMax: 110_000 + i * 1000 })); // midpoints 100000..120000
    const out = await createMarketStats({ db: async () => fakeDb(rows), env: {} }).salary({ market: 'intl', taxonomyId: 'data_analyst', country: 'us', city: ' austin ', now: NOW });
    expect(out.median).toEqual({ value: 110_000, source: 'index', sampleSize: 21, asOf: NOW.toISOString(), method: 'computed' });
    expect(out.p25?.value).toBe(105_000);
    expect(out.p75?.value).toBe(115_000);
    expect(out).toMatchObject({ totalCount: 21, listedCount: 21, currency: 'USD', period: 'year' });
    expect(out.scope).toEqual({ taxonomyId: 'data_analyst', title: null, country: 'us', city: ' austin ' });
  });

  it('counts only the public-aggregate rows: private imports, duplicates, archived, closed, other-market and year-old postings never count', async () => {
    const good = many(MIN_SAMPLE, (i) => job({ id: `g${i}` }));
    const noise = [
      job({ id: 'private', visibility: 'private', ownerUserId: 'u1', salaryMin: 9_000_000, salaryMax: 9_000_000 }),
      job({ id: 'dup', isCanonical: false, salaryMin: 9_000_000, salaryMax: 9_000_000 }),
      job({ id: 'archived', archivedAt: NOW, salaryMin: 9_000_000, salaryMax: 9_000_000 }),
      job({ id: 'closed', closedAt: NOW, salaryMin: 9_000_000, salaryMax: 9_000_000 }),
      job({ id: 'cn', market: 'cn', salaryMin: 9_000_000, salaryMax: 9_000_000 }),
      job({ id: 'old', postedAt: new Date('2025-09-01T00:00:00Z'), salaryMin: 9_000_000, salaryMax: 9_000_000 }),
      job({ id: 'other_role', taxonomyIds: ['sales'], salaryMin: 9_000_000, salaryMax: 9_000_000 }),
    ];
    const out = await createMarketStats({ db: async () => fakeDb([...good, ...noise]), env: {} }).salary({ market: 'intl', taxonomyId: 'data_analyst', now: NOW });
    expect(out.totalCount).toBe(MIN_SAMPLE);
    expect(out.median?.value).toBe(100_000);
    expect(out.median?.sampleSize).toBe(MIN_SAMPLE);
  });

  it('postings without pay count toward the total but not the sample; a title scopes when no taxonomy id is given', async () => {
    const rows = [...many(MIN_SAMPLE, (i) => job({ id: `p${i}` })), ...many(5, (i) => job({ id: `n${i}`, salaryMin: null, salaryMax: null })), job({ id: 'x', title: 'Chef' })];
    const out = await createMarketStats({ db: async () => fakeDb(rows), env: {} }).salary({ market: 'intl', title: ' data analyst ', now: NOW });
    expect(out).toMatchObject({ totalCount: MIN_SAMPLE + 5, listedCount: MIN_SAMPLE });
    expect(out.scope).toEqual({ taxonomyId: null, title: 'data analyst', country: null, city: null });
  });

  it('defaults the market to the current brand', async () => {
    const rows = many(MIN_SAMPLE, (i) => job({ id: `c${i}`, market: 'cn', salaryCurrency: 'CNY', salaryPeriod: 'month' }));
    const stats = createMarketStats({ db: async () => fakeDb(rows), env: { CN_RECRUITMENT_INFO_MODE: 'licensed' }, market: () => 'cn' });
    expect((await stats.salary({ taxonomyId: 'data_analyst', now: NOW })).listedCount).toBe(MIN_SAMPLE);
  });
});

describe('marketStats on GoApply (recruitment-info mode; on by default, D5)', () => {
  const rows = many(MIN_SAMPLE + 2, (i) => job({ id: `c${i}`, market: 'cn', salaryMin: 15_000, salaryMax: 20_000, salaryCurrency: 'CNY', salaryPeriod: 'month' }));
  const OFF = { CN_RECRUITMENT_INFO_MODE: 'off' };

  it('mode off shows nothing: no count and no figure, even with enough postings in the index', async () => {
    const out = await createMarketStats({ db: async () => fakeDb(rows), env: OFF }).salary({ market: 'cn', taxonomyId: 'data_analyst', now: NOW });
    expect(out).toMatchObject({ totalCount: 0, listedCount: 0, median: null, p25: null, p75: null, currency: null, period: null });
    const sample = await createMarketStats({ db: async () => fakeDb(rows), env: OFF }).salarySample({ market: 'cn', taxonomyId: 'data_analyst', currency: 'CNY', now: NOW });
    expect(sample).toMatchObject({ rows: [], totalCount: 0 });
  });

  it('default (nothing set): the same rows give the figures', async () => {
    const out = await createMarketStats({ db: async () => fakeDb(rows), env: {} }).salary({ market: 'cn', taxonomyId: 'data_analyst', now: NOW });
    expect(out).toMatchObject({ totalCount: MIN_SAMPLE + 2, listedCount: MIN_SAMPLE + 2, currency: 'CNY', period: 'month' });
    expect(out.median?.value).toBe(17_500);
    const sample = await createMarketStats({ db: async () => fakeDb(rows), env: {} }).salarySample({ market: 'cn', taxonomyId: 'data_analyst', currency: 'CNY', now: NOW });
    expect(sample.totalCount).toBe(MIN_SAMPLE + 2);
  });

  it('control: with postings allowed the same rows give the figures; fraud-flagged postings never count', async () => {
    const env = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };
    const flagged = job({ id: 'flag', market: 'cn', salaryCurrency: 'CNY', salaryPeriod: 'month', fraudFlags: [{ rule: 'training_loan', evidence: '培训贷', at: '2026-10-01' }] });
    const out = await createMarketStats({ db: async () => fakeDb([...rows, flagged]), env }).salary({ market: 'cn', taxonomyId: 'data_analyst', now: NOW });
    expect(out).toMatchObject({ totalCount: MIN_SAMPLE + 2, listedCount: MIN_SAMPLE + 2, currency: 'CNY', period: 'month' });
    expect(out.median?.value).toBe(17_500);
  });

  it('the recruitment-info fragment is exactly cn/jobs cnPostingsWhere for an aggregate (no viewer), in every mode', () => {
    for (const mode of [undefined, 'off', 'partner_deeplink', 'licensed', 'nonsense']) {
      const env = mode ? { CN_RECRUITMENT_INFO_MODE: mode } : {};
      expect(cnAggregateWhere(env), String(mode)).toEqual(cnPostingsWhere(null, env));
    }
  });

  it('the filter itself: mode off ANDs a predicate that matches no row; RoboApply is not affected by the mode', () => {
    const q = { market: 'cn' as const, title: '数据分析师', now: NOW };
    expect((salaryWhere(q, { CN_RECRUITMENT_INFO_MODE: 'off' }) as { AND: unknown[] }).AND).toContainEqual({ OR: [{ id: { in: [] } }] });
    expect((salaryWhere(q, { CN_RECRUITMENT_INFO_MODE: 'licensed' }) as { AND: unknown[] }).AND).toContainEqual({ OR: [{ visibility: 'public' }] });
    // Nothing set: the public postings (D5 default).
    expect((salaryWhere(q, {}) as { AND: unknown[] }).AND).toContainEqual({ OR: [{ visibility: 'public' }] });
    const intl = salaryWhere({ ...q, market: 'intl' }, {}) as { AND: Array<Record<string, unknown>> };
    expect(intl.AND[0]).toEqual({ market: 'intl', visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null });
    expect(JSON.stringify(intl)).not.toContain('fraudFlags');
  });
});

describe('salarySample and jobRole (the offer benchmark)', () => {
  it('keeps only rows that list pay in the asked currency; the total still counts every matching posting', async () => {
    const rows = [...many(3, (i) => job({ id: `u${i}` })), ...many(2, (i) => job({ id: `e${i}`, salaryCurrency: 'EUR' })), job({ id: 'none', salaryMin: null, salaryMax: null })];
    const sample = await createMarketStats({ db: async () => fakeDb(rows), env: {} }).salarySample({ market: 'intl', taxonomyId: 'data_analyst', currency: 'USD', now: NOW });
    expect(sample.rows).toHaveLength(3);
    expect(sample.totalCount).toBe(6);
    expect(sample.asOf).toEqual(NOW);
    expect(Object.keys(sample.rows[0]!).sort()).toEqual(['salaryCurrency', 'salaryMax', 'salaryMin', 'salaryPeriod']);
  });

  it('jobRole returns the role and place fields, or null for a missing job', async () => {
    const stats = createMarketStats({ db: async () => fakeDb([job({ id: 'j1' })]), env: {} });
    expect(await stats.jobRole('j1')).toEqual({ title: 'Data Analyst', taxonomyIds: ['data_analytics', 'data_analyst'], primaryTaxonomyId: 'data_analyst', locationCountry: 'US', locationCity: 'Austin' });
    expect(await stats.jobRole('missing')).toBeNull();
  });
});

describe('summarizePay', () => {
  const meta = { totalCount: 40, asOf: NOW, scope: { taxonomyId: null, title: null, country: null, city: null } };

  it('uses the largest currency+period group; one-sided ranges use the bound; rows with no figure are skipped', () => {
    const rows = [...Array.from({ length: 22 }, () => pay(null, 100_000)), ...Array.from({ length: 5 }, () => pay(8000, 9000, 'USD', 'month')), pay(0, 0), pay(100, 200, 'USD', '')];
    const out = summarizePay(rows, meta);
    expect(out).toMatchObject({ listedCount: 22, currency: 'USD', period: 'year' });
    expect(out.median?.value).toBe(100_000);
  });

  it('an empty sample has no currency and no figure', () => {
    expect(summarizePay([], meta)).toMatchObject({ listedCount: 0, currency: null, period: null, median: null });
  });
});
