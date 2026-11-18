// @vitest-environment node
//
// The pay check (GET /feed/pay-check; payCheck.ts): what live, recent posts in
// the reader's market state about pay for a title. Pure parts (the quartiles
// per currency, the sample rule, which rows state pay, the place, the one
// statement it runs) and the reader over a fake database that records the
// statement (no Prisma connection, no network).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError, MIN_SAMPLE } from '../../platform/http.js';
import { normalizeSql } from '../../test/sqlSnapshot.js';
import { PAY_CHECK_ROW_CAP, PAY_CHECK_WINDOW_DAYS, PayCheckQuerySchema } from './contract.js';
import { createPayCheck, payCheckSql, resolvePlace, statedAnnualPay, summarizePayCheck, titleMatchOf, type PayCheckDb, type PayCheckRow } from './payCheck.js';
import { CREDIT_LINE_BOARDS } from './sourceLine.js';
import { predicateFor } from './sql.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const SINCE = new Date(NOW.getTime() - PAY_CHECK_WINDOW_DAYS * 86_400_000);

/** A post that states a yearly range (annualized fields as the normalizer writes them). */
function payRow(annualMin: number | null, annualMax: number | null, over: Partial<PayCheckRow> = {}): PayCheckRow {
  return {
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    salaryMin: annualMin,
    salaryMax: annualMax,
    salaryMonths: null,
    salaryAnnualMin: annualMin,
    salaryAnnualMax: annualMax,
    salaryDisclosed: true,
    ...over,
  };
}

/** A post that states no pay. */
const noPay = (): PayCheckRow => ({
  salaryCurrency: null,
  salaryPeriod: null,
  salaryMin: null,
  salaryMax: null,
  salaryMonths: null,
  salaryAnnualMin: null,
  salaryAnnualMax: null,
  salaryDisclosed: false,
});

/** `n` USD posts whose yearly midpoints are start, start + step, … */
function usdSeries(n: number, start = 100_000, step = 5_000): PayCheckRow[] {
  return Array.from({ length: n }, (_, i) => payRow(start + i * step - 10_000, start + i * step + 10_000));
}

const show = (sql: Prisma.Sql) => normalizeSql(sql.text);

describe('which posts state pay (statedAnnualPay)', () => {
  it('the middle of the yearly range, or the one end the post states; a reversed range is read the right way round', () => {
    expect(statedAnnualPay(payRow(90_000, 110_000))).toEqual({ currency: 'USD', value: 100_000 });
    expect(statedAnnualPay(payRow(150_000, null))).toEqual({ currency: 'USD', value: 150_000 });
    expect(statedAnnualPay(payRow(null, 80_000))).toEqual({ currency: 'USD', value: 80_000 });
    expect(statedAnnualPay(payRow(110_000, 90_000))).toEqual({ currency: 'USD', value: 100_000 });
    // Hourly pay, stored as stated and annualized by the normalizer (× 2080).
    expect(statedAnnualPay(payRow(null, null, { salaryPeriod: 'hour', salaryMin: 40, salaryMax: 50, salaryAnnualMin: 83_200, salaryAnnualMax: 104_000 }))).toEqual({ currency: 'USD', value: 93_600 });
  });

  it('never: pay not disclosed (面議), no currency or not a currency code, no yearly figure, or figures that cannot be pay', () => {
    expect(statedAnnualPay(noPay())).toBeNull();
    expect(statedAnnualPay(payRow(40_000, 50_000, { salaryDisclosed: false, salaryCurrency: 'TWD' }))).toBeNull();
    expect(statedAnnualPay(payRow(90_000, 110_000, { salaryCurrency: null }))).toBeNull();
    expect(statedAnnualPay(payRow(90_000, 110_000, { salaryCurrency: '$' }))).toBeNull();
    // A stated monthly figure with no period: no yearly figure was written, so it is not compared (periods never mix).
    expect(statedAnnualPay(payRow(null, null, { salaryPeriod: null, salaryMin: 9_000, salaryMax: 12_000 }))).toBeNull();
    expect(statedAnnualPay(payRow(0, 0))).toBeNull();
    // "$60,000K–$90,000K an hour": a posting typo, not pay (the readers' payPlausible rule for stored rows).
    expect(statedAnnualPay(payRow(null, null, { salaryPeriod: 'hour', salaryMin: 60_000_000, salaryMax: 90_000_000, salaryAnnualMin: 2_000_000_000, salaryAnnualMax: 2_100_000_000 }))).toBeNull();
    // A lower-case code is still the currency.
    expect(statedAnnualPay(payRow(90_000, 110_000, { salaryCurrency: 'eur' }))).toEqual({ currency: 'EUR', value: 100_000 });
  });
});

describe('summarizePayCheck: quartiles per currency, the sample rule', () => {
  it('the 25th, 50th and 75th percentiles of the yearly midpoints, each sourced with its sample', () => {
    // Midpoints 100k, 105k, … 195k (20 posts).
    const s = summarizePayCheck(usdSeries(20), { asOf: NOW, capped: false });
    expect(s.status).toBe('ok');
    expect(s.matchedCount).toBe(20);
    expect(s.withPayCount).toBe(20);
    expect(s.minSample).toBe(MIN_SAMPLE);
    expect(s.currencies).toHaveLength(1);
    const usd = s.currencies[0]!;
    expect(usd).toMatchObject({ currency: 'USD', sampleSize: 20 });
    // Linear interpolation: positions 4.75, 9.5 and 14.25 of the sorted list.
    expect(usd.p25).toEqual({ value: 123_750, source: 'index', sampleSize: 20, asOf: NOW.toISOString(), method: 'computed' });
    expect(usd.median?.value).toBe(147_500);
    expect(usd.p75?.value).toBe(171_250);
  });

  it('order does not matter, and a single repeated figure is its own band', () => {
    const shuffled = [...usdSeries(20)].reverse();
    expect(summarizePayCheck(shuffled, { asOf: NOW, capped: false }).currencies[0]!.median?.value).toBe(147_500);
    const flat = summarizePayCheck(Array.from({ length: 20 }, () => payRow(80_000, 80_000)), { asOf: NOW, capped: false }).currencies[0]!;
    expect([flat.p25?.value, flat.median?.value, flat.p75?.value]).toEqual([80_000, 80_000, 80_000]);
  });

  it('currencies are kept apart: each has its own sample, figures and count; the largest sample first', () => {
    const rows = [
      ...usdSeries(20),
      // Euro posts with very different figures: they never move the dollar quartiles.
      ...Array.from({ length: 22 }, (_, i) => payRow(40_000 + i * 1_000, 50_000 + i * 1_000, { salaryCurrency: 'EUR' })),
      ...Array.from({ length: 5 }, () => payRow(1_500_000, 2_000_000, { salaryCurrency: 'INR' })),
      noPay(),
      noPay(),
    ];
    const s = summarizePayCheck(rows, { asOf: NOW, capped: false });
    expect(s.matchedCount).toBe(49);
    expect(s.withPayCount).toBe(47);
    expect(s.currencies.map((c) => [c.currency, c.sampleSize])).toEqual([
      ['EUR', 22],
      ['USD', 20],
      ['INR', 5],
    ]);
    expect(s.currencies[1]!.median?.value).toBe(147_500);
    expect(s.currencies[0]!.median?.value).toBe(55_500);
    // Below the sample rule: the count and no figure.
    expect(s.currencies[2]).toEqual({ currency: 'INR', sampleSize: 5, p25: null, median: null, p75: null });
  });

  it(`below ${MIN_SAMPLE} posts with pay in every currency: not enough, counts only (no figure anywhere)`, () => {
    const s = summarizePayCheck([...usdSeries(MIN_SAMPLE - 1), noPay(), noPay(), noPay()], { asOf: NOW, capped: false });
    expect(s.status).toBe('not_enough');
    expect(s.matchedCount).toBe(MIN_SAMPLE + 2);
    expect(s.withPayCount).toBe(MIN_SAMPLE - 1);
    expect(s.currencies).toEqual([{ currency: 'USD', sampleSize: MIN_SAMPLE - 1, p25: null, median: null, p75: null }]);
    // One more post with pay meets the rule.
    expect(summarizePayCheck(usdSeries(MIN_SAMPLE), { asOf: NOW, capped: false }).status).toBe('ok');
  });

  it('nothing matched, and nothing that states pay: zero counts, no currency', () => {
    expect(summarizePayCheck([], { asOf: NOW, capped: false })).toEqual({ status: 'not_enough', matchedCount: 0, withPayCount: 0, capped: false, currencies: [], minSample: MIN_SAMPLE });
    expect(summarizePayCheck([noPay(), noPay()], { asOf: NOW, capped: false })).toMatchObject({ matchedCount: 2, withPayCount: 0, currencies: [] });
  });

  it('carries `capped` through', () => {
    expect(summarizePayCheck(usdSeries(3), { asOf: NOW, capped: true }).capped).toBe(true);
  });
});

describe('the place (resolvePlace)', () => {
  const values = (location: string) => resolvePlace(location)!.sql.values;

  it('nothing asked, or nothing a place can be read from: anywhere in the market', () => {
    expect(resolvePlace(undefined)).toBeNull();
    expect(resolvePlace(null)).toBeNull();
    expect(resolvePlace('   ')).toBeNull();
    expect(resolvePlace('%%')).toBeNull();
  });

  it('"remote": remote posts; with a country, those open to it', () => {
    const anywhere = resolvePlace('remote')!;
    expect(anywhere.place).toEqual({ input: 'remote', kind: 'remote', name: null, country: null });
    expect(show(anywhere.sql)).toBe(`j."workModel" = 'remote'`);
    const us = resolvePlace('Remote - US')!;
    expect(us.place).toEqual({ input: 'Remote - US', kind: 'remote', name: null, country: 'US' });
    expect(show(us.sql)).toContain(`j."remoteScope" = 'global'`);
    expect(us.sql.values).toEqual(['US', 'US']);
  });

  it('a city of the table, by any of its names, in its country; never the remote pass the job list adds', () => {
    const austin = resolvePlace('Austin, TX')!;
    expect(austin.place).toEqual({ input: 'Austin, TX', kind: 'city', name: 'Austin', country: 'US' });
    expect(show(austin.sql)).toBe(`(lower(j."locationCity") = ANY($1::text[]) AND (j."locationCountry" IS NULL OR j."locationCountry" = $2))`);
    expect(values('Austin, TX')[0]).toContain('austin');
    const shanghai = resolvePlace('上海')!;
    expect(shanghai.place).toMatchObject({ kind: 'city', name: 'Shanghai', country: 'CN' });
    expect(shanghai.sql.values[0]).toEqual(expect.arrayContaining(['shanghai', '上海']));
    expect(show(austin.sql)).not.toContain('workModel');
  });

  it('a region (also a region name the city table does not hold) or a country', () => {
    expect(resolvePlace('Texas, US')!.place).toEqual({ input: 'Texas, US', kind: 'region', name: 'Texas', country: 'US' });
    const texas = resolvePlace('Texas')!;
    expect(texas.place).toEqual({ input: 'Texas', kind: 'region', name: 'Texas', country: 'US' });
    expect(texas.sql.values).toEqual(['US', ['tx', 'texas']]);
    const germany = resolvePlace('Germany')!;
    expect(germany.place).toEqual({ input: 'Germany', kind: 'country', name: null, country: 'DE' });
    expect(show(germany.sql)).toBe('j."locationCountry" = $1');
    expect(germany.sql.values).toEqual(['DE']);
  });

  it('a place the tables do not know: the post’s own location text, wildcards escaped', () => {
    const bay = resolvePlace('Bay Area')!;
    expect(bay.place).toEqual({ input: 'Bay Area', kind: 'text', name: null, country: null });
    expect(show(bay.sql)).toBe(`(j."location" ILIKE $1 OR lower(j."locationCity") = $2)`);
    expect(bay.sql.values[0]).toBe('%bay area%');
    expect(resolvePlace('Xyzzy_100%')!.sql.values[0]).toBe('%xyzzy\\_100\\%%');
  });
});

describe('the title (titleMatchOf): the job search’s own rule', () => {
  it('a title that names a role: the role (in the asked language) and the text', () => {
    expect(titleMatchOf('Data Analyst', 'en')).toEqual({ method: 'role', roleId: 'data_analyst', roleLabel: 'Data analyst', text: 'data analyst' });
    expect(titleMatchOf('Data Analyst', 'zh')).toMatchObject({ method: 'role', roleLabel: '数据分析师' });
    expect(titleMatchOf('Data Analyst', 'zh-TW')).toMatchObject({ method: 'role', roleLabel: '資料分析師' });
  });

  it('a title that names no role: case-insensitive text only', () => {
    expect(titleMatchOf('Xyzzy Wrangler', 'en')).toEqual({ method: 'text', roleId: null, roleLabel: null, text: 'xyzzy wrangler' });
  });
});

describe('the one statement (payCheckSql)', () => {
  const base = { title: 'Data Analyst', place: null, since: SINCE, now: NOW, limit: PAY_CHECK_ROW_CAP };

  it('reads only the pay columns, newest first, one row past the cap (that row only says "capped")', () => {
    const sql = payCheckSql({ ...base, market: 'intl' });
    const text = show(sql);
    expect(text).toMatch(/^SELECT j\."salaryCurrency", j\."salaryPeriod", j\."salaryMin", j\."salaryMax", j\."salaryMonths", j\."salaryAnnualMin", j\."salaryAnnualMax", j\."salaryDisclosed" FROM "RAJob" j WHERE /);
    expect(text).not.toMatch(/j\."id"|description|j\.\*/);
    expect(text).toMatch(/ORDER BY j\."firstSeenAt" DESC LIMIT \$\d+$/);
    expect(sql.values.at(-1)).toBe(PAY_CHECK_ROW_CAP + 1);
  });

  it('market scoping and the public-aggregate rows: brand market, public, canonical, live, no seed, no fraud flag, no row owing a credit line', () => {
    for (const market of ['intl', 'cn'] as const) {
      const sql = payCheckSql({ ...base, market });
      const text = show(sql);
      expect(text).toContain('j."market" = $1');
      expect(sql.values[0]).toBe(market);
      expect(sql.values).not.toContain(market === 'intl' ? 'cn' : 'intl');
      for (const fragment of [
        `j."visibility" = 'public'`,
        'j."isCanonical" = true',
        'j."archivedAt" IS NULL',
        'j."closedAt" IS NULL',
        `j."sourceBoard" <> 'seed'`,
        `j."fraudFlags" = '[]'::jsonb`,
        'NOT (j."sourceBoard" = ANY(',
      ]) {
        expect(text, `${market}: ${fragment}`).toContain(fragment);
      }
      expect(sql.values).toContainEqual([...CREDIT_LINE_BOARDS]);
      // Users' own imports never count: no owner arm, no per-user hidden state.
      expect(text).not.toContain('ownerUserId');
      expect(text).not.toContain('RAJobUserState');
    }
    // GoApply: only posts with a usable apply link (the list's own rule).
    expect(show(payCheckSql({ ...base, market: 'cn' }))).toContain(`j."applyUrl" ~*`);
    expect(show(payCheckSql({ ...base, market: 'intl' }))).not.toContain('applyUrl');
  });

  it(`the window: first seen in the last ${PAY_CHECK_WINDOW_DAYS} days, and posted in them when the post states a date`, () => {
    const sql = payCheckSql({ ...base, market: 'intl' });
    const text = show(sql);
    const firstSeen = text.match(/j\."firstSeenAt" >= \$(\d+)::timestamp\(3\)/);
    const posted = text.match(/\(j\."postedAt" IS NULL OR j\."postedAt" >= \$(\d+)::timestamp\(3\)\)/);
    expect(firstSeen).not.toBeNull();
    expect(posted).not.toBeNull();
    expect(sql.values[Number(firstSeen![1]) - 1]).toEqual(SINCE);
    expect(sql.values[Number(posted![1]) - 1]).toEqual(SINCE);
    expect(NOW.getTime() - SINCE.getTime()).toBe(90 * 86_400_000);
  });

  it('the title predicate is exactly the job search’s for a saved search with that title', () => {
    const anyParam = (s: string) => s.replace(/\$\d+/g, '$?');
    const sql = payCheckSql({ ...base, market: 'intl' });
    const search = predicateFor('titles', { titles: ['Data Analyst'] }, { market: 'intl', now: NOW })!;
    expect(show(search)).toBe(`(j."taxonomyIds" && $1::text[] OR j."titleNormalized" ILIKE ANY($2::text[]))`);
    // Same text (placeholders renumbered inside the statement) and the same values.
    expect(anyParam(show(sql))).toContain(anyParam(show(search)));
    for (const v of search.values) expect(sql.values).toContainEqual(v);
    expect(sql.values).toContainEqual(['data_analyst']);
    expect(sql.values).toContainEqual(['%data analyst%']);
    // …and a title with no role is matched on its text alone.
    const text = payCheckSql({ ...base, title: 'Xyzzy Wrangler', market: 'intl' });
    expect(show(text)).not.toContain('taxonomyIds');
    expect(text.values).toContainEqual(['%xyzzy wrangler%']);
  });

  it('a place narrows the same statement', () => {
    const sql = payCheckSql({ ...base, market: 'intl', place: resolvePlace('Austin, TX')!.sql });
    expect(show(sql)).toContain('lower(j."locationCity") = ANY(');
  });

  it('a title that matches nothing reads nothing (never every post of the window)', () => {
    expect(show(payCheckSql({ ...base, title: '', market: 'intl' }))).toContain('AND FALSE');
  });
});

describe('the reader (createPayCheck)', () => {
  function fakeDb(rows: PayCheckRow[]) {
    const calls: Prisma.Sql[] = [];
    const db: PayCheckDb = {
      $queryRaw: async <T,>(query: Prisma.Sql) => {
        calls.push(query);
        return rows as unknown as T;
      },
    };
    return { db, calls };
  }

  it('answers the counts, the window, how the title and place matched, and the figures per currency', async () => {
    const { db, calls } = fakeDb([...usdSeries(25), ...Array.from({ length: 3 }, () => payRow(50_000, 60_000, { salaryCurrency: 'EUR' })), ...Array.from({ length: 10 }, noPay)]);
    const reader = createPayCheck({ db: async () => db, market: () => 'intl', now: () => NOW });
    const res = await reader.check({ title: '  Data Analyst ', location: 'Austin, TX', locale: 'en' });
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({
      status: 'ok',
      title: 'Data Analyst',
      titleMatch: { method: 'role', roleId: 'data_analyst', roleLabel: 'Data analyst', text: 'data analyst' },
      place: { input: 'Austin, TX', kind: 'city', name: 'Austin', country: 'US' },
      window: { days: 90, from: SINCE.toISOString(), to: NOW.toISOString() },
      matchedCount: 38,
      withPayCount: 28,
      capped: false,
      rowCap: PAY_CHECK_ROW_CAP,
      period: 'year',
      minSample: MIN_SAMPLE,
      asOf: NOW.toISOString(),
    });
    expect(res.currencies.map((c) => [c.currency, c.sampleSize, c.median !== null])).toEqual([
      ['USD', 25, true],
      ['EUR', 3, false],
    ]);
    expect(calls[0]!.values[0]).toBe('intl');
  });

  it('runs in the brand’s market: a GoApply reader asks for cn posts only', async () => {
    const { db, calls } = fakeDb([]);
    await createPayCheck({ db: async () => db, market: () => 'cn', now: () => NOW, env: {} }).check({ title: '数据分析师' });
    expect(calls[0]!.values[0]).toBe('cn');
    expect(show(calls[0]!)).toContain(`j."applyUrl" ~*`);
  });

  it('more posts than the cap: the newest cap are read and the answer says capped', async () => {
    const { db } = fakeDb(usdSeries(PAY_CHECK_ROW_CAP + 1, 50_000, 10));
    const res = await createPayCheck({ db: async () => db, market: () => 'intl', now: () => NOW }).check({ title: 'Data Analyst' });
    expect(res.matchedCount).toBe(PAY_CHECK_ROW_CAP);
    expect(res.withPayCount).toBe(PAY_CHECK_ROW_CAP);
    expect(res.capped).toBe(true);
  });

  it('not enough: the counts and no figure', async () => {
    const { db } = fakeDb([...usdSeries(4), noPay()]);
    const res = await createPayCheck({ db: async () => db, market: () => 'intl', now: () => NOW }).check({ title: 'Data Analyst', location: '' });
    expect(res).toMatchObject({ status: 'not_enough', matchedCount: 5, withPayCount: 4, place: null });
    expect(res.currencies).toEqual([{ currency: 'USD', sampleSize: 4, p25: null, median: null, p75: null }]);
  });

  it('a title with no letter or digit is refused before anything is read', async () => {
    const { db, calls } = fakeDb([]);
    const reader = createPayCheck({ db: async () => db, market: () => 'intl', now: () => NOW });
    for (const title of ['', '   ', '%%']) await expect(reader.check({ title })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('GoApply with the recruitment-info mode off shows no third-party post: not available, nothing is read', async () => {
    const { db, calls } = fakeDb([]);
    const reader = createPayCheck({ db: async () => db, market: () => 'cn', now: () => NOW, env: { CN_RECRUITMENT_INFO_MODE: 'off' } });
    await expect(reader.check({ title: '数据分析师' })).rejects.toMatchObject({ code: 'feature_disabled' });
    await expect(reader.check({ title: '数据分析师' })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(0);
    // RoboApply is not affected by that switch.
    const intl = fakeDb([]);
    await createPayCheck({ db: async () => intl.db, market: () => 'intl', now: () => NOW, env: { CN_RECRUITMENT_INFO_MODE: 'off' } }).check({ title: 'Data Analyst' });
    expect(intl.calls).toHaveLength(1);
  });
});

describe('the query contract', () => {
  it('a title is required, trimmed, at most 120 characters, and holds a letter or a digit; the location is optional', () => {
    expect(PayCheckQuerySchema.parse({ title: '  Data Analyst ', location: ' Austin ' })).toEqual({ title: 'Data Analyst', location: 'Austin' });
    expect(PayCheckQuerySchema.safeParse({ title: '数据分析师' }).success).toBe(true);
    expect(PayCheckQuerySchema.safeParse({ title: 'C#' }).success).toBe(true);
    for (const bad of [{}, { title: '' }, { title: '   ' }, { title: '%%%' }, { title: 'x'.repeat(121) }, { title: 'Data Analyst', location: 'y'.repeat(121) }]) {
      expect(PayCheckQuerySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });
});
