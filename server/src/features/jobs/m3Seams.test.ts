// @vitest-environment node
//
// server/src/features/jobs/m3Seams.test.ts — the cross-bundle acceptance lines
// of market wave M3, on the merged tree (MARKET_TASK_PLAN.md, "Gates between
// phases", row "M3 merge"). Each side was built in its own worktree against
// the written contract; these tests run the REAL producer into the REAL
// consumer. No database, no network: the board list is a fake Prisma, the
// adapters are asked for their request parameters only (nothing is fetched).
//
//   JI-5  MKT-3C writes `atsPostingKey` on a normalized posting; MKT-3D's
//         discovery reads it from the hook object and proposes the board.
//   JT-3  MKT-3B plans a Taiwan tuple as a zh-Hant and an English query, both
//         over a month; MKT-3A's adapter builds the zh-TW request from it;
//         MKT-3E's Traditional labels are the text.
//   JT-2  MKT-3E's sweep is a cursor source of RoboApply only, free of
//         charge, with the attribution hook set registered third.
//   JI-3  the employer boards are read by their own cron, with one schedule
//         in the three places a deployment reads it, and no standing query.
//   JI-1  the board run (MKT-3D) writes the day's counters that MKT-3F's
//         provider table prints for `ats_public` and `ats_public:cn`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../platform/brand/index.js';
import { createBudget } from '../../platform/queue/index.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { buildProviderRows } from '../admin/system.js';
import { runBoardSync } from './ingest/boards.js';
import { createRapidApiAdapter, rapidApiSearchParams } from './ingest/adapters/rapidApi.js';
import { nextRunDelayMs, planQueries, queryVariants, type DemandTuple } from './ingest/planner.js';
import { adaptersForBrand } from './ingest/providers.js';
import { MARKET_HOOK_SETS, type MarketHookJob } from './marketHooks.js';
import { asMarketHookJob, normalizeProviderJob } from './normalize/index.js';
import { createAtsPublicHooks } from './sources/atsPublic/hooks.js';
import { createBoardDiscovery } from './sources/atsPublic/discovery.js';
import { adapterCostModel, getSourceAdapter } from './sources/index.js';
import { taxonomyLabel } from './taxonomy/index.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const HOUR = 3_600_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('JI-5: the posting key MKT-3C writes is the one MKT-3D discovery reads', () => {
  const jsearchRow = {
    externalId: 'jsearch:abc123',
    title: 'Backend Engineer',
    company: 'Acme',
    description: 'Build services.',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123?gh_src=x',
    sourceUrl: 'https://www.google.com/search?q=acme+jobs',
    location: 'Austin, TX',
    fetchedAt: NOW,
  };

  it('a JSearch row that links to a board carries the key on the hook object, and the board is proposed as a candidate that says which row named it', async () => {
    const normalized = normalizeProviderJob(jsearchRow, 'jsearch', { market: 'intl', now: NOW });
    expect(normalized.atsPostingKey).toBe('greenhouse:acme:123');
    const job = asMarketHookJob(normalized) as MarketHookJob;
    expect(job.atsPostingKey).toBe('greenhouse:acme:123');

    const fake = createFakePrisma();
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    const hooks = createAtsPublicHooks({ discover: (j, ctx) => discovery.note(j, ctx) });
    const ctx = { brand: 'roboapply' as const, market: 'intl' as const, stage: 'ingest' as const };
    // The ats_public hook set takes every ingested posting of any provider (that is how discovery sees a JSearch row).
    expect(hooks.appliesTo(job, ctx)).toBe(true);
    await hooks.afterNormalize!(job, ctx);
    const rows = fake.$rows('rACareerSiteSource');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', origin: 'discovered', discoveredFrom: `${normalized.sourceBoard}:${normalized.externalId}`, enabled: false, countries: [] });
    expect(discovery.stats()).toMatchObject({ offered: 1 });
  });

  it('the candidate\'s board token is the tenant as the link writes it: a Lever site with a capital letter is not proposed in lower case (its API answers 404 for that)', async () => {
    const lever = normalizeProviderJob({ ...jsearchRow, externalId: 'jsearch:lv1', company: 'SomeCo', applyUrl: 'https://jobs.lever.co/SomeCo/0f8fad5b-d9cb-469f-a165-70867728950e/apply' }, 'jsearch', { market: 'intl', now: NOW });
    // The key is the lower-case identity; the request token is not built from it.
    expect(lever.atsPostingKey).toBe('lever:someco:0f8fad5b-d9cb-469f-a165-70867728950e');
    const fake = createFakePrisma();
    const discovery = createBoardDiscovery({ db: () => fake as never, env: {} });
    expect(await discovery.note(asMarketHookJob(lever) as MarketHookJob, { stage: 'ingest' })).toBe('offered');
    expect(fake.$rows('rACareerSiteSource')).toMatchObject([{ ats: 'lever', boardToken: 'SomeCo', companyName: 'SomeCo', origin: 'discovered', enabled: false }]);
    // The same board in another spelling is still one board (compared by the key, case-insensitively).
    const again = normalizeProviderJob({ ...jsearchRow, externalId: 'jsearch:lv2', company: 'SomeCo', applyUrl: 'https://jobs.lever.co/someco/1f8fad5b-d9cb-469f-a165-70867728950e' }, 'jsearch', { market: 'intl', now: NOW });
    expect(await discovery.note(asMarketHookJob(again) as MarketHookJob, { stage: 'ingest' })).toBe('known');
    expect(fake.$rows('rACareerSiteSource')).toHaveLength(1);
    // A hook object that carries the key and no link (an older caller) keeps the key's own spelling.
    const bare = createFakePrisma();
    const keyOnly = createBoardDiscovery({ db: () => bare as never, env: {} });
    await keyOnly.note({ market: 'intl', provider: 'jsearch', atsPostingKey: 'lever:someco:0f8fad5b-d9cb-469f-a165-70867728950e', companyName: 'SomeCo' } as MarketHookJob, { stage: 'ingest' });
    expect(bare.$rows('rACareerSiteSource')).toMatchObject([{ boardToken: 'someco' }]);
  });

  it('the board row of the same posting carries the same key (so the two collapse), and our own board rows never propose a board', async () => {
    const boardRow = normalizeProviderJob(
      { externalId: 'acme:123', sourceBoard: 'greenhouse', title: 'Backend Engineer (Platform)', company: 'Acme', description: 'Build services.', applyUrl: 'https://acme.example/careers?gh_jid=123', location: 'Austin, TX', fetchedAt: NOW },
      'ats_public',
      { market: 'intl', now: NOW },
    );
    const aggregator = normalizeProviderJob(jsearchRow, 'jsearch', { market: 'intl', now: NOW });
    expect(boardRow.atsPostingKey).toBe(aggregator.atsPostingKey);
    // The canonical row of the pair is the board's (strategy 1.5: ats_public 5, jsearch 30).
    expect(boardRow.sourcePriority).toBeLessThan(aggregator.sourcePriority);
    const db = vi.fn();
    const discovery = createBoardDiscovery({ db: db as never, env: {} });
    expect(await discovery.note(asMarketHookJob(boardRow) as MarketHookJob, { stage: 'ingest' })).toBe('ignored');
    expect(db).not.toHaveBeenCalled();
  });
});

describe('JT-3: a Taiwan tuple is planned twice, and the adapter builds the zh-TW request', () => {
  const tuple: DemandTuple = { market: 'intl', taxonomyId: 'software_engineer', q: 'Software engineer', country: 'TW', city: 'Taipei', origin: 'demand', users: 2 };
  const jsearch = createRapidApiAdapter('jsearch', { isEnabled: () => true });
  const activejobs = createRapidApiAdapter('activejobs', { isEnabled: () => true });

  it('with MKT-3E\'s Traditional label: one zh-Hant and one English JSearch query, both over a month; Active Jobs DB gets the English one over its own week', () => {
    // The text is the taxonomy's own Taiwan label (MKT-3E), never a conversion of the Simplified one.
    expect(taxonomyLabel('software_engineer', 'zh-TW')).toBe('軟體工程師');
    expect(queryVariants(tuple).map((v) => v.language)).toEqual(['zh-TW', 'en']);

    const planned = planQueries([tuple], [activejobs, jsearch]);
    const onJSearch = planned.filter((p) => p.provider === 'jsearch');
    expect(onJSearch.map((p) => [p.language, p.params.q, p.params.country, p.params.city, p.params.datePosted])).toEqual([
      ['zh-TW', '軟體工程師', 'TW', 'Taipei', 'month'],
      ['en', 'Software engineer', 'TW', 'Taipei', 'month'],
    ]);
    // Two rows, two identities.
    expect(new Set(onJSearch.map((p) => p.paramsHash)).size).toBe(2);
    const onActiveJobs = planned.filter((p) => p.provider === 'activejobs');
    expect(onActiveJobs.map((p) => [p.language, p.params.datePosted])).toEqual([['en', 'week']]);

    // MKT-3A's adapter, from MKT-3B's stored params: the zh-Hant request and the English one.
    const [zh, en] = onJSearch;
    expect(rapidApiSearchParams(zh!.params, 'jsearch')).toEqual({ query: '軟體工程師 台北', country: 'tw', datePosted: 'month', language: 'zh-TW' });
    expect(rapidApiSearchParams(en!.params, 'jsearch')).toEqual({ query: 'Software engineer in Taipei', country: 'tw', datePosted: 'month' });

    // And the pipeline's refresh input (`country: query.params.country`) gives Taiwan demand its 12 hours.
    for (const p of onJSearch) expect(nextRunDelayMs({ origin: 'demand', demandScore: p.demandScore, consecutiveEmpty: 0, country: p.params.country })).toBe(12 * HOUR);
  });

  it('a tuple outside Taiwan stays one English query with the window of its demand', () => {
    const us: DemandTuple = { ...tuple, country: 'US', city: 'Austin' };
    const planned = planQueries([us], [jsearch]);
    expect(planned.map((p) => [p.language, p.params.datePosted])).toEqual([['en', 'week']]);
    expect(rapidApiSearchParams(planned[0]!.params, 'jsearch')).toEqual({ query: 'Software engineer in Austin', country: 'us', datePosted: 'week' });
  });
});

describe('JT-2 / JI-3: the new sources as the registry and the deployment see them', () => {
  it('the 台灣就業通 sweep is a free cursor source of RoboApply only; the employer boards feed both brands and are read by their own run', () => {
    const tw = getSourceAdapter('tw_open_data')!;
    expect(tw).toBeTruthy();
    expect([tw.kind, [...tw.markets], adapterCostModel(tw), tw.dailyCallLimit()]).toEqual(['cursor', ['intl'], 'free', null]);
    const robo = adaptersForBrand(getBrand('roboapply'), {}).map((a) => a.provider);
    const go = adaptersForBrand(getBrand('goapply'), {}).map((a) => a.provider);
    expect(robo).toContain('tw_open_data');
    expect(go).not.toContain('tw_open_data');
    // GoApply never has a RapidAPI aggregator or the dropped LinkedIn feed as an ingest source (strategy 1.6).
    for (const id of ['jsearch', 'linkedin']) expect(go).not.toContain(id);
    expect(robo).not.toContain('linkedin');
    for (const list of [robo, go]) expect(list).toContain('ats_public');
    const boards = getSourceAdapter('ats_public')!;
    expect([...boards.markets].sort()).toEqual(['cn', 'intl']);
    // The board sync is its only reader: the planner keeps no standing query for it.
    expect(boards.ownRun).toBe(true);
    expect(tw.ownRun).toBeUndefined();
    // The attribution set runs after the two older hook sets.
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toEqual(['cn', 'ats_public', 'tw_sources']);
  });

  it('MKT-3D x MKT-3F: after a board run the System panel\'s provider rows for ats_public are not zero (the run writes the day\'s usage)', async () => {
    // SYNTHETIC board with one Singapore and one Shanghai posting, read once for both brands.
    const fake = createFakePrisma({
      seed: {
        rACareerSiteSource: [
          { id: 'cs1', market: 'intl', ats: 'greenhouse', boardToken: 'globalco', companyName: 'Global Co', companyId: null, countryCode: null, enabled: true, lastSyncedAt: null, lastJobCount: null, lastError: null, origin: 'admin', discoveredFrom: null, countries: [], failCount: 0, lastChangeAt: null, nextSyncAt: null, disabledAt: null, createdAt: NOW, updatedAt: NOW },
        ],
        rAJob: [],
        appConfig: [],
      },
      sql: {
        respond(call) {
          if (call.text.startsWith('UPDATE "RACareerSiteSource" SET "nextSyncAt" = now() + interval')) {
            const rows = fake.$rows('rACareerSiteSource').filter((r) => r.enabled === true && r.nextSyncAt == null);
            for (const r of rows) r.nextSyncAt = new Date(NOW.getTime() + 15 * 60_000);
            return rows.map((r) => ({ ...r }));
          }
          return undefined;
        },
      },
    });
    const job = (id: number, place: string) => ({ id, title: 'Software Engineer', absolute_url: `https://boards.greenhouse.io/globalco/jobs/${id}`, location: { name: place }, offices: [{ name: place, location: place }], content: 'SYNTHETIC', first_published: '2026-10-01T00:00:00Z' });
    const fetch = async (url: string) => {
      const listing = new URL(url).pathname === '/v1/boards/globalco/jobs';
      return listing ? { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [job(1, '上海'), job(2, 'Singapore')] }) } : { ok: false, status: 404, text: async () => '' };
    };
    const process = (async (_ctx: unknown, _adapter: unknown, inputs: unknown[]) => ({ received: inputs.length, written: inputs.length, inserted: inputs.length, updated: 0, skipped: 0, enrichQueued: 0, jobIds: [], notes: {} })) as never;
    await runBoardSync({ db: fake as never, budget: createBudget(240_000, () => 0), now: () => NOW, env: {}, fetch: fetch as never, brands: ['roboapply', 'goapply'], loadSeeds: async () => null, kick: () => undefined, process });
    // The rows the run wrote, as the System store reads them back for the day.
    const usage = fake.$sql.calls
      .filter((c) => c.text.includes('INSERT INTO "RAProviderUsage"'))
      .map((c) => ({ provider: String(c.values[0]), calls: Number(c.values[2]), jobsReturned: Number(c.values[3]), jobsNew: Number(c.values[4]), errors: Number(c.values[5]) }));
    const sources = (['intl', 'cn'] as const).map((market) => ({ provider: 'ats_public', market, enabled: true, reason: null, costModel: 'free' as const }));
    const rows = buildProviderRows({ sources, usage, quota: new Map(), now: NOW, env: {} });
    expect(rows.map((r) => [r.provider, r.calls > 0, r.jobsReturned, r.jobsNew, r.errors, r.state])).toEqual([
      ['ats_public', true, 1, 1, 0, 'ok'],
      ['ats_public:cn', true, 1, 1, 0, 'ok'],
    ]);
  });

  it('the jobs-boards cron has one schedule in vercel.json, the cron registry and the mainland CronJob file', async () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.filter((c) => c.path === '/api/v1/cron/jobs-boards').map((c) => c.schedule)).toEqual(['*/5 * * * *']);
    const handlers = readFileSync(join(ROOT, 'server', 'src', 'cron', 'handlers.ts'), 'utf8');
    expect(handlers).toMatch(/brandCronJob\('jobs-boards', '\*\/5 \* \* \* \*'/);
    const k8s = readFileSync(join(ROOT, 'deploy', 'cn', 'k8s', 'cronjobs.yaml'), 'utf8');
    const block = k8s.split(/^---$/m).find((doc) => doc.includes('jobs-boards'));
    expect(block).toBeTruthy();
    expect(block).toMatch(/schedule: ["']?\*\/5 \* \* \* \*["']?/);
  });
});
