// @vitest-environment node
// The demand-driven planner (ARCH §4.3; MARKET_STRATEGY §1.2 tier 2, §1.3, M-3;
// JI-2, JI-6, JT-3, SM-11):
//   - intervals, windows and back-off (a window always covers its interval);
//   - demand tuples from default profiles, SEO seeds;
//   - which sources a tuple is planned on: on for the market, quota open, no
//     seed on a source billed per request, and (MKT-5A; M-2, JI-7, JC-6) no
//     seed on a metered search source while the licensed feed that writes its
//     board is on; the mainland is planned on Active Jobs DB only while its
//     plan gate is open, with a taxonomy role's label and never a typed title;
//     a source of both markets is asked for mainland China by the mainland
//     only (one posting, one market);
//   - a source behind a plan whose gate is closed when the plan runs is still
//     a source of the brand: its standing query and its demand are left as
//     they are, never switched off for a day;
//   - which texts: a typed title as typed, a role in the market's languages
//     (Taiwan: Traditional Chinese and English, both over a month);
//   - a query's identity (the window and the label text are not part of it);
//   - the stored window is the one the source really applies, and a rewrite
//     that widens it (or changes the text) restarts the query's counted runs,
//     so the missed-refresh rule never closes a posting the query could not
//     have returned;
//   - the bulk upsert and every retirement statement, and a whole plan run
//     against a small model of the RAIngestQuery table.
// No network, no database: adapters are fakes and are never fetched from.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../../platform/brand/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { knownIngestProvidersForBrand, planAdaptersOnNow } from './providers.js';
import { resetProviderQuotaForTests } from './quota.js';
import type { RecordedSql } from '../../../test/sqlSnapshot.js';
import { adapterCostModel, adapterDateWindow } from '../sources/index.js';
import type { JobSourceAdapter } from '../sources/index.js';
import type { ProviderQueryLabel } from '../taxonomy/index.js';
import type { IngestDb } from './db.js';
import {
  BANK_SYNC_PARAMS,
  QUERY_HASH_PREFIX,
  REFRESH,
  baseRefreshMs,
  collectDemand,
  datePostedFor,
  ensureBankSyncQueries,
  feedCoversBoard,
  mergeTuples,
  nextRunDelayMs,
  paramsForTuple,
  paramsHash,
  perRequestProviders,
  planQueries,
  plannableAdapters,
  primaryRole,
  priorityFor,
  queryHash,
  queryVariants,
  quotaClosed,
  readQuotaSnapshots,
  retireSeedsFor,
  retireSuperseded,
  retireUnrunProviders,
  retireUnusedDemand,
  runPlanner,
  searchCountry,
  seedTuples,
  tuplesFromFilters,
  upsertPlannedQueries,
  windowMs,
  type DemandTuple,
  type PlannedQuery,
  type QueryLabelSource,
} from './planner.js';
import { PROVIDER_QUOTA_CONFIG_KEY, serializeProviderQuota, type ProviderQuotaSnapshot } from './quotaContract.js';
import { isMissedTwice } from './tracking.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-10T02:00:00.000Z');
const robo = getBrand('roboapply');
const go = getBrand('goapply');

function adapter(provider: JobSourceAdapter['provider'], over: Partial<JobSourceAdapter> = {}): JobSourceAdapter {
  return {
    provider,
    kind: 'search',
    markets: ['intl'],
    sourceBoards: [provider],
    isEnabled: () => true,
    supportsCountry: () => true,
    dailyCallLimit: () => 100,
    fetch: vi.fn(async () => ({ jobs: [], calls: 1 })),
    ...over,
  };
}

/**
 * SYNTHETIC role labels in the shape of `providerQueryLabels` (taxonomy/queryLabels.ts):
 * English texts for market intl, a Traditional Chinese text for Taiwan only when the role
 * has one, Simplified Chinese texts for market cn. `backend_engineer` has a Traditional
 * label here; `data_scientist` and every other role have none.
 */
const LABELS: Record<string, { en: string[]; zhHant?: string; zh: string[] }> = {
  backend_engineer: { en: ['Backend engineer', 'Backend developer'], zhHant: '後端工程師', zh: ['后端工程师', '服务端开发'] },
  data_scientist: { en: ['Data scientist'], zh: ['数据科学家'] },
};
const labels: QueryLabelSource = (roleId, { market, country }) => {
  // Any other role: one made-up text per market language, so seed roles plan like real ones.
  const role = LABELS[roleId] ?? { en: [`${roleId} (en)`], zh: [`${roleId}（中文）`] };
  if (market === 'cn') return role.zh.map((text): ProviderQueryLabel => ({ text, language: 'zh-CN' }));
  const out: ProviderQueryLabel[] = role.en.map((text) => ({ text, language: 'en' }));
  if (country?.trim().toUpperCase() === 'TW' && role.zhHant) out.push({ text: role.zhHant, language: 'zh-TW' });
  return out;
};

const tuple = (over: Partial<DemandTuple> = {}): DemandTuple => ({
  market: 'intl',
  taxonomyId: 'backend_engineer',
  q: 'Backend engineer',
  country: 'US',
  origin: 'demand',
  users: 1,
  ...over,
});
const plan = (tuples: DemandTuple[], adapters: JobSourceAdapter[]): PlannedQuery[] => planQueries(tuples, adapters, { queryLabels: labels });
const brief = (planned: PlannedQuery[]) => planned.map((p) => [p.provider, p.params.q, p.params.datePosted, p.origin]);

describe('refresh intervals, windows and back-off', () => {
  it('hot demand 6 h, cold demand 24 h, Taiwan demand 12 h, seeds 24 h, bank syncs 30 min', () => {
    const table: Array<[Parameters<typeof baseRefreshMs>[0], number]> = [
      [{ origin: 'demand', demandScore: 5 }, 6 * HOUR],
      [{ origin: 'demand', demandScore: 40 }, 6 * HOUR],
      [{ origin: 'demand', demandScore: 4 }, 24 * HOUR],
      [{ origin: 'demand', demandScore: 1 }, 24 * HOUR],
      [{ origin: 'demand', demandScore: 1, country: 'TW' }, 12 * HOUR],
      [{ origin: 'demand', demandScore: 4, country: 'tw' }, 12 * HOUR],
      [{ origin: 'demand', demandScore: 9, country: ' TW ' }, 12 * HOUR],
      [{ origin: 'seo_seed', demandScore: 0 }, 24 * HOUR],
      [{ origin: 'seo_seed', demandScore: 0, country: 'TW' }, 24 * HOUR],
      [{ origin: 'demand', demandScore: 0 }, 24 * HOUR],
      [{ origin: 'bank_sync', demandScore: 0 }, 30 * 60_000],
      [{ origin: 'bank_sync', demandScore: 0, country: 'TW' }, 30 * 60_000],
    ];
    for (const [input, expected] of table) expect(baseRefreshMs(input), JSON.stringify(input)).toBe(expected);
    expect(REFRESH).toMatchObject({ hotDemandMs: 6 * HOUR, coldDemandMs: 24 * HOUR, twDemandMs: 12 * HOUR, seedMs: 24 * HOUR, bankSyncMs: 30 * 60_000 });
  });

  it('no country, a null country or another country keeps the hot / cold rule (the field is optional)', () => {
    for (const country of [undefined, null, '', 'US', 'CN', 'JP']) {
      expect(baseRefreshMs({ origin: 'demand', demandScore: 6, country }), String(country)).toBe(6 * HOUR);
      expect(baseRefreshMs({ origin: 'demand', demandScore: 2, country }), String(country)).toBe(24 * HOUR);
      expect(baseRefreshMs({ origin: 'seo_seed', demandScore: 0, country }), String(country)).toBe(24 * HOUR);
      expect(nextRunDelayMs({ origin: 'demand', demandScore: 6, consecutiveEmpty: 0, country }), String(country)).toBe(6 * HOUR);
    }
    // The ingest run hands the query's country over in a variable; a caller that has none still compiles and works.
    const withoutCountry = { origin: 'demand', demandScore: 2, consecutiveEmpty: 0 };
    expect(nextRunDelayMs(withoutCountry)).toBe(24 * HOUR);
    const withCountry = { ...withoutCountry, country: 'TW' as string | null };
    expect(nextRunDelayMs(withCountry)).toBe(12 * HOUR);
  });

  it('the window follows the interval: 3 days for hot demand, a week for cold demand and seeds, a month for Taiwan', () => {
    expect(datePostedFor({ origin: 'demand', demandScore: 6 })).toBe('3days');
    expect(datePostedFor({ origin: 'demand', demandScore: 5 })).toBe('3days');
    expect(datePostedFor({ origin: 'demand', demandScore: 4 })).toBe('week');
    expect(datePostedFor({ origin: 'demand', demandScore: 2 })).toBe('week');
    expect(datePostedFor({ origin: 'seo_seed', demandScore: 0 })).toBe('week');
    expect(datePostedFor({ origin: 'demand', demandScore: 1, country: 'TW' })).toBe('month');
    expect(datePostedFor({ origin: 'demand', demandScore: 8, country: 'TW' })).toBe('month');
    expect(datePostedFor({ origin: 'bank_sync', demandScore: 0 })).toBe('all');
    expect(windowMs('3days')).toBe(3 * DAY);
    expect(windowMs('week')).toBe(7 * DAY);
    expect(windowMs('month')).toBe(30 * DAY);
    expect(windowMs('today')).toBe(DAY);
    expect(windowMs('all')).toBe(Number.POSITIVE_INFINITY);
    // An unknown value is sent as a week by the adapters, so it counts as one.
    expect(windowMs('fortnight')).toBe(7 * DAY);
  });

  it('doubles the interval from the 4th empty run on, capped at 7 days and at the query\'s own window', () => {
    const hot = { origin: 'demand', demandScore: 5 };
    expect(nextRunDelayMs({ ...hot, consecutiveEmpty: 3 })).toBe(6 * HOUR);
    expect(nextRunDelayMs({ ...hot, consecutiveEmpty: 4 })).toBe(12 * HOUR);
    expect(nextRunDelayMs({ ...hot, consecutiveEmpty: 5 })).toBe(24 * HOUR);
    expect(nextRunDelayMs({ ...hot, consecutiveEmpty: 6 })).toBe(48 * HOUR);
    // A hot query asks for three days of postings: it is never left alone for longer than that.
    expect(nextRunDelayMs({ ...hot, consecutiveEmpty: 7 })).toBe(3 * DAY);
    expect(nextRunDelayMs({ ...hot, consecutiveEmpty: 30 })).toBe(3 * DAY);
    const cold = { origin: 'demand', demandScore: 2 };
    expect(nextRunDelayMs({ ...cold, consecutiveEmpty: 4 })).toBe(48 * HOUR);
    expect(nextRunDelayMs({ ...cold, consecutiveEmpty: 30 })).toBe(REFRESH.maxMs);
    expect(nextRunDelayMs({ origin: 'seo_seed', demandScore: 0, consecutiveEmpty: 8 })).toBe(REFRESH.maxMs);
    const taiwan = { origin: 'demand', demandScore: 2, country: 'TW' };
    expect(nextRunDelayMs({ ...taiwan, consecutiveEmpty: 4 })).toBe(24 * HOUR);
    expect(nextRunDelayMs({ ...taiwan, consecutiveEmpty: 30 })).toBe(REFRESH.maxMs);
    // Bank syncs never back off (a quiet bank is not a dead query).
    expect(nextRunDelayMs({ origin: 'bank_sync', demandScore: 0, consecutiveEmpty: 9 })).toBe(30 * 60_000);
  });

  it('a window always covers at least one full interval, at every score, country and back-off step', () => {
    for (const origin of ['demand', 'seo_seed', 'manual'] as const) {
      for (const demandScore of [0, 1, 2, 4, 5, 6, 50]) {
        for (const country of [undefined, null, 'US', 'TW', 'CN']) {
          const window = windowMs(datePostedFor({ origin, demandScore, country }));
          expect(baseRefreshMs({ origin, demandScore, country })).toBeLessThanOrEqual(window);
          for (let consecutiveEmpty = 0; consecutiveEmpty <= 40; consecutiveEmpty += 1) {
            expect(nextRunDelayMs({ origin, demandScore, consecutiveEmpty, country }), `${origin} ${demandScore} ${country} ${consecutiveEmpty}`).toBeLessThanOrEqual(window);
          }
        }
      }
    }
  });

  it('runs bank syncs and hot demand before seeds', () => {
    expect(priorityFor('bank_sync', 0)).toBeLessThan(priorityFor('demand', 5));
    expect(priorityFor('demand', 5)).toBeLessThan(priorityFor('demand', 1));
    expect(priorityFor('demand', 1)).toBeLessThan(priorityFor('seo_seed', 0));
    expect(priorityFor('demand', REFRESH.hotDemandFrom)).toBe(10);
    expect(priorityFor('demand', REFRESH.hotDemandFrom - 1)).toBe(50);
  });
});

describe('demand tuples from a default search profile', () => {
  it('uses the first taxonomy role (English label) and each resolvable location', () => {
    const tuples = tuplesFromFilters(
      {
        taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'],
        locations: [
          { label: 'Taipei', city: 'Taipei', country: 'TW', radiusKm: 40 },
          { label: 'Austin, TX', city: 'Austin', radiusKm: 40 },
          { label: 'Atlantis', city: 'Atlantis', radiusKm: 40 },
        ],
        workModels: ['remote'],
      },
      robo,
    );
    const role = primaryRole({ taxonomyIds: ['software_engineering', 'swe_backend', 'backend_engineer'] });
    expect(role?.taxonomyId).toBe('backend_engineer');
    expect(tuples.map((t) => [t.country, t.city ?? null, t.remote ?? false])).toEqual([
      ['TW', 'Taipei', false],
      ['US', 'Austin', false],
      ['TW', null, true],
    ]);
    for (const t of tuples) {
      expect(t.q).toBe(role!.q);
      expect(t.origin).toBe('demand');
    }
  });

  it('never invents a country: an unknown city without one is skipped; no location → the profile/brand country', () => {
    expect(tuplesFromFilters({ titles: ['Data engineer'], locations: [{ label: 'Nowhere', city: 'Nowhereville', radiusKm: 40 }] }, robo)).toEqual([
      { market: 'intl', taxonomyId: null, q: 'Data engineer', origin: 'demand', country: 'US' },
    ]);
    expect(tuplesFromFilters({ titles: ['Data engineer'], country: 'GB' }, robo)[0]!.country).toBe('GB');
    expect(tuplesFromFilters({ country: 'GB' }, robo)).toEqual([]);
  });

  it('a typed title keeps the script it was typed in', () => {
    expect(tuplesFromFilters({ titles: ['  軟體工程師 '], country: 'TW' }, robo)).toEqual([{ market: 'intl', taxonomyId: null, q: '軟體工程師', origin: 'demand', country: 'TW' }]);
  });
});

describe('seeds and merge', () => {
  it('seeds the first N roles × the largest cities of each seed country (RoboApply only)', () => {
    const env = { INGEST_SEED_ROLES: '2', INGEST_SEED_CITIES_PER_COUNTRY: '2', INGEST_SEED_COUNTRIES: 'US,TW' };
    const seeds = seedTuples(robo, env);
    expect(seeds).toHaveLength(2 * 2 * 2);
    expect(seeds.filter((s) => s.country === 'TW').map((s) => s.city)).toEqual(['Taipei', 'New Taipei', 'Taipei', 'New Taipei']);
    expect(seeds.every((s) => s.origin === 'seo_seed' && s.users === 0)).toBe(true);
    expect(seedTuples(go, env)).toEqual([]);
  });

  it('the default seed set is 300 roles × 3 cities of the brand country', () => {
    const seeds = seedTuples(robo, {});
    expect(seeds.length).toBeGreaterThan(600);
    expect(seeds.length).toBeLessThanOrEqual(900);
    expect(new Set(seeds.map((s) => s.country))).toEqual(new Set(['US']));
  });

  it('demand wins over a seed for the same tuple', () => {
    const seed = tuple({ city: 'Austin', origin: 'seo_seed', users: 0 });
    const merged = mergeTuples([{ ...seed, origin: 'demand', users: 3 }], [seed]);
    expect(merged).toEqual([{ ...seed, origin: 'demand', users: 3 }]);
  });
});

describe('query texts of a tuple (queryVariants)', () => {
  it('a typed title is searched once, as typed, in whichever script', () => {
    expect(queryVariants({ market: 'intl', taxonomyId: null, q: ' Data engineer ', country: 'US' }, labels)).toEqual([{ text: 'Data engineer', language: null }]);
    expect(queryVariants({ market: 'intl', taxonomyId: null, q: '軟體工程師', country: 'TW' }, labels)).toEqual([{ text: '軟體工程師', language: null }]);
    expect(queryVariants({ market: 'cn', taxonomyId: null, q: '数据分析师', country: 'CN' }, labels)).toEqual([{ text: '数据分析师', language: null }]);
    expect(queryVariants({ market: 'intl', taxonomyId: null, q: '  ', country: 'US' }, labels)).toEqual([]);
  });

  it('a role outside Taiwan: the first English text only', () => {
    expect(queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'US' }, labels)).toEqual([{ text: 'Backend engineer', language: 'en' }]);
    expect(queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'JP' }, labels)).toEqual([{ text: 'Backend engineer', language: 'en' }]);
  });

  it('a role in Taiwan: the Traditional Chinese text and the first English text; without a Traditional label English only', () => {
    expect(queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'TW' }, labels)).toEqual([
      { text: '後端工程師', language: 'zh-TW' },
      { text: 'Backend engineer', language: 'en' },
    ]);
    expect(queryVariants({ market: 'intl', taxonomyId: 'data_scientist', q: 'x', country: 'TW' }, labels)).toEqual([{ text: 'Data scientist', language: 'en' }]);
    // The Simplified label is never a Taiwan query, even from a source that would hand it over.
    const leaky: QueryLabelSource = () => [
      { text: 'Data scientist', language: 'en' },
      { text: '数据科学家', language: 'zh-CN' },
    ];
    expect(queryVariants({ market: 'intl', taxonomyId: 'data_scientist', q: 'x', country: 'TW' }, leaky)).toEqual([{ text: 'Data scientist', language: 'en' }]);
  });

  it('a Taiwanese city makes the tuple a Taiwan search whatever country it carries', () => {
    expect(searchCountry({ country: 'tw' })).toBe('TW');
    expect(searchCountry({ country: 'US', city: 'Taipei' })).toBe('TW');
    expect(searchCountry({ country: 'US', city: 'Austin' })).toBe('US');
    expect(searchCountry({ country: 'US', city: 'Nowhereville' })).toBe('US');
    expect(searchCountry({ country: 'US' })).toBe('US');
    expect(queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'US', city: 'Taipei' }, labels).map((v) => v.language)).toEqual(['zh-TW', 'en']);
  });

  it('market cn: the first Simplified Chinese text, no English', () => {
    expect(queryVariants({ market: 'cn', taxonomyId: 'backend_engineer', q: 'x', country: 'CN' }, labels)).toEqual([{ text: '后端工程师', language: 'zh-CN' }]);
  });

  it('an unknown role or a role without a text in the wanted language gives no variant', () => {
    expect(queryVariants({ market: 'intl', taxonomyId: 'no_such_role', q: 'x', country: 'US' }, () => [])).toEqual([]);
    expect(queryVariants({ market: 'intl', taxonomyId: 'no_such_role', q: 'x', country: 'US' })).toEqual([]);
    expect(queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'US' }, () => [{ text: '  ', language: 'en' }])).toEqual([]);
  });

  it('by default the texts are the taxonomy\'s own (providerQueryLabels)', () => {
    const us = queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'US' });
    expect(us).toHaveLength(1);
    expect(us[0]).toMatchObject({ language: 'en' });
    expect(us[0]!.text).toMatch(/backend/i);
    const cn = queryVariants({ market: 'cn', taxonomyId: 'backend_engineer', q: 'x', country: 'CN' });
    expect(cn).toHaveLength(1);
    expect(cn[0]!.language).toBe('zh-CN');
    expect(cn[0]!.text).toMatch(/[一-鿿]/);
    // Taiwan: English always; the Traditional text only once the taxonomy has one (never more than these two).
    const tw = queryVariants({ market: 'intl', taxonomyId: 'backend_engineer', q: 'x', country: 'TW' });
    expect(tw.at(-1)).toMatchObject({ language: 'en' });
    expect(tw.length).toBeLessThanOrEqual(2);
    expect(tw.every((v) => v.language === 'en' || v.language === 'zh-TW')).toBe(true);
  });
});

describe('a query\'s identity (queryHash)', () => {
  const base = { market: 'intl' as const, taxonomyId: 'backend_engineer', q: 'Backend engineer', country: 'US', city: 'Austin' };

  it('is market, role, language, country, city and remote', () => {
    const h = queryHash(base, 'en');
    expect(h.startsWith(QUERY_HASH_PREFIX)).toBe(true);
    expect(h).toHaveLength(QUERY_HASH_PREFIX.length + 40);
    expect(queryHash({ ...base, market: 'cn' }, 'en')).not.toBe(h);
    expect(queryHash({ ...base, taxonomyId: 'data_scientist' }, 'en')).not.toBe(h);
    expect(queryHash(base, 'zh-TW')).not.toBe(h);
    expect(queryHash({ ...base, country: 'CA' }, 'en')).not.toBe(h);
    expect(queryHash({ ...base, city: 'Dallas' }, 'en')).not.toBe(h);
    expect(queryHash({ ...base, city: undefined }, 'en')).not.toBe(h);
    expect(queryHash({ ...base, remote: true }, 'en')).not.toBe(h);
    expect(queryHash({ ...base, remote: false }, 'en')).toBe(h);
    expect(queryHash({ ...base, city: ' austin ', country: 'us' }, 'en')).toBe(h);
  });

  it('does not hold the window or the label text of a role: a hot / cold change and a corrected label keep the row', () => {
    const cold = plan([tuple({ users: 2 })], [adapter('jsearch')])[0]!;
    const hot = plan([tuple({ users: 6 })], [adapter('jsearch')])[0]!;
    expect(cold.params.datePosted).toBe('week');
    expect(hot.params.datePosted).toBe('3days');
    expect(hot.paramsHash).toBe(cold.paramsHash);
    const relabelled = planQueries([tuple({ users: 2 })], [adapter('jsearch')], { queryLabels: () => [{ text: 'Back-end engineer', language: 'en' }] })[0]!;
    expect(relabelled.params.q).toBe('Back-end engineer');
    expect(relabelled.paramsHash).toBe(cold.paramsHash);
    // The role text of a taxonomy tuple (a log field) is not part of it either.
    expect(queryHash({ ...base, q: 'anything' }, 'en')).toBe(queryHash(base, 'en'));
  });

  it('a typed title is identified by its text, whatever its case; it has no language', () => {
    const typed = { market: 'intl' as const, taxonomyId: null, q: 'Data Engineer', country: 'US' };
    expect(queryHash(typed, null)).toBe(queryHash({ ...typed, q: ' data engineer ' }, null));
    expect(queryHash(typed, null)).toBe(queryHash(typed, 'en'));
    expect(queryHash(typed, null)).not.toBe(queryHash({ ...typed, q: 'Data analyst' }, null));
  });

  it('a Taiwanese city under another country is the same query as under TW', () => {
    expect(queryHash({ ...base, country: 'US', city: 'Taipei' }, 'en')).toBe(queryHash({ ...base, country: 'TW', city: 'Taipei' }, 'en'));
  });

  it('a standing query keeps the hash of its params (paramsHash): no cursor, any key order, the market in it', () => {
    expect(paramsHash('intl', { q: 'a', country: 'US', datePosted: 'week' })).toBe(paramsHash('intl', { datePosted: 'week', country: 'US', q: 'a', cursor: 'x' }));
    expect(paramsHash('intl', { q: 'a', country: 'US', datePosted: 'week' })).not.toBe(paramsHash('intl', { q: 'a', country: 'TW', datePosted: 'week' }));
    expect(paramsHash('intl', BANK_SYNC_PARAMS)).not.toBe(paramsHash('cn', BANK_SYNC_PARAMS));
    // A planned search query is never identified by the earlier recipe.
    const planned = plan([tuple()], [adapter('jsearch')])[0]!;
    expect(planned.paramsHash).not.toBe(paramsHash('intl', planned.params));
    expect(paramsHash('intl', planned.params).startsWith(QUERY_HASH_PREFIX)).toBe(false);
  });

  it('keeps the market in a query\'s identity: the same search planned for two brands is two rows', () => {
    const typed = { taxonomyId: null, q: 'Data analyst', country: 'CN', origin: 'demand' as const, users: 1 };
    expect(queryHash({ ...typed, market: 'intl' }, null)).not.toBe(queryHash({ ...typed, market: 'cn' }, null));
    // Two sources, one per market, plan it with the same params and two identities.
    const [intl] = plan([{ ...typed, market: 'intl' }], [adapter('jsearch')]);
    // A search source that is not a metered provider (a typed title never goes to a metered one on the mainland).
    const mainland = adapter('usajobs', { markets: ['cn'] });
    expect(adapterCostModel(mainland)).toBe('free');
    const [cn] = plan([{ ...typed, market: 'cn' }], [mainland]);
    expect(intl!.params).toEqual(cn!.params);
    expect(intl!.paramsHash).not.toBe(cn!.paramsHash);
  });
});

describe('which sources a tuple is planned on (JI-2)', () => {
  const perRequest = adapter('jsearch');
  const perJob = adapter('activejobs');
  const free = adapter('usajobs');

  it('the fakes carry the cost models of their provider ids', () => {
    expect([perRequest, perJob, free].map(adapterCostModel)).toEqual(['per_request', 'per_job', 'free']);
  });

  it('an SEO seed is never planned on a source billed per request; per-job and free sources keep their seeds', () => {
    const seed = tuple({ city: 'Austin', origin: 'seo_seed', users: 0 });
    expect(brief(plan([seed], [perRequest, perJob, free]))).toEqual([
      ['activejobs', 'Backend engineer', 'week', 'seo_seed'],
      ['usajobs', 'Backend engineer', 'week', 'seo_seed'],
    ]);
    expect(plan([seed], [perRequest])).toEqual([]);
    // The model an adapter declares wins over the default for its provider id.
    expect(plan([seed], [adapter('jsearch', { costModel: 'per_job' })]).map((p) => p.provider)).toEqual(['jsearch']);
    expect(plan([seed], [adapter('usajobs', { costModel: 'per_request' })])).toEqual([]);
  });

  it('a user\'s own demand is planned on every source, the per-request one included', () => {
    const demand = tuple({ city: 'Austin', users: 1 });
    expect(plan([demand], [perRequest, perJob, free]).map((p) => p.provider)).toEqual(['jsearch', 'activejobs', 'usajobs']);
    // The same tuple as a seed and as demand: demand won the merge, so JSearch gets it.
    const merged = mergeTuples([demand], [{ ...demand, origin: 'seo_seed', users: 0 }]);
    expect(plan(merged, [perRequest]).map((p) => [p.provider, p.origin])).toEqual([['jsearch', 'demand']]);
  });

  it('the default 900 seed tuples plan nothing on JSearch and one query each on a per-job source', () => {
    const seeds = seedTuples(robo, {});
    const planned = planQueries(seeds, [perRequest, perJob]);
    expect(planned.filter((p) => p.provider === 'jsearch')).toEqual([]);
    expect(planned.filter((p) => p.provider === 'activejobs')).toHaveLength(seeds.length);
    expect(new Set(planned.map((p) => p.paramsHash)).size).toBe(seeds.length);
  });

  describe('no seeds on a metered search source while a feed that writes its board is on (M-2, JI-7)', () => {
    const seed = tuple({ city: 'Austin', origin: 'seo_seed', users: 0 });
    const demand = tuple({ city: 'Austin', users: 2 });
    const feed = (over: Partial<JobSourceAdapter> = {}) => adapter('activejobs_feed', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['activejobs'], dailyCallLimit: () => null, ...over });

    it('the feed on: the Active Jobs DB search adapter plans no seed and keeps a user\'s own demand', () => {
      expect(plan([seed], [perJob, feed()])).toEqual([]);
      // The same tuple as a seed and as demand: the free source had the seed and now has the demand; the metered one gets the demand only.
      expect(brief(plan([seed, demand], [perJob, feed(), free])).sort()).toEqual([
        ['activejobs', 'Backend engineer', 'week', 'demand'],
        ['usajobs', 'Backend engineer', 'week', 'demand'],
      ]);
      expect(brief(plan([seed], [perJob, feed(), free]))).toEqual([['usajobs', 'Backend engineer', 'week', 'seo_seed']]);
      // The default 900 seeds: none on the search adapter while the feed covers the breadth.
      expect(planQueries(seedTuples(robo, {}), [perJob, feed()])).toEqual([]);
    });

    it('the feed off (the gate closed, today\'s free plan): the seeds are planned as before', () => {
      const closed = feed({ isEnabled: () => false });
      expect(brief(plan([seed], [perJob, closed]))).toEqual([['activejobs', 'Backend engineer', 'week', 'seo_seed']]);
      // Off for this market only.
      const cnOnly = feed({ isEnabled: () => true, isEnabledFor: (m) => m === 'cn' });
      expect(plan([seed], [perJob, cnOnly]).map((p) => p.provider)).toEqual(['activejobs']);
      // A feed that throws while answering is off.
      const boom = feed({
        isEnabled: () => {
          throw new Error('gate not readable');
        },
      });
      expect(plan([seed], [perJob, boom]).map((p) => p.provider)).toEqual(['activejobs']);
      // Without a feed in the list nothing changes.
      expect(plan([seed], [perJob]).map((p) => p.provider)).toEqual(['activejobs']);
    });

    it('only a feed of the SAME board covers a search source; banks, boards and a free source are not affected', () => {
      const bank = adapter('bank_robohire', { kind: 'cursor', sourceBoards: ['robohire'], dailyCallLimit: () => null });
      const boards = adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['greenhouse', 'lever'], dailyCallLimit: () => null });
      expect(plan([seed], [perJob, bank, boards]).map((p) => p.provider)).toEqual(['activejobs']);
      expect(feedCoversBoard(perJob, [perJob, bank, boards], 'intl')).toBe(false);
      expect(feedCoversBoard(perJob, [perJob, feed()], 'intl')).toBe(true);
      // A feed of another market does not cover this one.
      expect(feedCoversBoard(perJob, [perJob, feed({ markets: ['cn'] })], 'intl')).toBe(false);
      // A search adapter is never its own feed, and a second search adapter of the board is not a feed.
      expect(feedCoversBoard(perJob, [perJob, adapter('activejobs_feed', { sourceBoards: ['activejobs'] })], 'intl')).toBe(false);
      // A source that costs nothing keeps its seeds whatever feed is on.
      const freeSameBoard = adapter('usajobs', { sourceBoards: ['activejobs'] });
      expect(plan([seed], [freeSameBoard, feed()]).map((p) => p.provider)).toEqual(['usajobs']);
    });

    it('asks the feed whether it is on once per market, not once per seed', () => {
      const isEnabled = vi.fn(() => true);
      planQueries(seedTuples(robo, { INGEST_SEED_ROLES: '20', INGEST_SEED_CITIES_PER_COUNTRY: '2' }), [perJob, feed({ isEnabled })]);
      expect(isEnabled).toHaveBeenCalledTimes(1);
    });
  });

  it('a source that is off gets no query: disabled, throwing, or off for this market only', () => {
    const t = tuple({ users: 3 });
    expect(plan([t], [adapter('activejobs', { isEnabled: () => false }), perRequest]).map((p) => p.provider)).toEqual(['jsearch']);
    const boom = adapter('activejobs', {
      isEnabled: () => {
        throw new Error('env not readable');
      },
    });
    expect(plan([t], [boom, perRequest]).map((p) => p.provider)).toEqual(['jsearch']);
    // isEnabledFor decides per market, whatever isEnabled says.
    const both = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'], isEnabled: () => true, isEnabledFor: (m) => m === 'intl' });
    expect(plan([t], [both]).map((p) => p.provider)).toEqual(['activejobs']);
    expect(plan([tuple({ market: 'cn', country: 'CN', users: 3 })], [both])).toEqual([]);
    const cnOnly = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'], isEnabled: () => false, isEnabledFor: (m) => m === 'cn' });
    expect(plan([t], [cnOnly])).toEqual([]);
    expect(plan([tuple({ market: 'cn', country: 'CN', users: 3 })], [cnOnly]).map((p) => [p.provider, p.params.q])).toEqual([['activejobs', '后端工程师']]);
  });

  it('asks an adapter whether it is on once per market, not once per tuple', () => {
    const isEnabled = vi.fn(() => true);
    const tuples = seedTuples(robo, { INGEST_SEED_ROLES: '20', INGEST_SEED_CITIES_PER_COUNTRY: '2' });
    expect(tuples.length).toBeGreaterThan(10);
    planQueries(tuples, [adapter('activejobs', { isEnabled })]);
    expect(isEnabled).toHaveBeenCalledTimes(1);
  });

  it('cursor adapters, other markets and unsupported countries are skipped', () => {
    const t = tuple({ country: 'TW', city: 'Taipei', users: 6 });
    const planned = plan(
      [t],
      [
        adapter('activejobs', { supportsCountry: (c) => c !== 'TW' }),
        adapter('jsearch'),
        adapter('bank_robohire', { kind: 'cursor' }),
        adapter('usajobs', { markets: ['cn'] }),
        adapter('tw_gov_jobs', {
          supportsCountry: () => {
            throw new Error('no table');
          },
        }),
      ],
    );
    expect(new Set(planned.map((p) => p.provider))).toEqual(new Set(['jsearch']));
    expect(planned.find((p) => p.language === 'en')).toMatchObject({
      origin: 'demand',
      demandScore: 6,
      priority: priorityFor('demand', 6),
      params: { q: 'Backend engineer', taxonomyId: 'backend_engineer', country: 'TW', city: 'Taipei', datePosted: 'month' },
    });
  });

  it('market cn plans a search for country CN only', () => {
    const cnAdapter = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'] });
    const base = tuple({ market: 'cn', users: 1 });
    expect(plan([{ ...base, country: 'US' }], [cnAdapter])).toEqual([]);
    expect(plan([{ ...base, country: 'CN' }], [cnAdapter])).toHaveLength(1);
    // A search adapter that serves market intl only: nothing is planned for GoApply on it.
    expect(plan([{ ...base, country: 'CN' }], [adapter('jsearch'), adapter('activejobs')])).toEqual([]);
  });

  it('one posting, one market: a source that serves both markets is asked for mainland China by the mainland only', () => {
    const both = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'] });
    const intlOnly = adapter('jsearch');
    const china = tuple({ country: 'CN', city: 'Shanghai', users: 3 });
    // RoboApply's search for Shanghai: not on Active Jobs DB (its mainland rows are GoApply's, each would be billed and
    // dropped); still on JSearch, whose rows are RoboApply's alone.
    expect(plan([china], [both, intlOnly]).map((p) => [p.provider, p.market, p.params.country])).toEqual([['jsearch', 'intl', 'CN']]);
    expect(plan([tuple({ country: 'CN', users: 3 })], [both])).toEqual([]);
    // A typed title and a seed are no exception.
    expect(plan([tuple({ taxonomyId: null, q: 'Chief of staff', country: 'CN', users: 1 }), tuple({ country: 'CN', origin: 'seo_seed', users: 0 })], [both])).toEqual([]);
    // Every other country is planned on it as before, Hong Kong and Taiwan included (they are the international market's).
    for (const country of ['US', 'HK', 'TW', 'SG']) expect(plan([tuple({ country, users: 3 })], [both]).map((p) => p.params.country), country).toEqual([country]);
    // The mainland's own search for the same place is planned on it.
    expect(plan([tuple({ market: 'cn', country: 'CN', city: 'Shanghai', users: 3 })], [both]).map((p) => [p.provider, p.market])).toEqual([['activejobs', 'cn']]);
    // The rule is the source's two markets, not its id: the same adapter serving RoboApply only is asked for China.
    expect(plan([china], [adapter('activejobs')]).map((p) => p.provider)).toEqual(['activejobs']);
  });

  it('market cn: a title a person typed is never planned on a metered provider, only a taxonomy role\'s label is (JC-6: role text only)', () => {
    const metered = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'] });
    const perRequestCn = adapter('jsearch', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'] });
    const unmetered = adapter('usajobs', { markets: ['intl', 'cn'] });
    const typed = tuple({ market: 'cn', taxonomyId: null, q: '我想找上海的前端工作 13800000000', country: 'CN', users: 1 });
    expect(plan([typed], [metered, perRequestCn])).toEqual([]);
    // A source that costs nothing per call (our own index of a public source) still gets it as typed.
    expect(plan([typed], [metered, unmetered]).map((p) => [p.provider, p.params.q])).toEqual([['usajobs', typed.q]]);
    // The role of the taxonomy is planned on the metered source, as its Simplified Chinese label.
    expect(plan([tuple({ market: 'cn', country: 'CN', users: 1 })], [metered]).map((p) => [p.provider, p.params.q, p.params.taxonomyId, p.language])).toEqual([
      ['activejobs', '后端工程师', 'backend_engineer', 'zh-CN'],
    ]);
    // The international market is unchanged: a typed title goes to every source as typed.
    expect(plan([tuple({ taxonomyId: null, q: 'Chief of staff', users: 1 })], [metered, adapter('jsearch')]).map((p) => p.provider)).toEqual(['activejobs', 'jsearch']);
  });

  it('market cn is planned on Active Jobs DB only while its plan gate is open for the mainland (JC-6)', () => {
    let open = false;
    const activejobs = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'], isEnabled: () => true, isEnabledFor: (m) => m === 'intl' || open });
    const cn = tuple({ market: 'cn', country: 'CN', city: 'Shanghai', users: 3 });
    // Today's free plan: nothing is planned for the mainland.
    expect(plan([cn], [activejobs])).toEqual([]);
    // RoboApply is planned as before.
    expect(plan([tuple({ users: 3 })], [activejobs]).map((p) => [p.provider, p.market])).toEqual([['activejobs', 'intl']]);
    open = true;
    expect(plan([cn], [activejobs]).map((p) => [p.provider, p.market, p.params.q, p.params.country, p.params.city, p.params.datePosted])).toEqual([
      ['activejobs', 'cn', '后端工程师', 'CN', 'Shanghai', 'week'],
    ]);
    // GoApply has no SEO seeds, gate open or not.
    expect(seedTuples(go, {})).toEqual([]);
  });

  it('two tuples that are one search make one query, with the larger demand', () => {
    const planned = plan([tuple({ country: 'US', city: 'Taipei', users: 2 }), tuple({ country: 'TW', city: 'Taipei', users: 7 }), tuple({ country: 'TW', city: 'Taipei', origin: 'seo_seed', users: 0 })], [adapter('activejobs')]);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ provider: 'activejobs', demandScore: 7, origin: 'demand', params: { country: 'TW', city: 'Taipei' } });
    const keys = plan([tuple({ country: 'US', city: 'Taipei', users: 7 }), tuple({ country: 'TW', city: 'Taipei', users: 2 })], [adapter('jsearch')]).map((p) => `${p.provider}|${p.paramsHash}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('windows and texts of planned queries (JI-6, JT-3)', () => {
  it('6 users: three days; 2 users: a week; a remote tuple carries remote true', () => {
    const [hot] = plan([tuple({ city: 'Austin', users: 6 })], [adapter('jsearch')]);
    const [cold] = plan([tuple({ city: 'Austin', users: 2 })], [adapter('jsearch')]);
    expect(hot!.params).toEqual({ q: 'Backend engineer', taxonomyId: 'backend_engineer', country: 'US', city: 'Austin', datePosted: '3days' });
    expect(cold!.params).toEqual({ q: 'Backend engineer', taxonomyId: 'backend_engineer', country: 'US', city: 'Austin', datePosted: 'week' });
    expect(nextRunDelayMs({ origin: hot!.origin, demandScore: hot!.demandScore, consecutiveEmpty: 0, country: hot!.params.country })).toBe(6 * HOUR);
    expect(nextRunDelayMs({ origin: cold!.origin, demandScore: cold!.demandScore, consecutiveEmpty: 0, country: cold!.params.country })).toBe(24 * HOUR);
    const [remote] = plan([tuple({ remote: true, users: 6 })], [adapter('jsearch')]);
    expect(remote!.params).toEqual({ q: 'Backend engineer', taxonomyId: 'backend_engineer', country: 'US', remote: true, datePosted: '3days' });
    expect(paramsForTuple(tuple({ remote: true, users: 1 })).remote).toBe(true);
    expect('remote' in paramsForTuple(tuple({ users: 1 }))).toBe(false);
  });

  it('a Taiwan role with a Traditional label: one zh-Hant and one English JSearch query, both over a month; Active Jobs DB gets English only, over its own week', () => {
    for (const users of [2, 6]) {
      const planned = plan([tuple({ country: 'TW', city: 'Taipei', users })], [adapter('activejobs'), adapter('jsearch')]);
      expect(brief(planned)).toEqual([
        ['jsearch', '後端工程師', 'month', 'demand'],
        ['activejobs', 'Backend engineer', 'week', 'demand'],
        ['jsearch', 'Backend engineer', 'month', 'demand'],
      ]);
      const jsearch = planned.filter((p) => p.provider === 'jsearch');
      expect(jsearch.map((p) => p.language)).toEqual(['zh-TW', 'en']);
      expect(jsearch[0]!.paramsHash).not.toBe(jsearch[1]!.paramsHash);
      // The city stays the city table's English name; the adapter writes it in Chinese for the Chinese text.
      expect(planned.every((p) => p.params.city === 'Taipei' && p.params.country === 'TW' && p.params.taxonomyId === 'backend_engineer')).toBe(true);
      // Due again after 12 hours at either score.
      for (const p of planned) expect(nextRunDelayMs({ origin: p.origin, demandScore: p.demandScore, consecutiveEmpty: 0, country: p.params.country })).toBe(12 * HOUR);
    }
  });

  it('a Taiwan role without a Traditional label: the English query only', () => {
    const planned = plan([tuple({ taxonomyId: 'data_scientist', q: 'Data scientist', country: 'TW', users: 3 })], [adapter('activejobs'), adapter('jsearch')]);
    expect(brief(planned)).toEqual([
      ['activejobs', 'Data scientist', 'week', 'demand'],
      ['jsearch', 'Data scientist', 'month', 'demand'],
    ]);
  });

  it('a United States role: one English query per source, with the window of its demand where the source applies it', () => {
    expect(brief(plan([tuple({ users: 2 }), tuple({ taxonomyId: 'data_scientist', q: 'Data scientist', users: 9 })], [adapter('jsearch'), adapter('activejobs')]))).toEqual([
      ['jsearch', 'Backend engineer', 'week', 'demand'],
      ['activejobs', 'Backend engineer', 'week', 'demand'],
      ['jsearch', 'Data scientist', '3days', 'demand'],
      ['activejobs', 'Data scientist', 'week', 'demand'],
    ]);
  });

  it('the stored window is the one the source really asks for: Active Jobs DB always a week, JSearch the window of the demand', () => {
    // The Active Jobs DB client sends one fixed frame whatever datePosted says; JSearch sends datePosted.
    expect(['today', '3days', 'week', 'month', 'all'].map((w) => adapterDateWindow(adapter('activejobs'), w))).toEqual(['week', 'week', 'week', 'week', 'week']);
    expect(['today', '3days', 'week', 'month', 'all'].map((w) => adapterDateWindow(adapter('jsearch'), w))).toEqual(['today', '3days', 'week', 'month', 'all']);
    const sources = [adapter('activejobs'), adapter('jsearch')];
    const window = (planned: PlannedQuery[]) => Object.fromEntries(planned.filter((p) => p.language !== 'zh-TW').map((p) => [p.provider, p.params.datePosted]));
    expect(window(plan([tuple({ country: 'TW', city: 'Taipei', users: 2 })], sources))).toEqual({ activejobs: 'week', jsearch: 'month' });
    expect(window(plan([tuple({ users: 6 })], sources))).toEqual({ activejobs: 'week', jsearch: '3days' });
    expect(window(plan([tuple({ users: 2 })], sources))).toEqual({ activejobs: 'week', jsearch: 'week' });
    expect(window(plan([tuple({ origin: 'seo_seed', users: 0 })], sources))).toEqual({ activejobs: 'week' });
    // Only the window differs between the two rows of one tuple.
    const [a, j] = plan([tuple({ country: 'TW', city: 'Taipei', taxonomyId: 'data_scientist', q: 'Data scientist', users: 6 })], sources);
    expect({ ...a!.params, datePosted: 'month' }).toEqual(j!.params);
    expect(a!.paramsHash).toBe(j!.paramsHash);
    // An adapter that declares its windows is asked one of them: the wanted one, else its first.
    const declared = adapter('jsearch', { dateWindows: ['today', 'week'] });
    expect(plan([tuple({ users: 6 })], [declared])[0]!.params.datePosted).toBe('today');
    expect(plan([tuple({ users: 2 })], [declared])[0]!.params.datePosted).toBe('week');
    expect(plan([tuple({ users: 2 })], [adapter('activejobs', { dateWindows: [] })])[0]!.params.datePosted).toBe('week');
    expect(plan([tuple({ users: 6 })], [adapter('activejobs', { dateWindows: [] })])[0]!.params.datePosted).toBe('3days');
  });

  it('a live Active Jobs DB posting reached through Taiwan demand is not "missed" once it leaves the provider\'s seven days', () => {
    // The provider returns seven days. A posting ten days old was last stamped some runs ago only because
    // it left that frame; the missed-refresh rule reads the STORED window to know that.
    const [row] = plan([tuple({ country: 'TW', city: 'Taipei', taxonomyId: 'data_scientist', q: 'Data scientist', users: 2 })], [adapter('activejobs')]);
    const job = { lastSeenRun: 10, postedAt: new Date(NOW.getTime() - 10 * DAY), firstSeenAt: new Date(NOW.getTime() - 10 * DAY) };
    expect(isMissedTwice(job, { runCount: 14, datePosted: row!.params.datePosted }, NOW)).toBe(false);
    // Stored as the month the demand asks for, the same posting would be archived as removed by its source.
    expect(isMissedTwice(job, { runCount: 14, datePosted: datePostedFor({ origin: 'demand', demandScore: 2, country: 'TW' }) }, NOW)).toBe(true);
    // Inside the seven days the rule still works: two counted runs without the posting close it.
    const fresh = { lastSeenRun: 10, postedAt: new Date(NOW.getTime() - 3 * DAY), firstSeenAt: new Date(NOW.getTime() - 3 * DAY) };
    expect(isMissedTwice(fresh, { runCount: 12, datePosted: row!.params.datePosted }, NOW)).toBe(true);
  });

  it('a typed Taiwan title is planned as typed and nothing else, on every source, over a month where the source applies it', () => {
    const typed = tuple({ taxonomyId: null, q: '韌體工程師', country: 'TW', city: 'Hsinchu', users: 1 });
    const planned = plan([typed], [adapter('activejobs'), adapter('jsearch')]);
    expect(planned.map((p) => [p.provider, p.params.q, p.params.datePosted, p.language])).toEqual([
      ['activejobs', '韌體工程師', 'week', null],
      ['jsearch', '韌體工程師', 'month', null],
    ]);
    expect('taxonomyId' in planned[0]!.params).toBe(false);
  });

  it('a mainland role is asked in Simplified Chinese, and only of a source that reads it', () => {
    const cn = tuple({ market: 'cn', country: 'CN', users: 2 });
    expect(plan([cn], [adapter('jsearch', { markets: ['intl', 'cn'] })])).toEqual([]);
    expect(brief(plan([cn], [adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['zh-CN'] })]))).toEqual([['activejobs', '后端工程师', 'week', 'demand']]);
    // A source that reads no Traditional Chinese gets the English Taiwan query only, whatever its id.
    expect(brief(plan([tuple({ country: 'TW', users: 1 })], [adapter('jsearch', { queryLanguages: ['en'] })]))).toEqual([['jsearch', 'Backend engineer', 'month', 'demand']]);
  });
});

describe('which adapters a run plans', () => {
  const snapshot = (over: Partial<ProviderQuotaSnapshot>): ProviderQuotaSnapshot => ({
    provider: 'activejobs',
    plan: 'BASIC',
    requestsLimit: 25,
    requestsRemaining: 0,
    jobsLimit: 250,
    jobsRemaining: 0,
    resetAt: '2026-10-28T00:00:00.000Z',
    observedAt: '2026-10-10T01:00:00.000Z',
    lastStatus: 429,
    lastCallCost: null,
    state: 'exhausted',
    ...over,
  });

  it('a quota is closed while the provider says so and the reading still blocks calls: ingest\'s own rule for how long (cross-review, M3 gate)', () => {
    // A used-up plan: until the reset the provider stated.
    expect(quotaClosed(snapshot({}), NOW, {})).toBe(true);
    expect(quotaClosed(snapshot({ state: 'ok', requestsRemaining: 9773 }), NOW, {})).toBe(false);
    expect(quotaClosed(snapshot({ state: 'unknown' }), NOW, {})).toBe(false);
    // After the reset the reading says nothing about today.
    expect(quotaClosed(snapshot({}), new Date('2026-10-28T00:00:01.000Z'), {})).toBe(false);
    // A refused key or a missing subscription blocks for an hour after the answer, whatever reset its
    // headers carry (a 403 with quota headers: reset 18 days ahead). Ingest asks again after that hour,
    // so the planner must not keep the provider out of the plan until the reset.
    const halfAnHourAgo = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const sevenHoursAgo = new Date(NOW.getTime() - 7 * 3_600_000).toISOString();
    for (const refused of [{ state: 'not_subscribed' as const, lastStatus: 403 }, { state: 'unauthorized' as const, lastStatus: 401 }]) {
      expect(quotaClosed(snapshot({ ...refused, observedAt: halfAnHourAgo }), NOW, {})).toBe(true);
      expect(quotaClosed(snapshot({ ...refused, observedAt: sevenHoursAgo }), NOW, {})).toBe(false);
    }
    // No reset time stated: an hour after the reading, as ingest does.
    expect(quotaClosed(snapshot({ resetAt: null, observedAt: halfAnHourAgo }), NOW, {})).toBe(true);
    expect(quotaClosed(snapshot({ resetAt: null, observedAt: sevenHoursAgo }), NOW, {})).toBe(false);
    // INGEST_QUOTA_RECHECK_HOURS cuts any block short (a plan bought mid-period).
    expect(quotaClosed(snapshot({ observedAt: sevenHoursAgo }), NOW, { INGEST_QUOTA_RECHECK_HOURS: '6' })).toBe(false);
    expect(quotaClosed(snapshot({ observedAt: sevenHoursAgo }), NOW, { INGEST_QUOTA_RECHECK_HOURS: '12' })).toBe(true);
    expect(quotaClosed(null, NOW, {})).toBe(false);
    expect(quotaClosed(undefined, NOW, {})).toBe(false);
  });

  it('splits a brand\'s adapters into the ones planned and the ones left out', () => {
    const list = [
      adapter('activejobs', { isEnabled: () => false }),
      adapter('bank_robohire', { kind: 'cursor' }),
      adapter('jsearch'),
      adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], isEnabled: () => false }),
      adapter('bank_gohire', { kind: 'cursor', markets: ['cn'] }),
    ];
    const intl = plannableAdapters(list, 'intl');
    expect(intl.open.map((a) => a.provider)).toEqual(['bank_robohire', 'jsearch']);
    expect(intl.skipped).toEqual(['activejobs', 'ats_public']);
    const cn = plannableAdapters(list, 'cn');
    expect(cn.open.map((a) => a.provider)).toEqual(['bank_gohire']);
    expect(cn.skipped).toEqual(['ats_public']);
  });

  it('a metered search source is left out while the quota snapshot says it is closed; free and cursor sources are not gated by it', () => {
    const list = [adapter('activejobs'), adapter('jsearch'), adapter('usajobs'), adapter('bank_robohire', { kind: 'cursor' })];
    const quota = new Map<string, ProviderQuotaSnapshot>([
      ['activejobs', snapshot({})],
      ['usajobs', snapshot({ provider: 'usajobs' })],
      ['bank_robohire', snapshot({ provider: 'bank_robohire' })],
    ]);
    const closed = plannableAdapters(list, 'intl', quota, NOW);
    expect(closed.open.map((a) => a.provider)).toEqual(['jsearch', 'usajobs', 'bank_robohire']);
    expect(closed.skipped).toEqual(['activejobs']);
    // After the reset the same snapshot closes nothing.
    expect(plannableAdapters(list, 'intl', quota, new Date('2026-10-29T00:00:00.000Z')).skipped).toEqual([]);
    // A mainland reading (key `<provider>:cn`) closes the provider for market cn only.
    const both = [adapter('activejobs', { markets: ['intl', 'cn'] })];
    const cnQuota = new Map([['activejobs:cn', snapshot({ provider: 'activejobs:cn' })]]);
    expect(plannableAdapters(both, 'cn', cnQuota, NOW).skipped).toEqual(['activejobs']);
    expect(plannableAdapters(both, 'intl', cnQuota, NOW).skipped).toEqual([]);
  });

  it('names the search sources billed per request, on or off, of this market only', () => {
    const list = [adapter('jsearch', { isEnabled: () => false }), adapter('activejobs'), adapter('usajobs', { costModel: 'per_request' }), adapter('ats_public', { kind: 'cursor', costModel: 'per_request' }), adapter('tw_gov_jobs', { markets: ['cn'], costModel: 'per_request' })];
    expect(perRequestProviders(list, 'intl')).toEqual(['jsearch', 'usajobs']);
    expect(perRequestProviders(list, 'cn')).toEqual(['tw_gov_jobs']);
  });

  it('reads the stored quota snapshots; nothing stored, an unreadable value or a failed read is "nothing known"', async () => {
    const value = serializeProviderQuota([snapshot({})]);
    const stored = createFakePrisma({ seed: { appConfig: [{ id: 'a1', key: PROVIDER_QUOTA_CONFIG_KEY, value }] } });
    const read = await readQuotaSnapshots(stored as unknown as IngestDb);
    expect([...read.keys()]).toEqual(['activejobs']);
    expect(read.get('activejobs')).toMatchObject({ state: 'exhausted', plan: 'BASIC', resetAt: '2026-10-28T00:00:00.000Z' });
    expect((await readQuotaSnapshots(createFakePrisma() as unknown as IngestDb)).size).toBe(0);
    const garbled = createFakePrisma({ seed: { appConfig: [{ id: 'a1', key: PROVIDER_QUOTA_CONFIG_KEY, value: '{not json' }] } });
    expect((await readQuotaSnapshots(garbled as unknown as IngestDb)).size).toBe(0);
    const broken = createFakePrisma({ failOn: { 'appConfig.findUnique': new Error('relation "AppConfig" does not exist') } });
    expect((await readQuotaSnapshots(broken as unknown as IngestDb)).size).toBe(0);
  });
});

describe('database steps', () => {
  it('collects demand from active users of the brand only, counting distinct users', async () => {
    const db = createFakePrisma({
      seed: {
        user: [
          { id: 'u1', brand: 'roboapply', lastActiveAt: new Date(NOW.getTime() - 2 * 24 * HOUR) },
          { id: 'u2', brand: 'roboapply', lastActiveAt: new Date(NOW.getTime() - 3 * 24 * HOUR) },
          { id: 'u3', brand: 'roboapply', lastActiveAt: new Date(NOW.getTime() - 20 * 24 * HOUR) },
          { id: 'u4', brand: 'goapply', lastActiveAt: NOW },
        ],
        rASearchProfile: [
          { id: 'p1', userId: 'u1', isDefault: true, filters: { taxonomyIds: ['backend_engineer'], country: 'US' } },
          { id: 'p2', userId: 'u2', isDefault: true, filters: { taxonomyIds: ['backend_engineer'], country: 'US' } },
          { id: 'p2b', userId: 'u2', isDefault: false, filters: { taxonomyIds: ['data_scientist'], country: 'US' } },
          { id: 'p3', userId: 'u3', isDefault: true, filters: { taxonomyIds: ['data_scientist'], country: 'US' } },
          { id: 'p4', userId: 'u4', isDefault: true, filters: { taxonomyIds: ['data_scientist'], country: 'CN' } },
        ],
      },
    });
    const demand = await collectDemand(db as unknown as IngestDb, robo, NOW);
    expect(demand).toEqual([expect.objectContaining({ taxonomyId: 'backend_engineer', country: 'US', users: 2, market: 'intl' })]);
  });

  it('bulk-upserts planned queries on (provider, paramsHash), keeping schedules and bank/manual origins', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 1 } });
    const planned = plan([tuple({ taxonomyId: null, q: 'QA', users: 2 })], [adapter('jsearch')]);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW);
    const call = db.$sql.last()!;
    expect(call.text).toContain('INSERT INTO "RAIngestQuery"');
    expect(call.text).toContain('ON CONFLICT ("provider", "paramsHash") DO UPDATE SET');
    expect(call.text).toContain(`"nextRunAt" = CASE WHEN "RAIngestQuery"."enabled" THEN "RAIngestQuery"."nextRunAt" ELSE EXCLUDED."nextRunAt" END`);
    expect(call.text).toContain(`CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync')`);
    expect(call.values).toContain(planned[0]!.paramsHash);
    expect(call.values).toContain(JSON.stringify(planned[0]!.params));
    // The language of a planned query is not a column and is not sent.
    expect(call.values).not.toContain('en');
  });

  it('the daily plan rewrites the params in place (today\'s window, the current label) and keeps a stored cursor', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 1 } });
    const planned = plan([tuple({ users: 6 })], [adapter('jsearch')]);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW);
    const daily = db.$sql.last()!.text;
    expect(daily).toContain(
      `"params" = CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync') THEN "RAIngestQuery"."params" ELSE EXCLUDED."params" || jsonb_strip_nulls(jsonb_build_object('cursor', "RAIngestQuery"."params"->'cursor')) END`,
    );
    expect(daily).toContain(`"demandScore" = EXCLUDED."demandScore"`);
    expect(daily).not.toContain('GREATEST("RAIngestQuery"."demandScore"');
  });

  it('the daily plan restarts a query\'s counted runs when its window widens or its text changes, never for a standing query', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 1 } });
    await upsertPlannedQueries(db as unknown as IngestDb, plan([tuple({ users: 2 })], [adapter('jsearch')]), NOW);
    const daily = db.$sql.last()!.text;
    const days = (params: string) => `(CASE ${params}->>'datePosted' WHEN 'today' THEN 1 WHEN '3days' THEN 3 WHEN 'week' THEN 7 WHEN 'month' THEN 30 ELSE 100000 END)`;
    expect(daily).toContain(
      `"runCount" = CASE WHEN "RAIngestQuery"."origin" NOT IN ('manual', 'bank_sync') AND ("RAIngestQuery"."params"->>'q' IS DISTINCT FROM EXCLUDED."params"->>'q' OR ${days('EXCLUDED."params"')} > ${days('"RAIngestQuery"."params"')}) THEN 0 ELSE "RAIngestQuery"."runCount" END,`,
    );
    // The window table is part of the statement text, not of its values: 11 values per planned row.
    expect(db.$sql.last()!.values).toHaveLength(11);
  });

  it('the "planned today" stamp never moves backwards', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 1 } });
    const planned = plan([tuple({ users: 2 })], [adapter('jsearch')]);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW);
    expect(db.$sql.last()!.text).toContain(`"updatedAt" = GREATEST("RAIngestQuery"."updatedAt", EXCLUDED."updatedAt")`);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW, { targeted: true });
    expect(db.$sql.last()!.text).toContain(`"updatedAt" = GREATEST("RAIngestQuery"."updatedAt", EXCLUDED."updatedAt")`);
  });

  it('a targeted (onboarding) upsert only adds demand: an existing query keeps its score, its priority and its stored window', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 1 } });
    const planned = plan([tuple({ taxonomyId: null, q: 'QA', users: 1 })], [adapter('jsearch')]);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW, { targeted: true });
    const targeted = db.$sql.last()!.text;
    expect(targeted).toContain(`"demandScore" = GREATEST("RAIngestQuery"."demandScore", EXCLUDED."demandScore")`);
    expect(targeted).toContain(`ELSE LEAST("RAIngestQuery"."priority", EXCLUDED."priority") END`);
    // A hot query's three-day window is not replaced by the week of a one-user tuple.
    expect(targeted).toContain(`"params" = CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync') THEN "RAIngestQuery"."params" ELSE "RAIngestQuery"."params" END`);
    expect(targeted).not.toContain('EXCLUDED."params"');
    // Its params do not change, so its counted runs are not touched.
    expect(targeted).not.toContain('"runCount"');
  });

  it('writes in chunks of 200 and nothing for an empty plan', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 200 } });
    expect(await upsertPlannedQueries(db as unknown as IngestDb, [], NOW)).toBe(0);
    expect(db.$sql.calls).toHaveLength(0);
    const planned = planQueries(seedTuples(robo, { INGEST_SEED_ROLES: '150', INGEST_SEED_CITIES_PER_COUNTRY: '3' }), [adapter('activejobs')]);
    expect(planned).toHaveLength(450);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW);
    expect(db.$sql.calls).toHaveLength(3);
  });

  it('zeroes demand nobody asked for today and disables it after 30 unused days (never seeds)', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 0 } });
    await retireUnusedDemand(db as unknown as IngestDb, 'intl', NOW);
    expect(db.$sql.calls).toHaveLength(3);
    const [zero, , disable] = db.$sql.calls;
    expect(zero!.text).toContain(`SET "demandScore" = 0, "priority" = $1::int, "updatedAt" = now()`);
    expect(zero!.text).toContain(`"origin" = 'demand' AND "demandScore" > 0 AND "updatedAt" <`);
    expect(zero!.values).toEqual([priorityFor('demand', 0), 'intl', NOW, []]);
    expect(disable!.text).toContain(`SET "enabled" = false`);
    expect(disable!.text).toContain(`"origin" = 'demand'`);
    expect(disable!.text).toContain('make_interval(days =>');
    expect(disable!.values).toEqual(['intl', 30, []]);
  });

  it('a demand query at score 0 never keeps the hot window: it is widened to a week and its counted runs start again', async () => {
    const db = createFakePrisma({ sql: { respond: (call) => (call.text.includes('jsonb_set') ? 4 : 0) } });
    const result = await retireUnusedDemand(db as unknown as IngestDb, 'intl', NOW);
    expect(result).toEqual({ zeroed: 0, disabled: 0, widened: 4 });
    const widen = db.$sql.calls[1]!;
    // Every score-0 demand row, not only the ones zeroed in this run; the 30-day stamp is not touched.
    expect(widen.text).toBe(
      `UPDATE "RAIngestQuery" SET "params" = jsonb_set("params", '{datePosted}', $1::jsonb), "runCount" = 0 WHERE "market" = $2 AND "origin" = 'demand' AND "demandScore" = 0 AND "params"->>'datePosted' = $3 AND NOT ("provider" = ANY($4::text[]))`,
    );
    expect(widen.values).toEqual(['"week"', 'intl', '3days', []]);
    expect(widen.text).not.toContain('"updatedAt"');
  });

  it('leaves the demand of a source that was left out of the run alone', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 0 } });
    await retireUnusedDemand(db as unknown as IngestDb, 'intl', NOW, ['activejobs']);
    const [zero, widen, disable] = db.$sql.calls;
    expect(zero!.text).toContain('AND NOT ("provider" = ANY($4::text[]))');
    expect(zero!.values.at(-1)).toEqual(['activejobs']);
    expect(widen!.text).toContain('AND NOT ("provider" = ANY($4::text[]))');
    expect(widen!.values.at(-1)).toEqual(['activejobs']);
    expect(disable!.text).toContain('AND NOT ("provider" = ANY($3::text[]))');
    expect(disable!.values.at(-1)).toEqual(['activejobs']);
  });

  it('creates one standing sync query per cursor adapter that is on, without resetting a cursor', async () => {
    const db = createFakePrisma({ uniqueFields: { rAIngestQuery: ['paramsHash'] } });
    const bank = adapter('bank_robohire', { kind: 'cursor' });
    db.$rows('rAIngestQuery').push({ id: 'q1', provider: 'bank_robohire', paramsHash: paramsHash('intl', BANK_SYNC_PARAMS), params: { ...BANK_SYNC_PARAMS, cursor: 'c' } });
    expect(await ensureBankSyncQueries(db as unknown as IngestDb, 'intl', [bank, adapter('jsearch')])).toBe(0);
    expect(db.$rows('rAIngestQuery')).toHaveLength(1);
    expect((db.$rows('rAIngestQuery')[0]!.params as { cursor: string }).cursor).toBe('c');
    const fresh = createFakePrisma();
    expect(await ensureBankSyncQueries(fresh as unknown as IngestDb, 'intl', [bank])).toBe(1);
    expect(fresh.$rows('rAIngestQuery')[0]).toMatchObject({ provider: 'bank_robohire', origin: 'bank_sync', market: 'intl', paramsHash: paramsHash('intl', BANK_SYNC_PARAMS) });
  });

  it('a source read by a run of its own (ownRun: the employer boards) gets no standing query, and one planned earlier is switched off (MKT-3D request, M3 gate)', async () => {
    const boards = adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], ownRun: true });
    const bank = adapter('bank_gohire', { kind: 'cursor', markets: ['cn'] });
    const fake = createFakePrisma({ sql: { defaultResult: 0 } });
    expect(await ensureBankSyncQueries(fake as unknown as IngestDb, 'cn', [boards, bank])).toBe(1);
    expect(fake.$rows('rAIngestQuery').map((r) => [r.provider, r.market])).toEqual([['bank_gohire', 'cn']]);
    // First the boards' earlier standing query is switched off, then the bank's is (re)enabled.
    const [off, on] = fake.$sql.calls;
    expect(off!.text.replace(/\s+/g, ' ').trim()).toBe(`UPDATE "RAIngestQuery" SET "enabled" = false WHERE "market" = $1 AND "origin" = 'bank_sync' AND "enabled" = true AND "provider" = ANY($2::text[])`);
    expect(off!.values).toEqual(['cn', ['ats_public']]);
    expect(on!.values).toEqual(['cn', ['bank_gohire']]);
    // Alone in a market, the boards still get nothing and the statement still runs.
    const alone = createFakePrisma({ sql: { defaultResult: 0 } });
    expect(await ensureBankSyncQueries(alone as unknown as IngestDb, 'intl', [boards])).toBe(0);
    expect(alone.$rows('rAIngestQuery')).toHaveLength(0);
    expect(alone.$sql.calls.map((c) => c.values)).toEqual([['intl', ['ats_public']]]);
    // The real adapter declares it.
    const { createAtsPublicAdapter } = await import('../sources/atsPublic/adapter.js');
    expect(createAtsPublicAdapter({ env: {} }).ownRun).toBe(true);
  });

  it('a cursor adapter that is off gets no standing query, and its existing one is neither removed nor switched on', async () => {
    const off = adapter('bank_robohire', { kind: 'cursor', isEnabled: () => false });
    const boards = adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], isEnabledFor: (m) => m === 'cn' });
    const fresh = createFakePrisma({ sql: { defaultResult: 0 } });
    expect(await ensureBankSyncQueries(fresh as unknown as IngestDb, 'intl', [off, boards])).toBe(0);
    expect(fresh.$rows('rAIngestQuery')).toHaveLength(0);
    expect(fresh.$sql.calls).toHaveLength(0);
    // The same boards adapter is on for market cn.
    expect(await ensureBankSyncQueries(fresh as unknown as IngestDb, 'cn', [off, boards])).toBe(1);
    expect(fresh.$rows('rAIngestQuery').map((r) => [r.provider, r.market])).toEqual([['ats_public', 'cn']]);
    expect(fresh.$sql.last()!.values).toEqual(['cn', ['ats_public']]);
    // An existing query of the bank that is off stays exactly as it is.
    const held = createFakePrisma({ sql: { defaultResult: 0 } });
    held.$rows('rAIngestQuery').push({ id: 'q1', market: 'intl', provider: 'bank_robohire', origin: 'bank_sync', enabled: true, params: { ...BANK_SYNC_PARAMS, cursor: 'c' } });
    expect(await ensureBankSyncQueries(held as unknown as IngestDb, 'intl', [off])).toBe(0);
    expect(held.$rows('rAIngestQuery')).toEqual([{ id: 'q1', market: 'intl', provider: 'bank_robohire', origin: 'bank_sync', enabled: true, params: { ...BANK_SYNC_PARAMS, cursor: 'c' } }]);
  });

  it('switches off the queries of a provider the brand does not run, and switches a returning standing query on again', async () => {
    // Review case: linkedin left the registry; its seed and demand rows must not stay due for good.
    const db = createFakePrisma({ sql: { defaultResult: 3 } });
    const adapters = [adapter('jsearch'), adapter('activejobs', { isEnabled: () => false }), adapter('bank_robohire', { kind: 'cursor' }), adapter('bank_gohire', { kind: 'cursor', markets: ['cn'] })];
    expect(await retireUnrunProviders(db as unknown as IngestDb, 'intl', adapters)).toBe(3);
    const retire = db.$sql.last()!;
    expect(retire.text).toContain('UPDATE "RAIngestQuery" SET "enabled" = false');
    expect(retire.text).toContain('"market" = $1 AND "enabled" = true AND NOT ("provider" = ANY($2::text[]))');
    // Only the providers registered for THIS market count as run: a cn-only adapter does not keep an intl row alive.
    // A provider the brand runs but that is off right now is still "run": its queries wait.
    expect(retire.values).toEqual(['intl', ['jsearch', 'activejobs', 'bank_robohire']]);
    expect(retire.values[1]).not.toContain('linkedin');
    // Every origin is covered (seeds are never retired by the demand rule).
    expect(retire.text).not.toContain('"origin"');

    // A brand with no source at all keeps no query due.
    await retireUnrunProviders(db as unknown as IngestDb, 'cn', [adapter('jsearch')]);
    expect(db.$sql.last()!.values).toEqual(['cn', []]);
    // A source of the brand that is not in the list because its plan gate is closed right now is kept too (named once).
    await retireUnrunProviders(db as unknown as IngestDb, 'intl', adapters, ['activejobs_feed', 'jsearch']);
    expect(db.$sql.last()!.values).toEqual(['intl', ['jsearch', 'activejobs', 'bank_robohire', 'activejobs_feed']]);

    // The standing bank / board query of a provider that is back is enabled and made due.
    const fresh = createFakePrisma({ sql: { defaultResult: 1 } });
    await ensureBankSyncQueries(fresh as unknown as IngestDb, 'intl', [adapter('bank_robohire', { kind: 'cursor' }), adapter('jsearch')]);
    const revive = fresh.$sql.last()!;
    expect(revive.text).toContain('SET "enabled" = true, "nextRunAt" = now()');
    expect(revive.text).toContain(`"origin" = 'bank_sync' AND "enabled" = false AND "provider" = ANY(`);
    expect(revive.values).toEqual(['intl', ['bank_robohire']]);
  });

  it('retireSeedsFor: one statement switches off the market\'s enabled seed queries of the given providers', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 900 } });
    expect(await retireSeedsFor(db as unknown as IngestDb, 'intl', ['jsearch'])).toBe(900);
    expect(db.$sql.calls).toHaveLength(1);
    const call = db.$sql.last()!;
    expect(call.text).toBe(`UPDATE "RAIngestQuery" SET "enabled" = false WHERE "market" = $1 AND "origin" = 'seo_seed' AND "enabled" = true AND "provider" = ANY($2::text[])`);
    expect(call.values).toEqual(['intl', ['jsearch']]);
    // No per-request source: no statement at all.
    expect(await retireSeedsFor(db as unknown as IngestDb, 'intl', [])).toBe(0);
    expect(db.$sql.calls).toHaveLength(1);
  });

  it('retireSuperseded: on the planned providers, seeds the plan no longer names and demand hashed by the earlier recipe', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 4 } });
    expect(await retireSuperseded(db as unknown as IngestDb, 'intl', ['activejobs', 'jsearch'], NOW)).toBe(4);
    const call = db.$sql.last()!;
    expect(call.text).toContain('UPDATE "RAIngestQuery" SET "enabled" = false');
    expect(call.text).toContain('"market" = $1 AND "enabled" = true AND "provider" = ANY($2::text[])');
    expect(call.text).toContain(`("origin" = 'seo_seed' AND "updatedAt" < $3::timestamp(3))`);
    expect(call.text).toContain(`("origin" = 'demand' AND "paramsHash" NOT LIKE $4)`);
    // Manual queries and standing syncs are never named.
    expect(call.text).not.toContain('manual');
    expect(call.text).not.toContain('bank_sync');
    expect(call.values).toEqual(['intl', ['activejobs', 'jsearch'], NOW, `${QUERY_HASH_PREFIX}%`]);
    expect(await retireSuperseded(db as unknown as IngestDb, 'intl', [], NOW)).toBe(0);
    expect(db.$sql.calls).toHaveLength(1);
  });
});

// ── A whole plan run against a small model of the RAIngestQuery table ──────

interface QueryRow {
  id: string;
  market: string;
  provider: string;
  paramsHash: string;
  params: Record<string, unknown>;
  origin: string;
  demandScore: number;
  priority: number;
  enabled: boolean;
  nextRunAt: Date;
  updatedAt: Date;
  /** Counted runs (bumped by the ingest run; the clock of the missed-refresh rule). */
  runCount: number;
}

const EARLIER = new Date('2026-10-09T02:00:00.000Z');

const WINDOW_DAYS: Record<string, number> = { today: 1, '3days': 3, week: 7, month: 30 };
const windowDays = (datePosted: unknown): number => WINDOW_DAYS[String(datePosted)] ?? 100000;

function storedQuery(over: Partial<QueryRow> & Pick<QueryRow, 'id' | 'provider'>): QueryRow {
  return { market: 'intl', paramsHash: `old-${over.id}`, params: { q: 'Backend engineer', country: 'US', datePosted: 'week' }, origin: 'demand', demandScore: 1, priority: 50, enabled: true, nextRunAt: EARLIER, updatedAt: EARLIER, runCount: 0, ...over };
}

/**
 * A fake database whose raw SQL plays the planner's statements on the rows of
 * `rAIngestQuery` (the same store `createMany` writes to), so a run can be
 * followed by a second run. Each statement is recognised by its own text.
 */
function plannerDb(options: { queries?: QueryRow[]; seed?: Record<string, Record<string, unknown>[]> } = {}) {
  const fake = createFakePrisma({
    seed: { ...(options.seed ?? {}), rAIngestQuery: (options.queries ?? []).map((q) => ({ ...q })) },
    sql: { respond: (call) => play(call) },
  });
  const rows = () => fake.$rows('rAIngestQuery') as unknown as QueryRow[];
  // RAIngestQuery is unique on (provider, paramsHash): createMany({ skipDuplicates }) adds only what is missing.
  const delegate = (fake as unknown as { rAIngestQuery: { createMany(args: { data: QueryRow[]; skipDuplicates?: boolean }): Promise<{ count: number }> } }).rAIngestQuery;
  const createMany = delegate.createMany.bind(delegate);
  delegate.createMany = async (args) => createMany({ ...args, data: args.data.filter((d) => !rows().some((r) => r.provider === d.provider && r.paramsHash === d.paramsHash)) });
  const isStanding = (r: QueryRow) => r.origin === 'manual' || r.origin === 'bank_sync';
  function play(call: RecordedSql): number | undefined {
    const t = call.text;
    const v = call.values;
    if (t.startsWith('INSERT INTO "RAIngestQuery"')) {
      const targeted = t.includes('GREATEST("RAIngestQuery"."demandScore"');
      for (let i = 0; i + 11 <= v.length; i += 11) {
        const [id, market, provider, hash, params, origin, demandScore, priority, now] = v.slice(i, i + 11) as [string, string, string, string, string, string, number, number, Date];
        const prior = rows().find((r) => r.provider === provider && r.paramsHash === hash);
        if (!prior) {
          rows().push({ id, market, provider, paramsHash: hash, params: JSON.parse(params), origin, demandScore, priority, enabled: true, nextRunAt: now, updatedAt: now, runCount: 0 });
          continue;
        }
        prior.demandScore = targeted ? Math.max(prior.demandScore, demandScore) : demandScore;
        if (!isStanding(prior)) {
          prior.priority = targeted ? Math.min(prior.priority, priority) : priority;
          prior.origin = origin;
          if (!targeted) {
            const next = JSON.parse(params) as Record<string, unknown>;
            // A wider window or another text: the query's counted runs start again.
            if (next.q !== prior.params.q || windowDays(next.datePosted) > windowDays(prior.params.datePosted)) prior.runCount = 0;
            prior.params = { ...next, ...(prior.params.cursor != null ? { cursor: prior.params.cursor } : {}) };
          }
        }
        if (!prior.enabled) prior.nextRunAt = now;
        prior.enabled = true;
        // The stamp never moves backwards.
        if (prior.updatedAt < now) prior.updatedAt = now;
      }
      return v.length / 11;
    }
    const apply = (match: (r: QueryRow) => boolean, change: (r: QueryRow) => void): number => {
      const hit = rows().filter(match);
      hit.forEach(change);
      return hit.length;
    };
    if (t.startsWith('UPDATE "RAIngestQuery" SET "demandScore" = 0')) {
      const [priority, market, runStartedAt, skipped] = v as [number, string, Date, string[]];
      return apply(
        (r) => r.market === market && r.origin === 'demand' && r.demandScore > 0 && r.updatedAt < runStartedAt && !skipped.includes(r.provider),
        (r) => {
          r.demandScore = 0;
          r.priority = priority;
          r.updatedAt = new Date(runStartedAt.getTime() + 1);
        },
      );
    }
    if (t.startsWith('UPDATE "RAIngestQuery" SET "params" = jsonb_set(')) {
      const [idleWindow, market, hotWindow, skipped] = v as [string, string, string, string[]];
      return apply(
        (r) => r.market === market && r.origin === 'demand' && r.demandScore === 0 && r.params.datePosted === hotWindow && !skipped.includes(r.provider),
        (r) => {
          r.params = { ...r.params, datePosted: JSON.parse(idleWindow) };
          r.runCount = 0;
        },
      );
    }
    // The 30-day rule is about wall-clock days; no row of these runs is that old.
    if (t.includes('make_interval(days =>')) return 0;
    if (t.includes('"enabled" = true AND NOT ("provider" = ANY(')) {
      const [market, providers] = v as [string, string[]];
      return apply((r) => r.market === market && r.enabled && !providers.includes(r.provider), (r) => void (r.enabled = false));
    }
    if (t.includes(`"origin" = 'seo_seed' AND "enabled" = true AND "provider" = ANY(`)) {
      const [market, providers] = v as [string, string[]];
      return apply((r) => r.market === market && r.origin === 'seo_seed' && r.enabled && providers.includes(r.provider), (r) => void (r.enabled = false));
    }
    if (t.includes('"paramsHash" NOT LIKE')) {
      const [market, providers, runStartedAt, like] = v as [string, string[], Date, string];
      const prefix = like.replace(/%$/, '');
      return apply(
        (r) => r.market === market && r.enabled && providers.includes(r.provider) && ((r.origin === 'seo_seed' && r.updatedAt < runStartedAt) || (r.origin === 'demand' && !r.paramsHash.startsWith(prefix))),
        (r) => void (r.enabled = false),
      );
    }
    if (t.includes('SET "enabled" = true, "nextRunAt" = now()')) {
      const [market, providers] = v as [string, string[]];
      return apply((r) => r.market === market && r.origin === 'bank_sync' && !r.enabled && providers.includes(r.provider), (r) => void (r.enabled = true));
    }
    return undefined;
  }
  const enabled = (provider?: string) => rows().filter((r) => r.enabled && (!provider || r.provider === provider));
  return { db: fake as unknown as IngestDb, fake, rows, enabled };
}

const activeUser = (id: string) => ({ id, brand: 'roboapply', lastActiveAt: new Date(NOW.getTime() - HOUR) });
const profile = (userId: string, filters: Record<string, unknown>) => ({ id: `p-${userId}`, userId, isDefault: true, filters });
const SEED_ENV = { INGEST_SEED_ROLES: '2', INGEST_SEED_CITIES_PER_COUNTRY: '1' };

/** Every ingest source RoboApply has, on or off (providers.ts `knownIngestProvidersForBrand` with the boards registered). */
const KNOWN_ROBO: readonly string[] = ['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch', 'ats_public'];

/** The RoboApply adapter list of the parity wave, every source on. */
const roboAdapters = (over: Partial<Record<string, Partial<JobSourceAdapter>>> = {}): JobSourceAdapter[] => [
  adapter('activejobs', over.activejobs),
  adapter('bank_robohire', { kind: 'cursor', dailyCallLimit: () => null, ...over.bank_robohire }),
  adapter('jsearch', over.jsearch),
  adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['greenhouse'], dailyCallLimit: () => null, ...over.ats_public }),
];

describe('a plan run (runPlanner)', () => {
  it('default env and a brand with no users: no JSearch query, no LinkedIn query; seeds go to the per-job source', async () => {
    const { db, rows } = plannerDb();
    const adapters = roboAdapters();
    const result = await runPlanner(db, robo, adapters, { now: NOW, env: {}, queryLabels: labels });
    expect(result.demandTuples).toBe(0);
    expect(result.seedTuples).toBeGreaterThan(600);
    const byProvider = (provider: string) => rows().filter((r) => r.provider === provider);
    expect(byProvider('jsearch')).toEqual([]);
    expect(byProvider('linkedin')).toEqual([]);
    // Every seed is planned once, on Active Jobs DB (billed per job).
    expect(result.planned).toBe(result.seedTuples);
    expect(byProvider('activejobs')).toHaveLength(result.seedTuples);
    expect(byProvider('activejobs').every((r) => r.origin === 'seo_seed' && r.params.datePosted === 'week' && r.paramsHash.startsWith(QUERY_HASH_PREFIX))).toBe(true);
    // The two standing syncs, and nothing else.
    expect(rows().filter((r) => r.origin === 'bank_sync').map((r) => r.provider).sort()).toEqual(['ats_public', 'bank_robohire']);
    expect(result).toMatchObject({ bankQueries: 2, skippedProviders: [], seedsRetired: 0, superseded: 0, retired: 0 });
    for (const a of adapters) expect(a.fetch).not.toHaveBeenCalled();
  });

  it('with the taxonomy\'s own labels the default 900 seeds are all planned on the per-job source and none on JSearch', async () => {
    const { db, rows } = plannerDb();
    const result = await runPlanner(db, robo, roboAdapters(), { now: NOW, env: {} });
    expect(result.planned).toBe(result.seedTuples);
    expect(rows().filter((r) => r.provider === 'jsearch')).toEqual([]);
    expect(rows().filter((r) => r.provider === 'activejobs')).toHaveLength(result.seedTuples);
  });

  it('a demand tuple still plans a JSearch query', async () => {
    const { db, rows } = plannerDb({
      seed: { user: [activeUser('u1')], rASearchProfile: [profile('u1', { taxonomyIds: ['backend_engineer'], locations: [{ label: 'Austin, TX', city: 'Austin', country: 'US', radiusKm: 40 }] })] },
    });
    const result = await runPlanner(db, robo, roboAdapters(), { now: NOW, env: { INGEST_SEED_ROLES: '0' }, queryLabels: labels });
    expect(result).toMatchObject({ demandTuples: 1, seedTuples: 0, planned: 2, written: 2 });
    expect(rows().filter((r) => r.origin === 'demand').map((r) => [r.provider, r.params.q, r.params.city, r.params.datePosted, r.demandScore, r.priority])).toEqual([
      ['activejobs', 'Backend engineer', 'Austin', 'week', 1, 50],
      ['jsearch', 'Backend engineer', 'Austin', 'week', 1, 50],
    ]);
  });

  it('old JSearch seed queries are switched off by one run; a second run changes nothing', async () => {
    const queries = [
      storedQuery({ id: 's1', provider: 'jsearch', origin: 'seo_seed', demandScore: 0, priority: 200 }),
      storedQuery({ id: 's2', provider: 'jsearch', origin: 'seo_seed', demandScore: 0, priority: 200 }),
      storedQuery({ id: 's3', provider: 'jsearch', origin: 'seo_seed', demandScore: 0, priority: 200, market: 'cn' }),
      storedQuery({ id: 'm1', provider: 'jsearch', origin: 'manual', demandScore: 0, priority: 20 }),
    ];
    const { db, rows, enabled } = plannerDb({ queries });
    const first = await runPlanner(db, robo, roboAdapters(), { now: NOW, env: SEED_ENV, queryLabels: labels });
    expect(first.seedsRetired).toBe(2);
    expect(rows().filter((r) => r.id === 's1' || r.id === 's2').every((r) => !r.enabled)).toBe(true);
    // Another market's row and a manual query are not this rule's business.
    expect(rows().find((r) => r.id === 's3')!.enabled).toBe(true);
    expect(rows().find((r) => r.id === 'm1')!.enabled).toBe(true);
    expect(enabled('jsearch').map((r) => r.id).sort()).toEqual(['m1', 's3']);
    const snapshot = JSON.stringify(rows());
    const second = await runPlanner(db, robo, roboAdapters(), { now: new Date(NOW.getTime() + DAY), env: SEED_ENV, queryLabels: labels });
    expect(second).toMatchObject({ seedsRetired: 0, superseded: 0, retired: 0, zeroed: 0, bankQueries: 0 });
    // Only the "planned today" stamp of the planned seeds moved.
    const strip = (json: string) => JSON.parse(json).map(({ updatedAt: _u, ...rest }: QueryRow) => rest);
    expect(strip(JSON.stringify(rows()))).toEqual(strip(snapshot));
  });

  it('JSearch seeds are switched off even while JSearch itself is off', async () => {
    const { db, rows } = plannerDb({ queries: [storedQuery({ id: 's1', provider: 'jsearch', origin: 'seo_seed', demandScore: 0 })] });
    const result = await runPlanner(db, robo, roboAdapters({ jsearch: { isEnabled: () => false } }), { now: NOW, env: SEED_ENV, queryLabels: labels });
    expect(result).toMatchObject({ seedsRetired: 1, skippedProviders: ['jsearch'] });
    expect(rows().find((r) => r.id === 's1')!.enabled).toBe(false);
  });

  it('a source that is off is not planned and is reported; its queries are left alone; back on, the next run plans it', async () => {
    const queries = [
      storedQuery({ id: 'a-demand', provider: 'activejobs', demandScore: 3, priority: 50 }),
      storedQuery({ id: 'a-seed', provider: 'activejobs', origin: 'seo_seed', demandScore: 0, priority: 200 }),
    ];
    const seed = { user: [activeUser('u1')], rASearchProfile: [profile('u1', { taxonomyIds: ['backend_engineer'], country: 'US' })] };
    const { db, rows } = plannerDb({ queries, seed });
    const before = JSON.stringify(rows().filter((r) => r.provider === 'activejobs'));
    const off = await runPlanner(db, robo, roboAdapters({ activejobs: { isEnabled: () => false } }), { now: NOW, env: SEED_ENV, queryLabels: labels });
    expect(off.skippedProviders).toEqual(['activejobs']);
    // No new and no refreshed Active Jobs DB query; the stored ones keep score, window, stamp and switch.
    expect(JSON.stringify(rows().filter((r) => r.provider === 'activejobs'))).toBe(before);
    expect(rows().filter((r) => r.provider === 'jsearch').map((r) => r.origin)).toEqual(['demand']);
    expect(off.retired).toBe(0);

    const on = await runPlanner(db, robo, roboAdapters(), { now: new Date(NOW.getTime() + DAY), env: SEED_ENV, queryLabels: labels });
    expect(on.skippedProviders).toEqual([]);
    const planned = rows().filter((r) => r.provider === 'activejobs' && r.paramsHash.startsWith(QUERY_HASH_PREFIX));
    expect(planned.map((r) => r.origin).sort()).toEqual(['demand', 'seo_seed', 'seo_seed']);
    // The rows of the earlier recipe gave way to today's: nothing asks the provider twice.
    expect(on.superseded).toBe(2);
    expect(rows().filter((r) => r.id === 'a-demand' || r.id === 'a-seed').every((r) => !r.enabled)).toBe(true);
  });

  it('a provider whose quota is closed in the stored snapshot is not planned until its reset', async () => {
    const closed: ProviderQuotaSnapshot = {
      provider: 'activejobs', plan: 'BASIC', requestsLimit: 25, requestsRemaining: 0, jobsLimit: 250, jobsRemaining: 0,
      resetAt: '2026-10-28T00:00:00.000Z', observedAt: '2026-10-10T01:00:00.000Z', lastStatus: 429, lastCallCost: null, state: 'exhausted',
    };
    const seed = { appConfig: [{ id: 'a1', key: PROVIDER_QUOTA_CONFIG_KEY, value: serializeProviderQuota([closed]) }] };
    const { db, rows } = plannerDb({ seed });
    const during = await runPlanner(db, robo, roboAdapters(), { now: NOW, env: SEED_ENV, queryLabels: labels });
    expect(during.skippedProviders).toEqual(['activejobs']);
    expect(during.planned).toBe(0);
    expect(rows().filter((r) => r.provider === 'activejobs')).toEqual([]);
    const after = await runPlanner(db, robo, roboAdapters(), { now: new Date('2026-10-28T02:00:00.000Z'), env: SEED_ENV, queryLabels: labels });
    expect(after.skippedProviders).toEqual([]);
    expect(rows().filter((r) => r.provider === 'activejobs').length).toBe(after.planned);
    expect(after.planned).toBeGreaterThan(0);
  });

  it('a tuple that goes from 2 to 6 users keeps its one row, now asking for three days; back to nobody it widens again', async () => {
    const users = (n: number) => Array.from({ length: n }, (_, i) => activeUser(`u${i + 1}`));
    const profiles = (n: number) => Array.from({ length: n }, (_, i) => profile(`u${i + 1}`, { taxonomyIds: ['backend_engineer'], country: 'US' }));
    const env = { INGEST_SEED_ROLES: '0' };
    const adapters = [adapter('jsearch')];
    const { db, fake, rows } = plannerDb({ seed: { user: users(2), rASearchProfile: profiles(2) } });
    await runPlanner(db, robo, adapters, { now: NOW, env, queryLabels: labels });
    expect(rows().map((r) => [r.params.datePosted, r.demandScore, r.priority])).toEqual([['week', 2, 50]]);
    const id = rows()[0]!.id;

    fake.$rows('user').push(...users(6).slice(2));
    fake.$rows('rASearchProfile').push(...profiles(6).slice(2));
    const day2 = new Date(NOW.getTime() + DAY);
    await runPlanner(db, robo, adapters, { now: day2, env, queryLabels: labels });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id, demandScore: 6, priority: 10, enabled: true, params: { q: 'Backend engineer', country: 'US', datePosted: '3days' } });

    fake.$rows('rASearchProfile').length = 0;
    const result = await runPlanner(db, robo, adapters, { now: new Date(day2.getTime() + DAY), env, queryLabels: labels });
    expect(result.zeroed).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id, demandScore: 0, enabled: true, params: { datePosted: 'week' } });
  });

  describe('a rewrite in place and the missed-refresh rule', () => {
    const users = (n: number) => Array.from({ length: n }, (_, i) => activeUser(`u${i + 1}`));
    const profiles = (n: number) => Array.from({ length: n }, (_, i) => profile(`u${i + 1}`, { taxonomyIds: ['backend_engineer'], country: 'US' }));
    const env = { INGEST_SEED_ROLES: '0' };
    const day = (n: number) => new Date(NOW.getTime() + n * DAY);
    /** A hot JSearch query that has made 14 counted runs, and a posting it last returned at run 10, four days before `at`. */
    async function hotQuery() {
      const model = plannerDb({ seed: { user: users(6), rASearchProfile: profiles(6) } });
      await runPlanner(model.db, robo, [adapter('jsearch')], { now: NOW, env, queryLabels: labels });
      const row = model.rows()[0]!;
      expect(row.params.datePosted).toBe('3days');
      row.runCount = 14;
      const job = (at: Date) => ({ lastSeenRun: 10, postedAt: new Date(at.getTime() - 4 * DAY), firstSeenAt: new Date(at.getTime() - 4 * DAY) });
      const missed = (at: Date) => isMissedTwice(job(at), { runCount: row.runCount, datePosted: String(row.params.datePosted) }, at);
      return { ...model, row, missed };
    }

    it('hot to cold: a posting that only aged out of the three days is not closed by the wider window', async () => {
      const { db, fake, row, missed } = await hotQuery();
      // While the row says three days the rule's own guard protects the posting.
      expect(missed(day(0))).toBe(false);
      // Without the restart the same stamps would be judged against the week: closed although its source lists it.
      expect(isMissedTwice({ lastSeenRun: 10, postedAt: day(-4), firstSeenAt: day(-4) }, { runCount: 14, datePosted: 'week' }, day(0))).toBe(true);
      fake.$rows('rASearchProfile').length = 4;
      await runPlanner(db, robo, [adapter('jsearch')], { now: day(1), env, queryLabels: labels });
      expect(row).toMatchObject({ demandScore: 4, runCount: 0, params: { datePosted: 'week' } });
      expect(missed(day(1))).toBe(false);
      // Two counted runs of the week-wide query later it still is not: its stamp is older than the query as it is now.
      row.runCount = 2;
      expect(missed(day(1))).toBe(false);
      // A posting the week-wide query itself returned (run 1) and then missed twice is closed as before.
      row.runCount = 3;
      expect(isMissedTwice({ lastSeenRun: 1, postedAt: day(-1), firstSeenAt: day(-1) }, { runCount: row.runCount, datePosted: String(row.params.datePosted) }, day(2))).toBe(true);
    });

    it('hot to nobody: the widening to a week restarts the counted runs in the same plan', async () => {
      const { db, fake, row, missed } = await hotQuery();
      fake.$rows('rASearchProfile').length = 0;
      const result = await runPlanner(db, robo, [adapter('jsearch')], { now: day(1), env, queryLabels: labels });
      expect(result.zeroed).toBe(1);
      expect(row).toMatchObject({ demandScore: 0, runCount: 0, params: { datePosted: 'week' } });
      expect(missed(day(1))).toBe(false);
    });

    it('a narrower window, or the same one, keeps the counted runs', async () => {
      const model = plannerDb({ seed: { user: users(2), rASearchProfile: profiles(2) } });
      await runPlanner(model.db, robo, [adapter('jsearch')], { now: NOW, env, queryLabels: labels });
      const row = model.rows()[0]!;
      row.runCount = 9;
      await runPlanner(model.db, robo, [adapter('jsearch')], { now: day(1), env, queryLabels: labels });
      expect(row).toMatchObject({ runCount: 9, params: { datePosted: 'week' } });
      model.fake.$rows('user').push(...users(6).slice(2));
      model.fake.$rows('rASearchProfile').push(...profiles(6).slice(2));
      await runPlanner(model.db, robo, [adapter('jsearch')], { now: day(2), env, queryLabels: labels });
      expect(row).toMatchObject({ runCount: 9, params: { datePosted: '3days' } });
    });

    it('a corrected label restarts the counted runs: the new text returns other postings', async () => {
      const model = plannerDb({ seed: { user: users(2), rASearchProfile: profiles(2) } });
      await runPlanner(model.db, robo, [adapter('jsearch')], { now: NOW, env, queryLabels: labels });
      const row = model.rows()[0]!;
      row.runCount = 9;
      const corrected: QueryLabelSource = (roleId, options) => labels(roleId, options).map((l) => (l.text === 'Backend engineer' ? { ...l, text: 'Back-end engineer' } : l));
      await runPlanner(model.db, robo, [adapter('jsearch')], { now: day(1), env, queryLabels: corrected });
      expect(model.rows()).toHaveLength(1);
      expect(row).toMatchObject({ runCount: 0, params: { q: 'Back-end engineer', datePosted: 'week' } });
    });

    it('a targeted (onboarding) upsert never restarts the counted runs', async () => {
      const { db, row } = await hotQuery();
      const targeted = plan([tuple({ users: 1 })], [adapter('jsearch')]);
      expect(targeted[0]!.paramsHash).toBe(row.paramsHash);
      await upsertPlannedQueries(db, targeted, day(0), { targeted: true });
      expect(row).toMatchObject({ runCount: 14, demandScore: 6, params: { datePosted: '3days' } });
    });

    it('a score-0 row whose three-day window was written back by an ingest run in flight is put right by the next plan', async () => {
      const { db, fake, row } = await hotQuery();
      fake.$rows('rASearchProfile').length = 0;
      await runPlanner(db, robo, [adapter('jsearch')], { now: day(1), env, queryLabels: labels });
      const stamp = row.updatedAt;
      // The ingest run leased the row before the plan and finishes after it, writing the params it read.
      row.params = { ...row.params, datePosted: '3days' };
      row.runCount = 1;
      const next = await runPlanner(db, robo, [adapter('jsearch')], { now: day(2), env, queryLabels: labels });
      expect(next.zeroed).toBe(0);
      expect(row).toMatchObject({ demandScore: 0, runCount: 0, params: { datePosted: 'week' } });
      // The 30-day clock of the unused row did not start again.
      expect(row.updatedAt).toEqual(stamp);
    });
  });

  it('two plan runs that overlap: the earlier one writing last does not switch off today\'s seeds', async () => {
    const adapters = [adapter('activejobs')];
    const { db, rows, enabled } = plannerDb();
    const seeds = planQueries(seedTuples(robo, SEED_ENV), adapters, { queryLabels: labels });
    expect(seeds.length).toBeGreaterThan(0);
    const t1 = NOW;
    const t2 = new Date(NOW.getTime() + 20_000);
    // Run B (started later) writes first, run A (started earlier) writes the same rows after it.
    await upsertPlannedQueries(db, seeds, t2);
    await upsertPlannedQueries(db, seeds, t1);
    expect(rows().every((r) => r.updatedAt.getTime() === t2.getTime())).toBe(true);
    expect(await retireSuperseded(db, 'intl', ['activejobs'], t2)).toBe(0);
    expect(await retireSuperseded(db, 'intl', ['activejobs'], t1)).toBe(0);
    expect(enabled('activejobs')).toHaveLength(seeds.length);
    // The rule itself still works: a seed the plan stopped naming carries an older stamp.
    rows().push(storedQuery({ id: 'gone', provider: 'activejobs', origin: 'seo_seed', demandScore: 0, paramsHash: `${QUERY_HASH_PREFIX}gone` }));
    expect(await retireSuperseded(db, 'intl', ['activejobs'], t1)).toBe(1);
    expect(rows().find((r) => r.id === 'gone')!.enabled).toBe(false);
  });

  it('a Taiwan user: one Traditional Chinese and one English JSearch row, both over a month', async () => {
    const seed = { user: [activeUser('u1')], rASearchProfile: [profile('u1', { taxonomyIds: ['backend_engineer'], locations: [{ label: 'Taipei', city: 'Taipei', country: 'TW', radiusKm: 40 }] })] };
    const { db, rows } = plannerDb({ seed });
    const result = await runPlanner(db, robo, roboAdapters(), { now: NOW, env: { INGEST_SEED_ROLES: '0' }, queryLabels: labels });
    expect(result.planned).toBe(3);
    expect(rows().filter((r) => r.provider === 'jsearch').map((r) => [r.params.q, r.params.city, r.params.country, r.params.datePosted])).toEqual([
      ['後端工程師', 'Taipei', 'TW', 'month'],
      ['Backend engineer', 'Taipei', 'TW', 'month'],
    ]);
    // Active Jobs DB is asked its own seven days: the row says so (the missed-refresh rule reads it).
    expect(rows().filter((r) => r.provider === 'activejobs').map((r) => [r.params.q, r.params.datePosted])).toEqual([['Backend engineer', 'week']]);
  });

  it('the licensed feed on (a paid plan): the feed gets its standing query, the search adapter loses its seeds and keeps demand (JI-7)', async () => {
    const feed = (on: boolean) => adapter('activejobs_feed', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['activejobs'], dailyCallLimit: () => null, isEnabled: () => on });
    const seed = { user: [activeUser('u1')], rASearchProfile: [profile('u1', { taxonomyIds: ['backend_engineer'], country: 'US' })] };
    const { db, rows, enabled } = plannerDb({ seed });
    // Day 1, the free plan: the feed is not one of the brand's ingest adapters at all (providers.ts) and the seeds are planned.
    const day1 = await runPlanner(db, robo, roboAdapters(), { now: NOW, env: SEED_ENV, queryLabels: labels });
    expect(day1.seedTuples).toBe(2);
    expect(enabled('activejobs').map((r) => r.origin).sort()).toEqual(['demand', 'seo_seed', 'seo_seed']);
    expect(rows().some((r) => r.provider === 'activejobs_feed')).toBe(false);
    // Day 2, the plan was bought: the gate is open and the feed is in the list.
    const withFeed = [...roboAdapters(), feed(true)];
    const day2 = await runPlanner(db, robo, withFeed, { now: new Date(NOW.getTime() + DAY), env: SEED_ENV, queryLabels: labels });
    expect(enabled('activejobs').map((r) => r.origin)).toEqual(['demand']);
    expect(day2.superseded).toBe(2);
    expect(rows().filter((r) => r.provider === 'activejobs_feed').map((r) => [r.market, r.origin, r.enabled, r.params])).toEqual([['intl', 'bank_sync', true, BANK_SYNC_PARAMS]]);
    expect(day2.skippedProviders).toEqual([]);
    // Day 3, the gate is closed when the plan runs (the feed's own switch, a month's quota spent, a process that had
    // not loaded the stored reading): the feed is not in the run's list (providers.ts) but it is still a source of the
    // brand. Its standing query stays switched on with its cursor, so the first tick that finds the gate open goes on
    // reading; while the feed is off the seeds are planned again.
    rows().find((r) => r.provider === 'activejobs_feed')!.params = { ...BANK_SYNC_PARAMS, cursor: '{"v":1}' };
    const day3 = await runPlanner(db, robo, roboAdapters(), { now: new Date(NOW.getTime() + 2 * DAY), env: SEED_ENV, queryLabels: labels, knownProviders: KNOWN_ROBO });
    expect(day3.retired).toBe(0);
    expect(day3.skippedProviders).toEqual([]);
    expect(rows().find((r) => r.provider === 'activejobs_feed')).toMatchObject({ enabled: true, params: { cursor: '{"v":1}' } });
    expect(enabled('activejobs').map((r) => r.origin).sort()).toEqual(['demand', 'seo_seed', 'seo_seed']);
    // Day 4, open again: the same row with the cursor it had, and the seeds go.
    await runPlanner(db, robo, withFeed, { now: new Date(NOW.getTime() + 3 * DAY), env: SEED_ENV, queryLabels: labels, knownProviders: KNOWN_ROBO });
    expect(rows().filter((r) => r.provider === 'activejobs_feed')).toHaveLength(1);
    expect(rows().find((r) => r.provider === 'activejobs_feed')).toMatchObject({ enabled: true, params: { cursor: '{"v":1}' } });
    expect(enabled('activejobs').map((r) => r.origin)).toEqual(['demand']);
    // Day 5, the operator narrows the feed away (JOB_PROVIDERS_ROBOAPPLY): it is no source of the brand any more, and
    // only now is its query switched off (cursor kept); named again, the plan switches it on.
    const narrowed = KNOWN_ROBO.filter((p) => p !== 'activejobs_feed');
    const day5 = await runPlanner(db, robo, roboAdapters(), { now: new Date(NOW.getTime() + 4 * DAY), env: SEED_ENV, queryLabels: labels, knownProviders: narrowed });
    expect(day5.retired).toBe(1);
    expect(rows().find((r) => r.provider === 'activejobs_feed')).toMatchObject({ enabled: false, params: { cursor: '{"v":1}' } });
    await runPlanner(db, robo, withFeed, { now: new Date(NOW.getTime() + 5 * DAY), env: SEED_ENV, queryLabels: labels, knownProviders: KNOWN_ROBO });
    expect(rows().find((r) => r.provider === 'activejobs_feed')).toMatchObject({ enabled: true, params: { cursor: '{"v":1}' } });
    for (const a of withFeed) expect(a.fetch).not.toHaveBeenCalled();
  });

  it('a gate that is closed when the plan runs switches nothing off: the feed\'s standing query, and the mainland\'s Active Jobs DB demand with its score', async () => {
    const seed = { user: [{ id: 'g1', brand: 'goapply', lastActiveAt: NOW }, { id: 'g2', brand: 'goapply', lastActiveAt: NOW }], rASearchProfile: [profile('g1', { taxonomyIds: ['backend_engineer'], country: 'CN' }), profile('g2', { taxonomyIds: ['backend_engineer'], country: 'CN' })] };
    const base = [adapter('bank_gohire', { kind: 'cursor', markets: ['cn'], dailyCallLimit: () => null })];
    const search = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'] });
    const feed = adapter('activejobs_feed', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['activejobs'], dailyCallLimit: () => null });
    const known = ['bank_gohire', 'activejobs', 'activejobs_feed'];
    const { db, rows } = plannerDb({ seed });
    // 02:00 on a day the gate is open.
    await runPlanner(db, go, [...base, search, feed], { now: NOW, env: {}, queryLabels: labels, knownProviders: known });
    const demand = () => rows().find((r) => r.provider === 'activejobs' && r.origin === 'demand')!;
    const standing = () => rows().find((r) => r.provider === 'activejobs_feed')!;
    expect(demand()).toMatchObject({ market: 'cn', enabled: true, demandScore: 2, priority: 50 });
    standing().params = { ...BANK_SYNC_PARAMS, cursor: '{"v":1,"phase":"hourly"}' };
    // 02:00 the next day: the gate is closed at this hour, so providers.ts hands the run neither Active Jobs DB source.
    const closed = await runPlanner(db, go, base, { now: new Date(NOW.getTime() + DAY), env: {}, queryLabels: labels, knownProviders: known });
    expect(closed).toMatchObject({ planned: 0, retired: 0, zeroed: 0, skippedProviders: [] });
    // Neither is switched off, the demand keeps the score of the users behind it, the cursor is where it was.
    expect(demand()).toMatchObject({ enabled: true, demandScore: 2, priority: 50 });
    expect(standing()).toMatchObject({ enabled: true, params: { cursor: '{"v":1,"phase":"hourly"}' } });
    // The statements name them: kept by the retirement of unrun providers, left alone by the unused-demand rule.
    const sql = (db as unknown as { $sql: { calls: RecordedSql[] } }).$sql.calls;
    const unrun = sql.filter((c) => c.text.includes('"enabled" = true AND NOT ("provider" = ANY(')).at(-1)!;
    expect(unrun.values).toEqual(['cn', ['bank_gohire', 'activejobs', 'activejobs_feed']]);
    const zero = sql.filter((c) => c.text.startsWith('UPDATE "RAIngestQuery" SET "demandScore" = 0')).at(-1)!;
    expect(zero.values.at(-1)).toEqual(['activejobs', 'activejobs_feed']);
    // A provider that is no source of the brand is still switched off (a JSearch row left from the old mainland switch).
    rows().push(storedQuery({ id: 'old-js', provider: 'jsearch', market: 'cn' }));
    const again = await runPlanner(db, go, base, { now: new Date(NOW.getTime() + 2 * DAY), env: {}, queryLabels: labels, knownProviders: known });
    expect(again.retired).toBe(1);
    expect(rows().find((r) => r.id === 'old-js')!.enabled).toBe(false);
    expect([demand().enabled, standing().enabled]).toEqual([true, true]);
  });

  it('by default the brand\'s sources are the job source registry\'s: a source behind a plan is known while its gate is closed', async () => {
    // What cron hands the run on the free plan: the brand's own list. The registry also describes the feed.
    expect(knownIngestProvidersForBrand(robo, {})).toEqual(['activejobs', 'activejobs_feed', 'bank_robohire', 'jsearch']);
    expect(knownIngestProvidersForBrand(go, {})).toEqual(['bank_gohire', 'activejobs', 'activejobs_feed']);
    // Narrowed away: no source of the brand. JSearch and LinkedIn are never a mainland source.
    expect(knownIngestProvidersForBrand(robo, { JOB_PROVIDERS_ROBOAPPLY: 'activejobs,jsearch' })).toEqual(['activejobs', 'jsearch']);
    expect(knownIngestProvidersForBrand(go, { JOB_PROVIDERS_GOAPPLY: 'bank_gohire,jsearch,linkedin' })).toEqual(['bank_gohire']);
    const feedQuery = () => storedQuery({ id: 'feed', provider: 'activejobs_feed', origin: 'bank_sync', paramsHash: paramsHash('intl', BANK_SYNC_PARAMS), params: { ...BANK_SYNC_PARAMS, cursor: '{"v":1}' }, priority: 5 });
    const kept = plannerDb({ queries: [feedQuery(), storedQuery({ id: 'li', provider: 'linkedin' })] });
    const result = await runPlanner(kept.db, robo, roboAdapters(), { now: NOW, env: SEED_ENV, queryLabels: labels });
    // LinkedIn is retired as before; the feed's query waits for its gate.
    expect(result.retired).toBe(1);
    expect(kept.rows().find((r) => r.id === 'feed')).toMatchObject({ enabled: true, params: { cursor: '{"v":1}' } });
    expect(kept.rows().find((r) => r.id === 'li')!.enabled).toBe(false);
    // With the feed narrowed away by the operator it is retired like any provider the brand does not have.
    const gone = plannerDb({ queries: [feedQuery()] });
    await runPlanner(gone.db, robo, roboAdapters(), { now: NOW, env: { ...SEED_ENV, JOB_PROVIDERS_ROBOAPPLY: 'activejobs,bank_robohire,jsearch' }, queryLabels: labels });
    expect(gone.rows().find((r) => r.id === 'feed')!.enabled).toBe(false);
  });

  it('a list made before the stored quota reading was loaded lacks the feed although it is on: the run asks again, plans no seeds and creates the standing query', async () => {
    // The real registry and the real gate, open: a key and a paid plan's size.
    vi.stubEnv('RAPID_API_KEY', 'synthetic-rapidapi-key-0007');
    vi.stubEnv('FANTASTIC_MONTHLY_JOBS', '100000');
    for (const name of ['FANTASTIC_FEED_DISABLED', 'FANTASTIC_TRANSPORT', 'RA_ONBOARDING_EXTERNAL_JOBS_DISABLED', 'RA_ONBOARDING_ACTIVEJOBS_DISABLED', 'JOB_PROVIDERS_ROBOAPPLY']) vi.stubEnv(name, '');
    resetProviderQuotaForTests();
    try {
      expect(planAdaptersOnNow(robo, SEED_ENV).map((a) => a.provider)).toEqual(['activejobs_feed']);
      // What cron handed the run: RoboApply's own sources, listed while this process still knew no plan size.
      const stale = roboAdapters();
      const { db, rows, enabled } = plannerDb();
      const result = await runPlanner(db, robo, stale, { now: NOW, env: SEED_ENV, queryLabels: labels });
      // 2 seed tuples, none planned: the feed covers the board. Without this the day would buy seed searches per posting.
      expect(result).toMatchObject({ seedTuples: 2, planned: 0, retired: 0 });
      expect(enabled('activejobs')).toEqual([]);
      expect(rows().filter((r) => r.provider === 'activejobs_feed').map((r) => [r.market, r.origin, r.enabled])).toEqual([['intl', 'bank_sync', true]]);
      // A list that already holds the feed is taken as it is (the caller's adapter, once).
      const feed = adapter('activejobs_feed', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['activejobs'], dailyCallLimit: () => null });
      const fresh = plannerDb();
      await runPlanner(fresh.db, robo, [...roboAdapters(), feed], { now: NOW, env: SEED_ENV, queryLabels: labels });
      expect(fresh.rows().filter((r) => r.provider === 'activejobs_feed')).toHaveLength(1);
      // The gate closed (the feed's own switch): nothing joins, and the seeds are planned as on any day without a feed.
      vi.stubEnv('FANTASTIC_FEED_DISABLED', 'true');
      expect(planAdaptersOnNow(robo, SEED_ENV)).toEqual([]);
      const off = plannerDb();
      expect(await runPlanner(off.db, robo, roboAdapters(), { now: NOW, env: SEED_ENV, queryLabels: labels })).toMatchObject({ seedTuples: 2, planned: 2 });
      // Narrowed away by the operator: not asked at all.
      vi.stubEnv('FANTASTIC_FEED_DISABLED', '');
      expect(planAdaptersOnNow(robo, { ...SEED_ENV, JOB_PROVIDERS_ROBOAPPLY: 'activejobs,jsearch' })).toEqual([]);
      // GoApply: both Active Jobs DB sources stand behind the plan.
      expect(planAdaptersOnNow(go, {}).map((a) => a.provider)).toEqual(['activejobs', 'activejobs_feed']);
    } finally {
      vi.unstubAllEnvs();
      resetProviderQuotaForTests();
    }
  });

  it('GoApply with the plan gate open: the feed\'s mainland standing query and the role\'s Simplified Chinese search on Active Jobs DB; closed: neither (JC-6)', async () => {
    const seed = { user: [{ id: 'g1', brand: 'goapply', lastActiveAt: NOW }], rASearchProfile: [profile('g1', { taxonomyIds: ['backend_engineer'], country: 'CN' })] };
    const base = [adapter('bank_gohire', { kind: 'cursor', markets: ['cn'], dailyCallLimit: () => null }), adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'], ownRun: true, dailyCallLimit: () => null })];
    const search = adapter('activejobs', { markets: ['intl', 'cn'], queryLanguages: ['en', 'zh-CN'] });
    const feed = adapter('activejobs_feed', { kind: 'cursor', markets: ['intl', 'cn'], sourceBoards: ['activejobs'], dailyCallLimit: () => null });
    // Closed (today's free plan): providers.ts leaves both out of GoApply's list.
    const closed = plannerDb({ seed });
    const before = await runPlanner(closed.db, go, base, { now: NOW, env: {}, queryLabels: labels });
    expect(before).toMatchObject({ demandTuples: 1, planned: 0, seedTuples: 0 });
    expect(closed.rows().map((r) => r.provider)).toEqual(['bank_gohire']);
    // Open: both are in the list.
    const open = plannerDb({ seed });
    const after = await runPlanner(open.db, go, [...base, search, feed], { now: NOW, env: {}, queryLabels: labels });
    expect(after).toMatchObject({ demandTuples: 1, planned: 1, seedTuples: 0, skippedProviders: [] });
    expect(open.rows().map((r) => [r.provider, r.market, r.origin, r.params.q]).sort()).toEqual([
      ['activejobs', 'cn', 'demand', '后端工程师'],
      ['activejobs_feed', 'cn', 'bank_sync', ''],
      ['bank_gohire', 'cn', 'bank_sync', ''],
    ]);
    // No JSearch row, ever.
    expect(open.rows().some((r) => r.provider === 'jsearch')).toBe(false);
  });

  it('GoApply: no seed, no search query, the standing syncs of the sources that are on', async () => {
    const adapters = [adapter('bank_gohire', { kind: 'cursor', markets: ['cn'], isEnabled: () => false }), adapter('ats_public', { kind: 'cursor', markets: ['intl', 'cn'] }), adapter('jsearch')];
    const { db, rows } = plannerDb({ seed: { user: [{ id: 'g1', brand: 'goapply', lastActiveAt: NOW }], rASearchProfile: [profile('g1', { taxonomyIds: ['backend_engineer'], country: 'CN' })] } });
    const result = await runPlanner(db, go, adapters, { now: NOW, env: {}, queryLabels: labels });
    expect(result).toMatchObject({ demandTuples: 1, seedTuples: 0, planned: 0, bankQueries: 1, skippedProviders: ['bank_gohire'], seedsRetired: 0 });
    expect(rows().map((r) => [r.provider, r.market, r.origin])).toEqual([['ats_public', 'cn', 'bank_sync']]);
  });

  it('the statements of a run, in order: quota read, upsert, unused demand (zero, widen, disable), unrun providers, per-request seeds, superseded, standing syncs', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 2 } });
    const result = await runPlanner(db as unknown as IngestDb, robo, [adapter('jsearch'), adapter('activejobs'), adapter('bank_robohire', { kind: 'cursor' })], {
      now: NOW,
      env: { INGEST_SEED_ROLES: '1', INGEST_SEED_CITIES_PER_COUNTRY: '1' },
      queryLabels: labels,
    });
    expect(result).toMatchObject({ seedTuples: 1, planned: 1, written: 2, zeroed: 2, disabled: 2, retired: 2, seedsRetired: 2, superseded: 2, bankQueries: 1, skippedProviders: [] });
    const texts = db.$sql.calls.map((c) => c.text);
    const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
    const order = [
      at('INSERT INTO "RAIngestQuery"'),
      at('SET "demandScore" = 0'),
      at(`SET "params" = jsonb_set("params", '{datePosted}'`),
      at('make_interval(days =>'),
      at('"enabled" = true AND NOT ("provider" = ANY('),
      at(`"origin" = 'seo_seed' AND "enabled" = true AND "provider" = ANY(`),
      at('"paramsHash" NOT LIKE'),
      at('SET "enabled" = true, "nextRunAt" = now()'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(texts).toHaveLength(order.length);
    // The per-request seeds statement names JSearch only; the superseded statement names the planned search providers.
    expect(db.$sql.calls[order[5]!]!.values).toEqual(['intl', ['jsearch']]);
    expect(db.$sql.calls[order[6]!]!.values).toEqual(['intl', ['jsearch', 'activejobs'], NOW, `${QUERY_HASH_PREFIX}%`]);
  });

  it('never calls a provider', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 0 } });
    const adapters = roboAdapters();
    const result = await runPlanner(db as unknown as IngestDb, robo, adapters, { now: NOW, env: { INGEST_SEED_ROLES: '1', INGEST_SEED_CITIES_PER_COUNTRY: '1' }, queryLabels: labels });
    for (const a of adapters) expect(a.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ demandTuples: 0, seedTuples: 1, planned: 1 });
  });
});
