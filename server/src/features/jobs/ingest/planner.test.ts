// @vitest-environment node
// WP-16b: the demand-driven planner (ARCH §4.3) — refresh intervals and
// back-off, demand tuples from default profiles, SEO seeds, provider/country
// fan-out, the bulk upsert and the 30-day retirement of unused demand.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {}, prisma: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../../platform/brand/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import type { JobSourceAdapter } from '../sources/index.js';
import type { IngestDb } from './db.js';
import {
  BANK_SYNC_PARAMS,
  REFRESH,
  baseRefreshMs,
  collectDemand,
  ensureBankSyncQueries,
  mergeTuples,
  nextRunDelayMs,
  paramsHash,
  planQueries,
  primaryRole,
  priorityFor,
  retireUnrunProviders,
  retireUnusedDemand,
  runPlanner,
  seedTuples,
  tuplesFromFilters,
  upsertPlannedQueries,
  type DemandTuple,
} from './planner.js';

const HOUR = 3_600_000;
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

describe('refresh intervals and back-off', () => {
  it('uses 6 h for demand ≥ 5, 12 h for demand ≥ 1, 24 h for seeds, 30 min for bank syncs', () => {
    expect(baseRefreshMs({ origin: 'demand', demandScore: 5 })).toBe(6 * HOUR);
    expect(baseRefreshMs({ origin: 'demand', demandScore: 4 })).toBe(12 * HOUR);
    expect(baseRefreshMs({ origin: 'demand', demandScore: 1 })).toBe(12 * HOUR);
    expect(baseRefreshMs({ origin: 'seo_seed', demandScore: 0 })).toBe(24 * HOUR);
    expect(baseRefreshMs({ origin: 'demand', demandScore: 0 })).toBe(24 * HOUR);
    expect(baseRefreshMs({ origin: 'bank_sync', demandScore: 0 })).toBe(30 * 60_000);
  });

  it('doubles the interval from the 4th empty run on, capped at 7 days', () => {
    const q = { origin: 'demand', demandScore: 5 };
    expect(nextRunDelayMs({ ...q, consecutiveEmpty: 3 })).toBe(6 * HOUR);
    expect(nextRunDelayMs({ ...q, consecutiveEmpty: 4 })).toBe(12 * HOUR);
    expect(nextRunDelayMs({ ...q, consecutiveEmpty: 5 })).toBe(24 * HOUR);
    expect(nextRunDelayMs({ ...q, consecutiveEmpty: 6 })).toBe(48 * HOUR);
    expect(nextRunDelayMs({ ...q, consecutiveEmpty: 30 })).toBe(REFRESH.maxMs);
    expect(nextRunDelayMs({ origin: 'seo_seed', demandScore: 0, consecutiveEmpty: 8 })).toBe(REFRESH.maxMs);
    // Bank syncs never back off (a quiet bank is not a dead query).
    expect(nextRunDelayMs({ origin: 'bank_sync', demandScore: 0, consecutiveEmpty: 9 })).toBe(30 * 60_000);
  });

  it('runs bank syncs and hot demand before seeds', () => {
    expect(priorityFor('bank_sync', 0)).toBeLessThan(priorityFor('demand', 5));
    expect(priorityFor('demand', 5)).toBeLessThan(priorityFor('demand', 1));
    expect(priorityFor('demand', 1)).toBeLessThan(priorityFor('seo_seed', 0));
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
});

describe('seeds, merge and fan-out', () => {
  it('seeds the first N roles × the largest cities of each seed country (RoboApply only)', () => {
    const env = { INGEST_SEED_ROLES: '2', INGEST_SEED_CITIES_PER_COUNTRY: '2', INGEST_SEED_COUNTRIES: 'US,TW' };
    const seeds = seedTuples(robo, env);
    expect(seeds).toHaveLength(2 * 2 * 2);
    expect(seeds.filter((s) => s.country === 'TW').map((s) => s.city)).toEqual(['Taipei', 'New Taipei', 'Taipei', 'New Taipei']);
    expect(seeds.every((s) => s.origin === 'seo_seed' && s.users === 0)).toBe(true);
    expect(seedTuples(go, env)).toEqual([]);
  });

  it('demand wins over a seed for the same tuple', () => {
    const seed: DemandTuple = { market: 'intl', taxonomyId: 'backend_engineer', q: 'Backend engineer', country: 'US', city: 'Austin', origin: 'seo_seed', users: 0 };
    const merged = mergeTuples([{ ...seed, origin: 'demand', users: 3 }], [seed]);
    expect(merged).toEqual([{ ...seed, origin: 'demand', users: 3 }]);
  });

  it('plans one query per supporting search adapter; cursor adapters and unsupported countries are skipped', () => {
    const t: DemandTuple = { market: 'intl', taxonomyId: 'backend_engineer', q: 'Backend engineer', country: 'TW', city: 'Taipei', origin: 'demand', users: 6 };
    const planned = planQueries(
      [t],
      [
        adapter('activejobs', { supportsCountry: (c) => c !== 'TW' }),
        adapter('jsearch'),
        adapter('bank_robohire', { kind: 'cursor' }),
        adapter('linkedin', { markets: ['cn'] }),
      ],
    );
    expect(planned.map((p) => p.provider)).toEqual(['jsearch']);
    expect(planned[0]).toMatchObject({
      origin: 'demand',
      demandScore: 6,
      priority: priorityFor('demand', 6),
      params: { q: 'Backend engineer', taxonomyId: 'backend_engineer', country: 'TW', city: 'Taipei', datePosted: 'week' },
    });
  });

  it('GoApply plans external queries for country CN only', () => {
    const cnAdapter = adapter('jsearch', { markets: ['intl', 'cn'] });
    const base = { market: 'cn' as const, taxonomyId: null, q: 'Data analyst', origin: 'demand' as const, users: 1 };
    expect(planQueries([{ ...base, country: 'US' }], [cnAdapter])).toEqual([]);
    expect(planQueries([{ ...base, country: 'CN' }], [cnAdapter])).toHaveLength(1);
  });

  it('hashes params without the cursor and independent of key order', () => {
    expect(paramsHash('intl', { q: 'a', country: 'US', datePosted: 'week' })).toBe(paramsHash('intl', { datePosted: 'week', country: 'US', q: 'a', cursor: 'x' }));
    expect(paramsHash('intl', { q: 'a', country: 'US', datePosted: 'week' })).not.toBe(paramsHash('intl', { q: 'a', country: 'TW', datePosted: 'week' }));
  });

  it('keeps the market in a query\'s identity, so both brands can plan the same JSearch CN params', () => {
    const params = { q: 'Data analyst', country: 'CN', datePosted: 'week' };
    expect(paramsHash('intl', params)).not.toBe(paramsHash('cn', params));
    const js = adapter('jsearch', { markets: ['intl', 'cn'] });
    const base = { taxonomyId: null, q: 'Data analyst', country: 'CN', origin: 'demand' as const, users: 1 };
    const [intl] = planQueries([{ ...base, market: 'intl' }], [js]);
    const [cn] = planQueries([{ ...base, market: 'cn' }], [js]);
    expect(intl!.params).toEqual(cn!.params);
    expect(intl!.paramsHash).not.toBe(cn!.paramsHash);
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
    const planned = planQueries([{ market: 'intl', taxonomyId: null, q: 'QA', country: 'US', origin: 'demand', users: 2 }], [adapter('jsearch')]);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW);
    const call = db.$sql.last()!;
    expect(call.text).toContain('INSERT INTO "RAIngestQuery"');
    expect(call.text).toContain('ON CONFLICT ("provider", "paramsHash") DO UPDATE SET');
    expect(call.text).toContain(`"nextRunAt" = CASE WHEN "RAIngestQuery"."enabled" THEN "RAIngestQuery"."nextRunAt" ELSE EXCLUDED."nextRunAt" END`);
    expect(call.text).toContain(`CASE WHEN "RAIngestQuery"."origin" IN ('manual', 'bank_sync')`);
    expect(call.values).toContain(planned[0]!.paramsHash);
    expect(call.values).toContain(JSON.stringify(planned[0]!.params));
  });

  it('a targeted (onboarding) upsert only adds demand: an existing hot query keeps its score and priority', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 1 } });
    const planned = planQueries([{ market: 'intl', taxonomyId: null, q: 'QA', country: 'US', origin: 'demand', users: 1 }], [adapter('jsearch')]);
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW, { targeted: true });
    const targeted = db.$sql.last()!.text;
    expect(targeted).toContain(`"demandScore" = GREATEST("RAIngestQuery"."demandScore", EXCLUDED."demandScore")`);
    expect(targeted).toContain(`ELSE LEAST("RAIngestQuery"."priority", EXCLUDED."priority") END`);
    // The daily plan stays authoritative (it recounts users).
    await upsertPlannedQueries(db as unknown as IngestDb, planned, NOW);
    const daily = db.$sql.last()!.text;
    expect(daily).toContain(`"demandScore" = EXCLUDED."demandScore"`);
    expect(daily).not.toContain('GREATEST');
  });

  it('zeroes demand nobody asked for today and disables it after 30 unused days (never seeds)', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 0 } });
    await retireUnusedDemand(db as unknown as IngestDb, 'intl', NOW);
    const [zero, disable] = db.$sql.calls;
    expect(zero!.text).toContain(`"origin" = 'demand' AND "demandScore" > 0 AND "updatedAt" <`);
    expect(disable!.text).toContain(`SET "enabled" = false`);
    expect(disable!.text).toContain(`"origin" = 'demand'`);
    expect(disable!.text).toContain('make_interval(days =>');
    expect(disable!.values).toContain(30);
  });

  it('creates one standing bank-sync query per bank without resetting a cursor', async () => {
    const db = createFakePrisma({ uniqueFields: { rAIngestQuery: ['paramsHash'] } });
    const bank = adapter('bank_robohire', { kind: 'cursor' });
    db.$rows('rAIngestQuery').push({ id: 'q1', provider: 'bank_robohire', paramsHash: paramsHash('intl', BANK_SYNC_PARAMS), params: { ...BANK_SYNC_PARAMS, cursor: 'c' } });
    expect(await ensureBankSyncQueries(db as unknown as IngestDb, 'intl', [bank, adapter('jsearch')])).toBe(0);
    expect(db.$rows('rAIngestQuery')).toHaveLength(1);
    expect((db.$rows('rAIngestQuery')[0]!.params as { cursor: string }).cursor).toBe('c');
    const fresh = createFakePrisma();
    expect(await ensureBankSyncQueries(fresh as unknown as IngestDb, 'intl', [bank])).toBe(1);
    expect(fresh.$rows('rAIngestQuery')[0]).toMatchObject({ provider: 'bank_robohire', origin: 'bank_sync', market: 'intl' });
  });

  it('switches off the queries of a provider the brand does not run, and switches a returning standing query on again', async () => {
    // Review case: linkedin left the registry; its seed and demand rows must not stay due for good.
    const db = createFakePrisma({ sql: { defaultResult: 3 } });
    const adapters = [adapter('jsearch'), adapter('activejobs'), adapter('bank_robohire', { kind: 'cursor' }), adapter('bank_gohire', { kind: 'cursor', markets: ['cn'] })];
    expect(await retireUnrunProviders(db as unknown as IngestDb, 'intl', adapters)).toBe(3);
    const retire = db.$sql.last()!;
    expect(retire.text).toContain('UPDATE "RAIngestQuery" SET "enabled" = false');
    expect(retire.text).toContain('"market" = $1 AND "enabled" = true AND NOT ("provider" = ANY($2::text[]))');
    // Only the providers registered for THIS market count as run: a cn-only adapter does not keep an intl row alive.
    expect(retire.values).toEqual(['intl', ['jsearch', 'activejobs', 'bank_robohire']]);
    expect(retire.values[1]).not.toContain('linkedin');
    // Every origin is covered (seeds are never retired by the demand rule).
    expect(retire.text).not.toContain('"origin"');

    // A brand with no source at all keeps no query due.
    await retireUnrunProviders(db as unknown as IngestDb, 'cn', [adapter('jsearch')]);
    expect(db.$sql.last()!.values).toEqual(['cn', []]);

    // The standing bank / board query of a provider that is back is enabled and made due.
    const fresh = createFakePrisma({ sql: { defaultResult: 1 } });
    await ensureBankSyncQueries(fresh as unknown as IngestDb, 'intl', [adapter('bank_robohire', { kind: 'cursor' }), adapter('jsearch')]);
    const revive = fresh.$sql.last()!;
    expect(revive.text).toContain('SET "enabled" = true, "nextRunAt" = now()');
    expect(revive.text).toContain(`"origin" = 'bank_sync' AND "enabled" = false AND "provider" = ANY(`);
    expect(revive.values).toEqual(['intl', ['bank_robohire']]);
  });

  it('a plan run retires after planning and before the standing queries are ensured', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 2 } });
    const result = await runPlanner(db as unknown as IngestDb, robo, [adapter('jsearch'), adapter('bank_robohire', { kind: 'cursor' })], {
      now: NOW,
      env: { INGEST_SEED_ROLES: '1', INGEST_SEED_CITIES_PER_COUNTRY: '1' },
    });
    expect(result.retired).toBe(2);
    const texts = db.$sql.calls.map((c) => c.text);
    const upsert = texts.findIndex((t) => t.includes('INSERT INTO "RAIngestQuery"'));
    const retire = texts.findIndex((t) => t.includes('NOT ("provider" = ANY('));
    const revive = texts.findIndex((t) => t.includes('SET "enabled" = true, "nextRunAt" = now()'));
    expect(upsert).toBeGreaterThanOrEqual(0);
    expect(retire).toBeGreaterThan(upsert);
    expect(revive).toBeGreaterThan(retire);
  });

  it('runPlanner never calls a provider', async () => {
    const db = createFakePrisma({ sql: { defaultResult: 0 } });
    const a = adapter('jsearch');
    const result = await runPlanner(db as unknown as IngestDb, robo, [a], { now: NOW, env: { INGEST_SEED_ROLES: '1', INGEST_SEED_CITIES_PER_COUNTRY: '1' } });
    expect(a.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ demandTuples: 0, seedTuples: 1, planned: 1 });
  });
});
