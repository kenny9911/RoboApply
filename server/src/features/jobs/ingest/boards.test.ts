// @vitest-environment node
//
// MKT-3D (MARKET_STRATEGY 1.2 tier 0, 1.4 tier 1, 1.5 closure; JI-3, JI-4,
// JC-4): the board sync. Prisma is the in-memory fake, whose raw-SQL responder
// plays the lease statement over the fake's own rows; every board is a fake
// fetch; the clock is a number the test moves. No network, no database.
// Every fixture is SYNTHETIC.

import { describe, expect, it, vi } from 'vitest';

import { getCurrentBrandId } from '../../../lib/requestContext.js';
import { createBudget } from '../../../platform/queue/index.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { toRecordedSql } from '../../../test/sqlSnapshot.js';
import { normalizeCompanyName, type ProviderJobInput } from '../normalize/index.js';
import { SR_HOST_CONCURRENCY, createHostGate } from '../sources/atsPublic/connectors.js';
import { BoardFetchError, type FetchLike } from '../sources/atsPublic/http.js';
import { careerSeedBoards } from '../sources/atsPublic/index.js';
import { sourceUserAgent as userAgent } from '../sources/index.js';
import {
  BOARD_LEASE_MINUTES,
  BOARD_SYNC_RESERVE_MS,
  archiveDisabledSources,
  buildBoardLeaseSql,
  leaseDueBoards,
  runBoardSync,
  runJobsBoards,
  signingMarket,
  validateCandidates,
  writingBrands,
  type BoardSyncDeps,
  type BoardSyncTally,
} from './boards.js';
import type { IngestDb } from './db.js';
import type { PipelineContext, ProcessResult } from './pipeline.js';
import { parseStatusDoc, sourceStatusKey } from './status.js';
import { decodeUpsert } from './testkit.js';
import type { JobUpsertRow } from './upsert.js';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-10T00:00:00.000Z');

type Row = Record<string, unknown>;

function sourceRow(over: Row = {}): Row {
  return {
    id: 'cs1',
    market: 'intl',
    ats: 'greenhouse',
    boardToken: 'globalco',
    companyName: 'Global Co',
    companyId: null,
    countryCode: null,
    enabled: true,
    lastSyncedAt: null,
    lastJobCount: null,
    lastError: null,
    origin: 'admin',
    discoveredFrom: null,
    countries: [],
    failCount: 0,
    lastChangeAt: null,
    nextSyncAt: null,
    disabledAt: null,
    createdAt: new Date(T0 - 24 * H),
    updatedAt: new Date(T0 - 24 * H),
    ...over,
  };
}

const openJob = (sourceBoard: string, externalId: string, market = 'intl'): Row => ({ id: `job:${sourceBoard}:${externalId}`, market, sourceBoard, externalId, archivedAt: null, closedAt: null, closeReason: null, visibility: 'public', lastSeenAt: null });

interface Harness {
  fake: ReturnType<typeof createFakePrisma>;
  db: IngestDb;
  /** The test's clock (ms). */
  clock: { now: number };
  /** RAJob rows the real pipeline upserted (raw SQL). */
  written: JobUpsertRow[];
  /** Every lease statement: its limit and the ids it excluded. */
  leases: Array<{ limit: number; exclude: string[]; leased: string[] }>;
  sources: () => Row[];
  source: (id: string) => Row;
  jobs: () => Row[];
}

const time = (v: unknown): number => (v instanceof Date ? v.getTime() : Number.NEGATIVE_INFINITY);

/** A fake database that leases the way the statement does: due boards, never-scheduled first, each handed out once per 15 minutes. */
function harness(seed: { sources?: Row[]; jobs?: Row[]; companies?: Row[]; config?: Row[] } = {}, start = T0): Harness {
  const clock = { now: start };
  const written: JobUpsertRow[] = [];
  const leases: Harness['leases'] = [];
  const holder: { fake?: ReturnType<typeof createFakePrisma> } = {};
  const fake = createFakePrisma({
    seed: { rACareerSiteSource: seed.sources ?? [], rAJob: seed.jobs ?? [], rACompany: seed.companies ?? [], appConfig: seed.config ?? [] },
    uniqueFields: { rACompany: ['slug'] },
    sql: {
      respond(call) {
        const t = call.text;
        if (t.startsWith('UPDATE "RACareerSiteSource" SET "nextSyncAt" = now() + interval')) {
          const limit = Number(call.values.find((v) => typeof v === 'number'));
          const exclude = (call.values.find((v) => Array.isArray(v)) as string[] | undefined) ?? [];
          const due = holder
            .fake!.$rows('rACareerSiteSource')
            .filter((r) => r.enabled === true && (r.nextSyncAt == null || time(r.nextSyncAt) <= clock.now) && !exclude.includes(String(r.id)))
            .sort((a, b) => time(a.nextSyncAt) - time(b.nextSyncAt) || time(a.lastSyncedAt) - time(b.lastSyncedAt))
            .slice(0, limit);
          for (const r of due) r.nextSyncAt = new Date(clock.now + BOARD_LEASE_MINUTES * MIN);
          leases.push({ limit, exclude, leased: due.map((r) => String(r.id)) });
          return due.map((r) => ({ ...r }));
        }
        // The parts of Postgres the real pipeline relies on (see ./testkit.ts).
        if (t.startsWith('SELECT "id", "externalId", "sourceBoard", "firstSeenAt"')) return [];
        if (t.includes('INSERT INTO "RAJob"')) {
          const rows = decodeUpsert(call);
          written.push(...rows);
          return rows.map((r) => ({ id: r.id, externalId: r.externalId, sourceBoard: r.sourceBoard, inserted: true }));
        }
        return undefined;
      },
    },
  });
  holder.fake = fake;
  const sources = () => fake.$rows('rACareerSiteSource');
  return { fake, db: fake as unknown as IngestDb, clock, written, leases, sources, source: (id) => sources().find((r) => r.id === id)!, jobs: () => fake.$rows('rAJob') };
}

const ghJob = (token: string, id: number, location: string | string[], title = 'Software Engineer') => {
  const places = Array.isArray(location) ? location : [location];
  return {
    id,
    title,
    absolute_url: `https://boards.greenhouse.io/${token}/jobs/${id}`,
    location: { name: places[0] },
    offices: places.map((p) => ({ name: p, location: p })),
    content: '&lt;p&gt;SYNTHETIC posting text for a board fixture.&lt;/p&gt;',
    first_published: '2026-10-01T00:00:00Z',
  };
};

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const notFound = { ok: false, status: 404, text: async () => '' };

interface BoardWorld {
  fetch: FetchLike;
  urls: string[];
  agents: Set<string | undefined>;
  /** Listing requests per board token. */
  listings: Map<string, number>;
}

/**
 * SYNTHETIC boards. `greenhouse[token]`: its jobs (or a function of the call
 * number, or an error to throw / a status to answer); `lever[token]`: its
 * postings; `ashby[token]`: its jobs; `sr[token]`: its postings (with the
 * company the listing states). `names`: the name a Greenhouse board states.
 */
function world(boards: {
  greenhouse?: Record<string, unknown[] | number | Error | ((call: number) => unknown[] | number | Error)>;
  names?: Record<string, string>;
  lever?: Record<string, unknown[]>;
  ashby?: Record<string, unknown[]>;
  sr?: Record<string, { company?: string; postings: Array<{ id: string; country: string; city: string }>; status?: number | ((call: number) => number | undefined); textStatus?: (id: string) => number | undefined }>;
  onRequest?: (url: string) => void | Promise<void>;
}): BoardWorld {
  const urls: string[] = [];
  const agents = new Set<string | undefined>();
  const listings = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    agents.add(init.headers?.['User-Agent']);
    if (boards.onRequest) await boards.onRequest(url);
    const u = new URL(url);
    const gh = /^\/v1\/boards\/([^/]+)(\/jobs)?$/.exec(u.pathname);
    if (u.hostname === 'boards-api.greenhouse.io' && gh) {
      const token = gh[1]!;
      if (!gh[2]) return boards.names?.[token] ? ok({ name: boards.names[token] }) : notFound;
      const n = (listings.get(token) ?? 0) + 1;
      listings.set(token, n);
      const spec = boards.greenhouse?.[token];
      const answer = typeof spec === 'function' ? spec(n) : spec;
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'number') return { ok: false, status: answer, text: async () => '' };
      return answer ? ok({ jobs: answer }) : notFound;
    }
    const lv = /^\/v0\/postings\/([^/]+)$/.exec(u.pathname);
    if (u.hostname === 'api.lever.co' && lv) {
      listings.set(lv[1]!, (listings.get(lv[1]!) ?? 0) + 1);
      const all = boards.lever?.[lv[1]!];
      if (!all) return notFound;
      const skip = Number(u.searchParams.get('skip'));
      return ok(all.slice(skip, skip + Number(u.searchParams.get('limit'))));
    }
    const ab = /^\/posting-api\/job-board\/([^/]+)$/.exec(u.pathname);
    if (u.hostname === 'api.ashbyhq.com' && ab) {
      listings.set(ab[1]!, (listings.get(ab[1]!) ?? 0) + 1);
      return boards.ashby?.[ab[1]!] ? ok({ jobs: boards.ashby[ab[1]!] }) : notFound;
    }
    const sr = /^\/v1\/companies\/([^/]+)\/postings(?:\/([^/]+))?$/.exec(u.pathname);
    if (u.hostname === 'api.smartrecruiters.com' && sr) {
      const board = boards.sr?.[sr[1]!];
      if (!board) return notFound;
      if (sr[2]) {
        const refused = board.textStatus?.(sr[2]);
        if (refused) return { ok: false, status: refused, text: async () => '' };
        return ok({ id: sr[2], jobAd: { sections: { jobDescription: { text: '<p>SYNTHETIC text.</p>' } } } });
      }
      listings.set(sr[1]!, (listings.get(sr[1]!) ?? 0) + 1);
      const status = typeof board.status === 'function' ? board.status(listings.get(sr[1]!)!) : board.status;
      if (status) return { ok: false, status, text: async () => '' };
      const country = u.searchParams.get('country');
      const offset = Number(u.searchParams.get('offset'));
      const rows = board.postings.filter((p) => !country || p.country === country);
      const content = rows.slice(offset, offset + 100).map((p) => ({ id: p.id, name: `Role ${p.id}`, company: { name: board.company ?? 'Harbor Group' }, location: { city: p.city, country: p.country }, releasedDate: '2026-10-01T00:00:00.000Z' }));
      return ok({ totalFound: rows.length, content });
    }
    return notFound;
  };
  return { fetch, urls, agents, listings };
}

interface ProcessCall {
  market: string;
  brand: string;
  /** The brand of the request context while the write ran. */
  contextBrand: string | null;
  ids: string[];
  inputs: ProviderJobInput[];
}

/** A stand-in for the pipeline's `processJobs`: records the call and reports `inserted(ids)` new rows. */
function recorder(inserted: (call: ProcessCall) => number = (c) => c.ids.length) {
  const calls: ProcessCall[] = [];
  const process = (async (ctx: PipelineContext, adapter: { provider: string }, inputs: ProviderJobInput[]): Promise<ProcessResult> => {
    expect(adapter.provider).toBe('ats_public');
    const call: ProcessCall = { market: ctx.market, brand: ctx.brand, contextBrand: getCurrentBrandId() ?? null, ids: inputs.map((i) => i.externalId), inputs };
    calls.push(call);
    const n = inserted(call);
    return { received: inputs.length, written: inputs.length, inserted: n, updated: inputs.length - n, skipped: 0, enrichQueued: 0, jobIds: [], notes: {} };
  }) as unknown as NonNullable<BoardSyncDeps['process']>;
  return { calls, process };
}

const BOTH = ['roboapply', 'goapply'] as const;

function run(h: Harness, w: Pick<BoardWorld, 'fetch'>, over: Partial<BoardSyncDeps> = {}): Promise<BoardSyncTally> {
  return runBoardSync({
    db: h.db,
    budget: createBudget(240_000, () => 0),
    now: () => new Date(h.clock.now),
    env: {},
    fetch: w.fetch,
    brands: BOTH,
    loadSeeds: async () => null,
    kick: () => undefined,
    ...over,
  }) as Promise<BoardSyncTally>;
}

// ── The lease ────────────────────────────────────────────────────────────

describe('the lease statement', () => {
  it('leases due boards with FOR UPDATE SKIP LOCKED, never-scheduled first, for 15 minutes, and names its columns', () => {
    const { text, values } = toRecordedSql('$queryRaw', buildBoardLeaseSql(12), []);
    expect(text).toBe(
      'UPDATE "RACareerSiteSource" SET "nextSyncAt" = now() + interval \'15 minutes\' WHERE "id" IN ( SELECT "id" FROM "RACareerSiteSource" WHERE "enabled" = true AND ("nextSyncAt" IS NULL OR "nextSyncAt" <= now()) ORDER BY "nextSyncAt" ASC NULLS FIRST, "lastSyncedAt" ASC NULLS FIRST LIMIT $1 FOR UPDATE SKIP LOCKED ) RETURNING "id", "market", "ats", "boardToken", "companyName", "companyId", "countryCode", "enabled", "lastSyncedAt", "lastJobCount", "lastError", "origin", "discoveredFrom", "countries", "failCount", "lastChangeAt", "nextSyncAt", "disabledAt"',
    );
    expect(values).toEqual([12]);
    expect(text).not.toContain('*');
    expect(BOARD_LEASE_MINUTES).toBe(15);
    // Boards this run has already read are left out.
    const again = toRecordedSql('$queryRaw', buildBoardLeaseSql(12, ['a', 'b']), []);
    expect(again.text).toContain('AND NOT ("id" = ANY($1::text[])) ORDER BY');
    expect(again.values).toEqual([['a', 'b'], 12]);
  });

  it('leaseDueBoards returns typed rows; a limit of 0 asks nothing', async () => {
    const h = harness({ sources: [sourceRow(), sourceRow({ id: 'off', boardToken: 'off', enabled: false }), sourceRow({ id: 'later', boardToken: 'later', nextSyncAt: new Date(T0 + H) })] });
    expect(await leaseDueBoards(h.db, 0)).toEqual([]);
    expect(h.leases).toEqual([]);
    const leased = await leaseDueBoards(h.db, 10);
    expect(leased.map((s) => s.id)).toEqual(['cs1']);
    expect(leased[0]).toMatchObject({ ats: 'greenhouse', boardToken: 'globalco', countries: [], failCount: 0, origin: 'admin' });
    // Leased: not offered again until the lease runs out.
    expect(await leaseDueBoards(h.db, 10)).toEqual([]);
  });

  it('two overlapping runs never read the same board', async () => {
    const tokens = Array.from({ length: 40 }, (_, i) => `co${i}`);
    const h = harness({ sources: tokens.map((t, i) => sourceRow({ id: `s${i}`, boardToken: t, companyName: `Co ${i}` })) });
    const w = world({ greenhouse: Object.fromEntries(tokens.map((t) => [t, [ghJob(t, 1, 'Singapore')]])), onRequest: () => new Promise((resolve) => setTimeout(resolve, 1)) });
    const a = recorder();
    const b = recorder();
    const [first, second] = await Promise.all([run(h, w, { process: a.process }), run(h, w, { process: b.process })]);
    expect(first.boards + second.boards).toBe(40);
    for (const t of tokens) expect(w.listings.get(t), t).toBe(1);
    const leased = h.leases.flatMap((l) => l.leased);
    expect(new Set(leased).size).toBe(leased.length);
  });
});

// ── Throughput ───────────────────────────────────────────────────────────

describe('reading: several boards in flight, one write at a time', () => {
  it('never has more listings in flight than the setting (default 6, clamped to 4-8) and leases twice that per round', async () => {
    for (const [setting, expected] of [[undefined, 6], ['4', 4], ['2', 4], ['8', 8], ['40', 8]] as const) {
      const tokens = Array.from({ length: 30 }, (_, i) => `co${i}`);
      const h = harness({ sources: tokens.map((t, i) => sourceRow({ id: `s${i}`, boardToken: t })) });
      let inFlight = 0;
      let peak = 0;
      const w = world({
        greenhouse: Object.fromEntries(tokens.map((t) => [t, [ghJob(t, 1, 'Singapore')]])),
        onRequest: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight -= 1;
        },
      });
      let writing = 0;
      let writePeak = 0;
      const process = (async (_ctx: PipelineContext, _a: unknown, inputs: ProviderJobInput[]): Promise<ProcessResult> => {
        writing += 1;
        writePeak = Math.max(writePeak, writing);
        await new Promise((resolve) => setTimeout(resolve, 1));
        writing -= 1;
        return { received: inputs.length, written: inputs.length, inserted: 0, updated: inputs.length, skipped: 0, enrichQueued: 0, jobIds: [], notes: {} };
      }) as unknown as NonNullable<BoardSyncDeps['process']>;
      const tally = await run(h, w, { env: setting ? { ATS_BOARDS_CONCURRENCY: setting } : {}, process });
      expect(tally.boards, String(setting)).toBe(30);
      expect(peak, String(setting)).toBe(expected);
      expect(writePeak, String(setting)).toBe(1);
      expect(h.leases[0]!.limit, String(setting)).toBe(expected * 2);
      expect(tally.stoppedBy).toBe('idle');
    }
  });

  it('SmartRecruiters posting texts share ONE cap per host: several of its boards read at once never hold more than 4 text requests open (cross-review, M3 gate)', async () => {
    // Six boards with 12 unread texts each, all due in the first round and read together (6 boards in flight).
    const tokens = ['Harbor1', 'Harbor2', 'Harbor3', 'Harbor4', 'Harbor5', 'Harbor6'];
    const h = harness({
      sources: tokens.map((token, i) => sourceRow({ id: `sr${i}`, ats: 'smartrecruiters', boardToken: token, companyName: `Harbor ${i}`, countries: ['SG'] })),
    });
    let texts = 0;
    let peak = 0;
    const isText = (url: string) => /\/postings\/[^/?]+$/.test(new URL(url).pathname);
    const w = world({
      sr: Object.fromEntries(tokens.map((token) => [token, { company: token, postings: Array.from({ length: 12 }, (_, i) => ({ id: `${token}-${i}`, country: 'sg', city: 'Singapore' })) }])),
      onRequest: async (url) => {
        if (!isText(url)) return;
        texts += 1;
        peak = Math.max(peak, texts);
        await new Promise((resolve) => setTimeout(resolve, 1));
        texts -= 1;
      },
    });
    const tally = await run(h, w, { process: recorder().process });
    expect(tally).toMatchObject({ boards: 6, received: 72, boardErrors: 0 });
    expect(w.urls.filter(isText)).toHaveLength(72);
    // Without the shared gate this is 6 boards x 4 = 24.
    expect(peak).toBe(SR_HOST_CONCURRENCY);
    expect(SR_HOST_CONCURRENCY).toBe(4);
  });

  it('the host gate hands a slot straight to the next waiter and survives a failed request', async () => {
    const gate = createHostGate(2);
    let active = 0;
    let peak = 0;
    const job = (fail: boolean) =>
      gate(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        if (fail) throw new Error('refused');
        return 'ok';
      });
    const results = await Promise.allSettled([job(false), job(true), job(false), job(true), job(false), job(false), job(false)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(peak).toBe(2);
    // Every slot was given back: two more still run together, never three.
    peak = 0;
    await Promise.all([job(false), job(false), job(false)]);
    expect(peak).toBe(2);
  });

  it('a 728-posting Greenhouse board is read whole and handed to the normalizer in ONE run, from one request; none of its stored rows is closed', async () => {
    const jobs = Array.from({ length: 728 }, (_, i) => ghJob('globalco', i + 1, 'Dublin, Ireland'));
    const h = harness({ sources: [sourceRow()], jobs: jobs.map((j) => openJob('greenhouse', `globalco:${j.id}`)) });
    const w = world({ greenhouse: { globalco: jobs } });
    const rec = recorder(() => 0);
    const tally = await run(h, w, { process: rec.process });
    expect(w.urls).toEqual(['https://boards-api.greenhouse.io/v1/boards/globalco/jobs?content=true']);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.ids).toHaveLength(728);
    expect(new Set(rec.calls[0]!.ids).size).toBe(728);
    expect(tally).toMatchObject({ boards: 1, received: 728, written: 728, closed: 0, boardErrors: 0, calls: 1 });
    expect(h.jobs().every((r) => r.archivedAt === null)).toBe(true);
    expect(h.source('cs1')).toMatchObject({ lastJobCount: 728, lastError: null });
  });

  it('the real pipeline writes the rows: every posting normalized as ats_public with the employer\'s own apply link', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore'), ghJob('globalco', 2, 'Taipei, Taiwan', 'Product Designer')] } });
    const enqueueMany = vi.fn(async (items: unknown[]) => ({ inserted: items.length }));
    const kick = vi.fn();
    const tally = await run(h, w, { enqueueMany, kick });
    expect(tally).toMatchObject({ boards: 1, received: 2, written: 2, inserted: 2, enrichQueued: 2, closed: 0 });
    expect(h.written.map((r) => [r.externalId, r.sourceBoard, r.market, r.applyUrl, r.sourceName])).toEqual([
      ['globalco:1', 'greenhouse', 'intl', 'https://boards.greenhouse.io/globalco/jobs/1', 'Global Co · Greenhouse'],
      ['globalco:2', 'greenhouse', 'intl', 'https://boards.greenhouse.io/globalco/jobs/2', 'Global Co · Greenhouse'],
    ]);
    // New rows are queued for enrichment as the brand that serves the market.
    expect(enqueueMany).toHaveBeenCalledTimes(1);
    expect((enqueueMany.mock.calls[0]![0] as Array<{ options: { brand: string } }>).every((i) => i.options.brand === 'roboapply')).toBe(true);
    await vi.waitFor(() => expect(kick).toHaveBeenCalledWith(['job.enrich']));
  });

  it('every request of the run carries the identifying User-Agent: RoboApply\'s where it is served, GoApply\'s on a mainland-only deployment', async () => {
    const env = { JOB_SOURCES_CONTACT: 'mailto:jobs@example.com', CN_JOB_SOURCES_CONTACT: 'mailto:zhaopin@example.cn' };
    const both = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    await run(harness({ sources: [sourceRow()] }), both, { env, process: recorder().process });
    expect([...both.agents]).toEqual([userAgent('intl', env)]);
    expect([...both.agents][0]).toBe('RoboApplyJobs/1.0 (+mailto:jobs@example.com)');
    const mainland = world({ greenhouse: { globalco: [ghJob('globalco', 1, '上海')] } });
    await run(harness({ sources: [sourceRow()] }), mainland, { env, brands: ['goapply'], process: recorder().process });
    expect([...mainland.agents]).toEqual(['GoApplyJobs/1.0 (+mailto:zhaopin@example.cn)']);
  });

  it('where both brands are served, a board read for the mainland only is asked as GoApply and never names RoboApply; every other board is asked as RoboApply', async () => {
    const env = { JOB_SOURCES_CONTACT: 'mailto:jobs@example.com', CN_JOB_SOURCES_CONTACT: 'mailto:zhaopin@example.cn' };
    const seen = new Map<string, Set<string | undefined>>();
    const inner = world({
      greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] },
      sr: { MainlandCo: { postings: [{ id: 'p1', country: 'cn', city: 'Wuxi' }] }, HarborFoods: { postings: [{ id: 'p2', country: 'tw', city: 'Taipei' }] } },
    });
    const fetch: FetchLike = async (url, init) => {
      const board = /globalco|MainlandCo|HarborFoods/.exec(url)![0];
      seen.set(board, (seen.get(board) ?? new Set()).add(init.headers?.['User-Agent']));
      return inner.fetch(url, init);
    };
    const h = harness({
      sources: [
        sourceRow(),
        sourceRow({ id: 'cn-only', ats: 'smartrecruiters', boardToken: 'MainlandCo', companyName: 'Mainland Co', countries: ['CN'] }),
        sourceRow({ id: 'both', ats: 'smartrecruiters', boardToken: 'HarborFoods', companyName: 'Harbor Foods', countries: ['CN', 'TW'] }),
      ],
    });
    await run(h, { fetch }, { env, process: recorder().process });
    // The listing and the posting text of the mainland-only board: GoApply's name and GoApply's contact.
    expect([...seen.get('MainlandCo')!]).toEqual(['GoApplyJobs/1.0 (+mailto:zhaopin@example.cn)']);
    expect([...seen.get('globalco')!]).toEqual(['RoboApplyJobs/1.0 (+mailto:jobs@example.com)']);
    expect([...seen.get('HarborFoods')!]).toEqual(['RoboApplyJobs/1.0 (+mailto:jobs@example.com)']);
    // The rule by itself.
    expect(signingMarket({ countries: ['CN'] }, BOTH)).toBe('cn');
    expect(signingMarket({ countries: ['CN', 'TW'] }, BOTH)).toBe('intl');
    expect(signingMarket({ countries: [] }, BOTH)).toBe('intl');
    expect(signingMarket({ countries: [] }, ['goapply'])).toBe('cn');
    expect(signingMarket({ countries: ['US'] }, ['goapply'])).toBe('cn');
    expect(signingMarket({ countries: ['CN'] }, ['roboapply'])).toBe('intl');
    expect(signingMarket({ countries: ['CN'] }, [])).toBe('intl');
  });
});

// ── One read feeds both brands (JC-4) ────────────────────────────────────

describe('one board read feeds both brands', () => {
  const board = () => [ghJob('globalco', 1, '上海'), ghJob('globalco', 2, 'Singapore'), ghJob('globalco', 3, ['Shanghai, China', 'Singapore'])];

  it('processJobs is called once per market, as the brand that serves it, inside that brand\'s context; the board is requested once', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: board() } });
    const rec = recorder();
    const tally = await run(h, w, { process: rec.process });
    expect(w.listings.get('globalco')).toBe(1);
    expect(rec.calls.map((c) => [c.market, c.brand, c.contextBrand, c.ids])).toEqual([
      ['intl', 'roboapply', 'roboapply', ['globalco:2', 'globalco:3']],
      ['cn', 'goapply', 'goapply', ['globalco:1', 'globalco:3#cn']],
    ]);
    // The posting in both: Singapore to intl, Shanghai to cn as <id>#cn.
    expect(rec.calls[0]!.inputs[1]).toMatchObject({ externalId: 'globalco:3', locations: ['Singapore'] });
    expect(rec.calls[1]!.inputs[1]).toMatchObject({ externalId: 'globalco:3#cn', locations: ['Shanghai, China'] });
    expect(tally).toMatchObject({ boards: 1, received: 4, inserted: 4, droppedIntl: 0, droppedCn: 0 });
  });

  it('through the real pipeline a 上海 posting lands in the GoApply index (market cn) and not in RoboApply\'s; Singapore lands in intl', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: board() } });
    const tally = await run(h, w, { enqueueMany: async (items) => ({ inserted: items.length }) });
    // One write per market: the international rows, then the mainland ones.
    expect(h.written.map((r) => [r.externalId, r.market, r.locationCountry])).toEqual([
      ['globalco:2', 'intl', 'SG'],
      ['globalco:3', 'intl', 'SG'],
      ['globalco:1', 'cn', 'CN'],
      ['globalco:3#cn', 'cn', 'CN'],
    ]);
    expect(tally).toMatchObject({ written: 4, skippedPostings: 0 });
  });

  it('when the board later lists only Singapore, the #cn row is archived as source_removed and the intl row stays open', async () => {
    const h = harness({
      sources: [sourceRow({ lastSyncedAt: new Date(T0 - 3 * H), lastChangeAt: new Date(T0 - 100 * H) })],
      jobs: [openJob('greenhouse', 'globalco:3'), openJob('greenhouse', 'globalco:3#cn', 'cn'), openJob('greenhouse', 'otherco:3#cn', 'cn')],
    });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 3, 'Singapore')] } });
    const tally = await run(h, w, { process: recorder(() => 0).process });
    expect(tally.closed).toBe(1);
    const row = (id: string) => h.jobs().find((r) => r.externalId === id)!;
    expect(row('globalco:3#cn')).toMatchObject({ closeReason: 'source_removed', archivedAt: new Date(T0), closedAt: new Date(T0) });
    expect(row('globalco:3').archivedAt).toBeNull();
    expect(row('otherco:3#cn').archivedAt).toBeNull();
    // A closure is a change: the board is read again in 2 hours.
    expect(h.source('cs1')).toMatchObject({ lastChangeAt: new Date(T0), nextSyncAt: new Date(T0 + 2 * H) });
  });

  it('with GoApply\'s ingest off no cn row is written, the dropped postings are counted, and nothing lands in the other market', async () => {
    const h = harness({ sources: [sourceRow()] });
    const rec = recorder();
    const tally = await run(h, world({ greenhouse: { globalco: board() } }), { env: { CN_RECRUITMENT_INFO_MODE: 'off' }, process: rec.process });
    expect(rec.calls.map((c) => [c.market, c.ids])).toEqual([['intl', ['globalco:2', 'globalco:3']]]);
    expect(tally).toMatchObject({ droppedCn: 2, droppedIntl: 0, received: 2 });
    expect(writingBrands(BOTH, { CN_RECRUITMENT_INFO_MODE: 'off' })).toEqual({ intl: 'roboapply' });
    expect(writingBrands(BOTH, {})).toEqual({ intl: 'roboapply', cn: 'goapply' });
  });

  it('JOB_PROVIDERS_<BRAND> without ats_public stops the boards for that brand: its postings are counted as dropped, the other brand is unaffected', async () => {
    // The variable narrowed the brand's ingest while the boards were read by the tick; the boards' own run honours it too.
    const h = harness({ sources: [sourceRow()] });
    const rec = recorder();
    const env = { JOB_PROVIDERS_GOAPPLY: 'bank_gohire' };
    const tally = await run(h, world({ greenhouse: { globalco: board() } }), { env, process: rec.process });
    expect(rec.calls.map((c) => [c.market, c.brand, c.ids])).toEqual([['intl', 'roboapply', ['globalco:2', 'globalco:3']]]);
    expect(tally).toMatchObject({ droppedCn: 2, droppedIntl: 0, received: 2 });
    expect(writingBrands(BOTH, env)).toEqual({ intl: 'roboapply' });
    // A list that names the boards keeps them; RoboApply narrowed to its search provider and bank loses them.
    expect(writingBrands(BOTH, { JOB_PROVIDERS_GOAPPLY: 'bank_gohire, ATS_PUBLIC' })).toEqual({ intl: 'roboapply', cn: 'goapply' });
    expect(writingBrands(BOTH, { JOB_PROVIDERS_ROBOAPPLY: 'jsearch,bank_robohire' })).toEqual({ cn: 'goapply' });
    // An empty value is "not set".
    expect(writingBrands(BOTH, { JOB_PROVIDERS_GOAPPLY: ' ' })).toEqual({ intl: 'roboapply', cn: 'goapply' });
  });

  it('a deployment that serves one brand writes that market only and counts the rest', async () => {
    const intlOnly = recorder();
    const a = await run(harness({ sources: [sourceRow()] }), world({ greenhouse: { globalco: board() } }), { brands: ['roboapply'], process: intlOnly.process });
    expect(intlOnly.calls.map((c) => c.market)).toEqual(['intl']);
    expect(a).toMatchObject({ droppedCn: 2, droppedIntl: 0 });
    const cnOnly = recorder();
    const b = await run(harness({ sources: [sourceRow()] }), world({ greenhouse: { globalco: board() } }), { brands: ['goapply'], process: cnOnly.process });
    expect(cnOnly.calls.map((c) => [c.market, c.brand])).toEqual([['cn', 'goapply']]);
    expect(b).toMatchObject({ droppedIntl: 2, droppedCn: 0 });
  });

  it('the source\'s countries decide what is kept; copies left out are counted and never written', async () => {
    const h = harness({ sources: [sourceRow({ countries: ['CN'] })] });
    const rec = recorder();
    const tally = await run(h, world({ greenhouse: { globalco: board() } }), { process: rec.process });
    expect(rec.calls.map((c) => [c.market, c.ids])).toEqual([['cn', ['globalco:1', 'globalco:3#cn']]]);
    expect(tally.countryNotSelected).toBe(2);
  });
});

// ── The run status the admin console reads ──────────────────────────────

describe('the run status per market (AppConfig jobs.source.status:<market>:ats_public)', () => {
  const doc = (h: Harness, market: 'intl' | 'cn') => {
    const row = h.fake.$rows('appConfig').find((r) => r.key === sourceStatusKey(market, 'ats_public'));
    return row ? parseStatusDoc(String(row.value)) : null;
  };

  it('counts the boards read for each market, and each posting in the market it was written to', async () => {
    const h = harness({
      sources: [
        sourceRow(),
        sourceRow({ id: 'cn-only', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countries: ['CN'] }),
        sourceRow({ id: 'gone', boardToken: 'gone', companyName: 'Gone' }),
      ],
      jobs: [openJob('greenhouse', 'globalco:9'), openJob('greenhouse', 'globalco:8#cn', 'cn')],
    });
    const w = world({
      greenhouse: { globalco: [ghJob('globalco', 1, '上海'), ghJob('globalco', 2, 'Singapore'), ghJob('globalco', 3, ['Shanghai, China', 'Singapore'])] },
      sr: { BoschGroup: { postings: Array.from({ length: 130 }, (_, i) => ({ id: `p${i}`, country: 'cn', city: 'Wuxi' })) } },
    });
    h.clock.now = T0 + 7 * MIN;
    await run(h, w, { process: recorder().process });
    const intl = doc(h, 'intl')!;
    const cn = doc(h, 'cn')!;
    // Two boards feed RoboApply (the shared one and the one that is gone); all three feed GoApply.
    expect(intl.last).toMatchObject({ at: new Date(T0 + 7 * MIN).toISOString(), ok: true, transport: 'board_api', received: 2, written: 2, inserted: 2, closed: 1, notes: { boards_read: 2, board_errors: 1 }, error: 'board_not_found' });
    expect(cn.last).toMatchObject({ ok: true, received: 102, written: 102, inserted: 102, closed: 1, notes: { boards_read: 3, board_errors: 1, board_backlog: 1 } });
    // Counted: the tallies survive a later run of the source that reads nothing.
    expect(intl.counted).toEqual(intl.last);
    // Counters and codes only.
    expect(JSON.stringify([intl, cn])).not.toMatch(/https?:|Global Co|SYNTHETIC/);
  });

  it('adds the same counters to the day\'s RAProviderUsage row of each market (ats_public, ats_public:cn), which the System panel prints', async () => {
    const h = harness({
      sources: [sourceRow(), sourceRow({ id: 'gone', boardToken: 'gone', companyName: 'Gone' })],
    });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, '上海'), ghJob('globalco', 2, 'Singapore'), ghJob('globalco', 3, ['Shanghai, China', 'Singapore'])] } });
    h.clock.now = T0 + 7 * MIN;
    await run(h, w, { process: recorder().process });
    const usage = h.fake.$sql.calls.filter((c) => c.text.includes('INSERT INTO "RAProviderUsage"')).map((c) => c.values);
    const intl = doc(h, 'intl')!.last!;
    const cn = doc(h, 'cn')!.last!;
    // provider key, day (UTC), calls, postings returned, postings added, boards that failed.
    expect(usage).toEqual([
      ['ats_public', '2026-10-10', intl.calls, 2, 2, 1],
      ['ats_public:cn', '2026-10-10', cn.calls, 2, 2, 1],
    ]);
    expect(intl.calls).toBeGreaterThan(0);
    // A run that reads no board writes no usage row; a failed write never fails the run.
    const idle = harness({});
    await run(idle, world({}), { process: recorder().process });
    expect(idle.fake.$sql.calls.some((c) => c.text.includes('"RAProviderUsage"'))).toBe(false);
    const broken = harness({ sources: [sourceRow()] });
    const exec = broken.db.$executeRaw.bind(broken.db) as (...a: unknown[]) => Promise<unknown>;
    (broken.db as unknown as { $executeRaw: unknown }).$executeRaw = async (first: unknown, ...rest: unknown[]) => {
      const text = ((first as { strings?: string[] }).strings ?? (first as string[])).join('?');
      if (text.includes('"RAProviderUsage"')) throw new Error('relation missing');
      return exec(first, ...rest);
    };
    await expect(run(broken, w, { process: recorder().process })).resolves.toMatchObject({ boards: 1 });
  });

  it('a run in which every board failed says so; a run that read no board leaves the last status standing; a market not written gets none', async () => {
    const h = harness({ sources: [sourceRow({ boardToken: 'gone' })] });
    await run(h, world({}), { brands: ['roboapply'], process: recorder().process });
    expect(doc(h, 'intl')!.last).toMatchObject({ ok: false, error: 'board_not_found', received: 0, notes: { boards_read: 1, board_errors: 1 } });
    expect(doc(h, 'cn')).toBeNull();
    const before = JSON.stringify(h.fake.$rows('appConfig'));
    h.clock.now = T0 + 5 * MIN;
    await run(h, world({}), { brands: ['roboapply'], process: recorder().process });
    expect(JSON.stringify(h.fake.$rows('appConfig'))).toBe(before);
  });
});

// ── Stamps ───────────────────────────────────────────────────────────────

describe('the stamp on the source after a read', () => {
  it('success: read time, listed count, no error, no failures; next read by how recently the board changed; a board never read is due at once', async () => {
    const h = harness({
      sources: [
        // Never read: due immediately. Its first read adds every posting it lists, which is the load and not a
        // change of the board: it is read again in 24 h (the next test).
        sourceRow({ id: 'new', boardToken: 'newco', failCount: 2, lastError: 'http_503' }),
        // Read before, and this read adds two postings: a change, read again in 2 h.
        sourceRow({ id: 'hot', boardToken: 'hotco', lastSyncedAt: new Date(T0 - 24 * H), lastJobCount: 5, nextSyncAt: new Date(T0 - 2), lastChangeAt: new Date(T0 - 30 * 24 * H) }),
        // Due, nothing changes this time, changed 3 days ago: 12 h.
        sourceRow({ id: 'warm', boardToken: 'warmco', lastSyncedAt: new Date(T0 - 12 * H), nextSyncAt: new Date(T0 - 1), lastChangeAt: new Date(T0 - 72 * H) }),
        // Due, nothing changes, last change 30 days ago: 24 h.
        sourceRow({ id: 'cold', boardToken: 'coldco', lastSyncedAt: new Date(T0 - 24 * H), nextSyncAt: new Date(T0 - 1), lastChangeAt: new Date(T0 - 30 * 24 * H) }),
        // Not due yet: left alone.
        sourceRow({ id: 'later', boardToken: 'laterco', lastSyncedAt: new Date(T0 - H), nextSyncAt: new Date(T0 + H) }),
      ],
    });
    const two = (token: string) => [ghJob(token, 1, 'Singapore'), ghJob(token, 2, 'Singapore')];
    const w = world({ greenhouse: { newco: two('newco'), hotco: two('hotco'), warmco: [ghJob('warmco', 1, 'Singapore')], coldco: [], laterco: [ghJob('laterco', 1, 'Singapore')] } });
    const rec = recorder((c) => (c.ids[0]!.startsWith('newco') || c.ids[0]!.startsWith('hotco') ? 2 : 0));
    const tally = await run(h, w, { process: rec.process });
    expect(tally).toMatchObject({ boards: 4, inserted: 4 });
    expect(h.leases[0]!.leased).toEqual(['new', 'hot', 'cold', 'warm']);
    expect(h.source('new')).toMatchObject({ lastSyncedAt: new Date(T0), lastJobCount: 2, lastError: null, failCount: 0, lastChangeAt: null, nextSyncAt: new Date(T0 + 24 * H), enabled: true });
    expect(h.source('hot')).toMatchObject({ lastSyncedAt: new Date(T0), lastJobCount: 2, lastChangeAt: new Date(T0), nextSyncAt: new Date(T0 + 2 * H) });
    expect(h.source('warm')).toMatchObject({ lastSyncedAt: new Date(T0), lastJobCount: 1, lastChangeAt: new Date(T0 - 72 * H), nextSyncAt: new Date(T0 + 12 * H) });
    expect(h.source('cold')).toMatchObject({ lastSyncedAt: new Date(T0), lastJobCount: 0, nextSyncAt: new Date(T0 + 24 * H) });
    expect(h.source('later')).toMatchObject({ lastSyncedAt: new Date(T0 - H), nextSyncAt: new Date(T0 + H) });
    expect(w.listings.has('laterco')).toBe(false);
  });

  it('a first read does not make a board hot: the load is not a change; the first posting that really opens does (M4 cross-review)', async () => {
    // Before: `inserted > 0` on the first read stamped `lastChangeAt`, so every newly seeded board was read again every
    // 2 hours for 48 hours, and each of those reads downloads the whole board and rewrites every posting.
    const listing: unknown[] = [ghJob('seedco', 1, 'Singapore'), ghJob('seedco', 2, 'Singapore'), ghJob('seedco', 3, 'Singapore')];
    const h = harness({ sources: [sourceRow({ id: 'seed', boardToken: 'seedco', origin: 'seed' })] });
    const w = world({ greenhouse: { seedco: () => listing } });
    // The pipeline reports as new exactly the postings it has not been handed before.
    const known = new Set<string>();
    const rec = recorder((c) => {
      const fresh = c.ids.filter((id) => !known.has(id));
      for (const id of c.ids) known.add(id);
      return fresh.length;
    });
    const sync = () => run(h, w, { process: rec.process });

    // A new board is read at once, and all three postings are inserted.
    expect(await sync()).toMatchObject({ boards: 1, inserted: 3 });
    expect(h.source('seed')).toMatchObject({ lastSyncedAt: new Date(T0), lastJobCount: 3, lastChangeAt: null, nextSyncAt: new Date(T0 + 24 * H) });
    // Two hours later it is not due (it used to be), and nothing is requested.
    h.clock.now = T0 + 2 * H;
    expect(await sync()).toMatchObject({ boards: 0 });
    expect(w.listings.get('seedco')).toBe(1);
    // The next day it lists the same postings: still no change, 24 hours again.
    h.clock.now = T0 + 24 * H;
    expect(await sync()).toMatchObject({ boards: 1, inserted: 0 });
    expect(h.source('seed')).toMatchObject({ lastChangeAt: null, nextSyncAt: new Date(T0 + 48 * H) });
    // A posting really opens: that is a change, and the board is read every 2 hours from here.
    listing.push(ghJob('seedco', 4, 'Singapore'));
    h.clock.now = T0 + 48 * H;
    expect(await sync()).toMatchObject({ boards: 1, inserted: 1 });
    expect(h.source('seed')).toMatchObject({ lastJobCount: 4, lastChangeAt: new Date(T0 + 48 * H), nextSyncAt: new Date(T0 + 50 * H) });
  });

  it('a board whose first attempts failed in passing still has its first successful read: that read is the load too', async () => {
    // It has a `lastSyncedAt` (the failed attempt) and no successful read: `lastJobCount` is what says so.
    const h = harness({ sources: [sourceRow({ id: 'late', boardToken: 'lateco', lastSyncedAt: new Date(T0 - H), lastError: 'http_503', nextSyncAt: new Date(T0 - 1) })] });
    const w = world({ greenhouse: { lateco: [ghJob('lateco', 1, 'Singapore')] } });
    await run(h, w, { process: recorder().process });
    expect(h.source('late')).toMatchObject({ lastJobCount: 1, lastError: null, lastChangeAt: null, nextSyncAt: new Date(T0 + 24 * H) });
  });

  it('a first read that also closes rows left from an earlier load is a change (a closure always is)', async () => {
    const h = harness({ sources: [sourceRow()], jobs: [openJob('greenhouse', 'globalco:9')] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    const tally = await run(h, w, { process: recorder().process });
    expect(tally.closed).toBe(1);
    expect(h.source('cs1')).toMatchObject({ lastChangeAt: new Date(T0), nextSyncAt: new Date(T0 + 2 * H) });
  });

  it('a source registered without a name learns the name its board states', async () => {
    const h = harness({ sources: [sourceRow({ companyName: 'globalco' })] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] }, names: { globalco: 'Global Co Ltd' } });
    const rec = recorder();
    await run(h, w, { process: rec.process });
    expect(h.source('cs1').companyName).toBe('Global Co Ltd');
    expect(rec.calls[0]!.inputs[0]).toMatchObject({ company: 'Global Co Ltd', sourcePublisher: 'Global Co Ltd · Greenhouse' });
    // A name an admin gave is never replaced.
    const named = harness({ sources: [sourceRow({ companyName: 'Our Name' })] });
    await run(named, w, { process: recorder().process });
    expect(named.source('cs1').companyName).toBe('Our Name');
  });

  it('three consecutive 404 answers switch the source off; its rows are archived on the first run 48 hours later, not before', async () => {
    const h = harness({ sources: [sourceRow({ lastSyncedAt: new Date(T0 - 24 * H), nextSyncAt: new Date(T0) })], jobs: [openJob('greenhouse', 'globalco:1'), openJob('greenhouse', 'globalco:2#cn', 'cn'), openJob('greenhouse', 'otherco:1')] });
    const w = world({ greenhouse: {} });
    const rec = recorder();
    const step = async (at: number) => {
      h.clock.now = at;
      return run(h, w, { process: rec.process });
    };
    expect(await step(T0)).toMatchObject({ boards: 1, boardErrors: 1, disabled: 0 });
    expect(h.source('cs1')).toMatchObject({ failCount: 1, lastError: 'board_not_found', enabled: true, nextSyncAt: new Date(T0 + H), lastSyncedAt: new Date(T0) });
    // Not due before its hour is up.
    expect(await step(T0 + 30 * MIN)).toMatchObject({ boards: 0 });
    expect(await step(T0 + H)).toMatchObject({ boardErrors: 1, disabled: 0 });
    expect(h.source('cs1')).toMatchObject({ failCount: 2, enabled: true });
    const offAt = T0 + 2 * H;
    expect(await step(offAt)).toMatchObject({ boardErrors: 1, disabled: 1 });
    expect(h.source('cs1')).toMatchObject({ failCount: 3, enabled: false, disabledAt: new Date(offAt), lastError: 'board_not_found' });
    // Switched off: never leased again, and its postings stay for 48 hours.
    expect(await step(offAt + 47 * H)).toMatchObject({ boards: 0, archivedDisabled: 0 });
    expect(h.jobs().every((r) => r.archivedAt === null)).toBe(true);
    expect(await step(offAt + 48 * H)).toMatchObject({ boards: 0, archivedDisabled: 2 });
    expect(h.jobs().filter((r) => r.closeReason === 'source_removed').map((r) => r.externalId)).toEqual(['globalco:1', 'globalco:2#cn']);
    expect(h.jobs().find((r) => r.externalId === 'otherco:1')!.archivedAt).toBeNull();
    // Handled once: later runs do no more work for it.
    const updateMany = vi.spyOn(h.fake.rAJob!, 'updateMany');
    expect(await step(offAt + 49 * H)).toMatchObject({ archivedDisabled: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(w.listings.get('globalco')).toBe(3);
    expect(rec.calls).toEqual([]);
  });

  it('a success between two failures starts the count over', async () => {
    const h = harness({ sources: [sourceRow({ failCount: 2, lastSyncedAt: new Date(T0 - H), nextSyncAt: new Date(T0), lastError: 'board_not_found' })] });
    await run(h, world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } }), { process: recorder().process });
    expect(h.source('cs1')).toMatchObject({ failCount: 0, lastError: null, enabled: true });
  });

  it('three timeouts (or 5xx answers, or network errors) never switch a source off: it backs off 1 h, 2 h, 3 h', async () => {
    for (const failure of [new BoardFetchError('timeout'), 503, new Error('socket hang up')]) {
      const h = harness({ sources: [sourceRow({ lastSyncedAt: new Date(T0 - 24 * H), nextSyncAt: new Date(T0) })], jobs: [openJob('greenhouse', 'globalco:1')] });
      const w = world({ greenhouse: { globalco: failure } });
      let at = T0;
      const waits: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        h.clock.now = at;
        expect(await run(h, w, { process: recorder().process })).toMatchObject({ boards: 1, boardErrors: 1, disabled: 0, closed: 0 });
        const next = time(h.source('cs1').nextSyncAt);
        waits.push((next - at) / H);
        at = next;
      }
      expect(waits, String(failure)).toEqual([1, 2, 3, 4]);
      expect(h.source('cs1')).toMatchObject({ enabled: true, failCount: 0, disabledAt: null });
      // A board that could not be read closes nothing.
      expect(h.jobs()[0]!.archivedAt).toBeNull();
    }
  });

  it('a hard failure in the wrong shape counts too (a redirect, not JSON, another shape)', async () => {
    const h = harness({ sources: [sourceRow({ failCount: 2, lastSyncedAt: new Date(T0 - H), nextSyncAt: new Date(T0) })] });
    const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => '<html>moved</html>' });
    expect(await run(h, { fetch }, { process: recorder().process })).toMatchObject({ disabled: 1 });
    expect(h.source('cs1')).toMatchObject({ enabled: false, lastError: 'not_json', failCount: 3, nextSyncAt: new Date(T0 + 48 * H) });
  });

  it('a board that answers 403 or 410 for good does not go on for ever: three such answers switch it off (403 is asked again only every 6 hours)', async () => {
    for (const [status, wait] of [[410, 1], [403, 6], [400, 1]] as const) {
      const h = harness({ sources: [sourceRow({ lastSyncedAt: new Date(T0 - 24 * H), nextSyncAt: new Date(T0) })], jobs: [openJob('greenhouse', 'globalco:1')] });
      const w = world({ greenhouse: { globalco: status } });
      let at = T0;
      for (let i = 1; i <= 3; i += 1) {
        h.clock.now = at;
        expect(await run(h, w, { process: recorder().process }), `${status} #${i}`).toMatchObject({ boards: 1, boardErrors: 1, disabled: i === 3 ? 1 : 0, closed: 0 });
        if (i < 3) {
          expect(h.source('cs1')).toMatchObject({ failCount: i, enabled: true, lastError: `http_${status}`, nextSyncAt: new Date(at + wait * H) });
          at += wait * H;
        }
      }
      expect(h.source('cs1')).toMatchObject({ enabled: false, failCount: 3, disabledAt: new Date(at), lastError: `http_${status}`, nextSyncAt: new Date(at + 48 * H) });
      // Its postings leave 48 hours later, like those of any source switched off by failures.
      h.clock.now = at + 48 * H;
      expect(await run(h, w, { process: recorder().process })).toMatchObject({ boards: 0, archivedDisabled: 1 });
    }
  });

  it('a 429 or a 408 never counts: the host is busy, not gone', async () => {
    for (const status of [429, 408]) {
      const h = harness({ sources: [sourceRow({ failCount: 2, lastSyncedAt: new Date(T0 - 24 * H), nextSyncAt: new Date(T0) })] });
      expect(await run(h, world({ greenhouse: { globalco: status } }), { process: recorder().process })).toMatchObject({ boardErrors: 1, disabled: 0 });
      expect(h.source('cs1')).toMatchObject({ enabled: true, failCount: 2, lastError: `http_${status}`, nextSyncAt: new Date(T0 + H) });
    }
  });

  it('archiveDisabledSources leaves a source an admin switched off alone (its rows were archived then) and one switched back on', async () => {
    const h = harness({
      sources: [
        sourceRow({ id: 'admin-off', boardToken: 'a', enabled: false, disabledAt: new Date(T0 - 100 * H), nextSyncAt: null }),
        sourceRow({ id: 'back-on', boardToken: 'b', enabled: true, disabledAt: null, nextSyncAt: new Date(T0 - H) }),
        sourceRow({ id: 'candidate', boardToken: 'c', enabled: false, origin: 'discovered' }),
        sourceRow({ id: 'too-soon', boardToken: 'd', enabled: false, failCount: 3, disabledAt: new Date(T0 - 47 * H), nextSyncAt: new Date(T0 + H) }),
      ],
      jobs: ['a', 'b', 'c', 'd'].map((t) => openJob('greenhouse', `${t}:1`)),
    });
    expect(await archiveDisabledSources(h.db, new Date(T0))).toBe(0);
    expect(h.jobs().every((r) => r.archivedAt === null)).toBe(true);
  });
});

// ── SmartRecruiters: a large board finishes over successive runs ─────────

describe('a board with posting texts still unread is due again at once', () => {
  const postings = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}`, country: 'cn', city: 'Suzhou' }));

  it('pendingDetails > 0 -> nextSyncAt = now; the board is read once per run and continues at the next, without waiting for its interval', async () => {
    const h = harness({ sources: [sourceRow({ id: 'sr', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countries: ['CN'] })] });
    const w = world({ sr: { BoschGroup: { company: 'Bosch Group', postings: postings(250) } } });
    const stored = h.jobs();
    const rec = recorder();
    const texts = () => w.urls.filter((u) => /\/postings\/p\d+$/.test(u)).length;
    const first = await run(h, w, { process: rec.process });
    expect(first).toMatchObject({ boards: 1, pending: 1, received: 100 });
    // Read once this run, although it is due again already.
    expect(h.leases.filter((l) => l.leased.includes('sr'))).toHaveLength(1);
    expect(h.leases.at(-1)).toMatchObject({ exclude: ['sr'], leased: [] });
    expect(texts()).toBe(100);
    expect(h.source('sr')).toMatchObject({ nextSyncAt: new Date(T0), lastSyncedAt: new Date(T0), lastJobCount: 250, lastError: null });
    for (const id of rec.calls.at(-1)!.ids) stored.push(openJob('smartrecruiters', id, 'cn'));

    // The next cron run, 5 minutes later: the next 100, and nothing is closed.
    h.clock.now = T0 + 5 * MIN;
    expect(await run(h, w, { process: rec.process })).toMatchObject({ boards: 1, pending: 1, received: 100, closed: 0 });
    for (const id of rec.calls.at(-1)!.ids) stored.push(openJob('smartrecruiters', id, 'cn'));
    h.clock.now = T0 + 10 * MIN;
    const third = await run(h, w, { process: rec.process });
    expect(third).toMatchObject({ boards: 1, pending: 0, received: 100, closed: 0 });
    expect(new Set(rec.calls.flatMap((c) => c.ids)).size).toBe(250);
    // Complete: back on its interval (it changed, so 2 hours).
    expect(h.source('sr').nextSyncAt).toEqual(new Date(T0 + 10 * MIN + 2 * H));
    expect(rec.calls.every((c) => c.market === 'cn' && c.brand === 'goapply')).toBe(true);
  });

  it('a posting whose text request always answers 403 does not bring the board back every 5 minutes: the next read is one hour away', async () => {
    const h = harness({
      sources: [sourceRow({ id: 'sr', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countries: ['CN'], lastChangeAt: new Date(T0 - 100 * H) })],
      // Two of the three listed postings are stored already.
      jobs: [openJob('smartrecruiters', 'BoschGroup:p0000', 'cn'), openJob('smartrecruiters', 'BoschGroup:p0001', 'cn')],
    });
    const w = world({ sr: { BoschGroup: { postings: postings(3), textStatus: (id) => (id === 'p0002' ? 403 : undefined) } } });
    const rec = recorder(() => 0);
    const first = await run(h, w, { process: rec.process });
    // The board itself was read: no error on it, nothing closed, its two readable postings refreshed.
    expect(first).toMatchObject({ boards: 1, boardErrors: 0, pending: 1, received: 2, closed: 0 });
    expect(h.source('sr')).toMatchObject({ lastError: null, failCount: 0, lastSyncedAt: new Date(T0), nextSyncAt: new Date(T0 + H) });
    // The next two cron runs leave it alone.
    for (const minutes of [5, 10]) {
      h.clock.now = T0 + minutes * MIN;
      expect(await run(h, w, { process: rec.process })).toMatchObject({ boards: 0 });
    }
    expect(w.listings.get('BoschGroup')).toBe(1);
    // An hour later it is read again, and waits another hour.
    h.clock.now = T0 + H;
    expect(await run(h, w, { process: rec.process })).toMatchObject({ boards: 1, pending: 1 });
    expect(h.source('sr').nextSyncAt).toEqual(new Date(T0 + 2 * H));
  });

  it('a rate limit on the texts (429) is answered by reading less often: no further text in that run, and the board waits an hour although a backlog is pending', async () => {
    const h = harness({ sources: [sourceRow({ id: 'sr', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countries: ['CN'] })] });
    const w = world({ sr: { BoschGroup: { postings: postings(250), textStatus: () => 429 } } });
    const tally = await run(h, w, { process: recorder().process });
    expect(tally).toMatchObject({ boards: 1, boardErrors: 0, pending: 1, received: 0 });
    // The four requests in flight when the first 429 came back, and no more.
    expect(w.urls.filter((u) => /\/postings\/p\d+$/.test(u)).length).toBeLessThanOrEqual(4);
    expect(h.source('sr')).toMatchObject({ lastError: null, nextSyncAt: new Date(T0 + H) });
    h.clock.now = T0 + 5 * MIN;
    expect(await run(h, w, { process: recorder().process })).toMatchObject({ boards: 0 });
  });

  it('one text that keeps failing does not hold up a backlog that is moving', async () => {
    const h = harness({ sources: [sourceRow({ id: 'sr', ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group', countries: ['CN'] })] });
    const w = world({ sr: { BoschGroup: { postings: postings(250), textStatus: (id) => (id === 'p0007' ? 500 : undefined) } } });
    expect(await run(h, w, { process: recorder().process })).toMatchObject({ boards: 1, pending: 1, received: 99 });
    expect(h.source('sr').nextSyncAt).toEqual(new Date(T0));
  });

  it('the per-run budget is ATS_SR_DETAILS_PER_RUN', async () => {
    const h = harness({ sources: [sourceRow({ id: 'sr', ats: 'smartrecruiters', boardToken: 'BoschGroup', countries: ['CN'] })] });
    const w = world({ sr: { BoschGroup: { postings: postings(60) } } });
    const tally = await run(h, w, { env: { ATS_SR_DETAILS_PER_RUN: '25' }, process: recorder().process });
    expect(tally).toMatchObject({ received: 25, pending: 1 });
  });

  it('it is leased after boards that were never read', async () => {
    const h = harness({
      sources: [
        // A backlog board, due since an earlier run.
        sourceRow({ id: 'backlog', ats: 'smartrecruiters', boardToken: 'BoschGroup', countries: ['CN'], lastSyncedAt: new Date(T0 - 5 * MIN), nextSyncAt: new Date(T0 - 5 * MIN) }),
        sourceRow({ id: 'overdue', boardToken: 'overdue', lastSyncedAt: new Date(T0 - 30 * H), nextSyncAt: new Date(T0 - 6 * H) }),
        sourceRow({ id: 'never-a', boardToken: 'nevera' }),
        sourceRow({ id: 'never-b', boardToken: 'neverb' }),
      ],
    });
    const leased = await leaseDueBoards(h.db, 10);
    expect(leased.map((s) => s.id)).toEqual(['never-a', 'never-b', 'overdue', 'backlog']);
  });
});

// ── Budget ───────────────────────────────────────────────────────────────

describe('the run stays inside its budget', () => {
  it('stops leasing with under 20 s left; a board read but not written has its lease freed, so the next run takes it first', async () => {
    const tokens = Array.from({ length: 30 }, (_, i) => `co${i}`);
    const h = harness({ sources: tokens.map((t, i) => sourceRow({ id: `s${String(i).padStart(2, '0')}`, boardToken: t, createdAt: new Date(T0 - (100 - i) * H) })) });
    let spent = 0;
    // Each listing costs 10 s of the run's 240 s.
    const w = world({ greenhouse: Object.fromEntries(tokens.map((t) => [t, [ghJob(t, 1, 'Singapore')]])), onRequest: () => void (spent += 10_000) });
    const rec = recorder();
    const tally = await run(h, w, { budget: createBudget(240_000, () => spent), process: rec.process });
    expect(BOARD_SYNC_RESERVE_MS).toBe(20_000);
    // Round 1: 12 boards read (120 s) and written. Round 2: 12 read (240 s): no time left to write them.
    expect(tally).toMatchObject({ boards: 12, stoppedBy: 'budget' });
    expect(rec.calls).toHaveLength(12);
    expect(h.leases).toHaveLength(2);
    const written = h.sources().filter((r) => r.lastSyncedAt !== null);
    const freed = h.sources().filter((r) => r.lastSyncedAt === null && time(r.nextSyncAt) === T0);
    const untouched = h.sources().filter((r) => r.lastSyncedAt === null && r.nextSyncAt === null);
    expect([written.length, freed.length, untouched.length]).toEqual([12, 12, 6]);
  });

  it('with no time at all it leases nothing', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    const tally = await run(h, w, { budget: createBudget(15_000, () => 0), process: recorder().process });
    expect(tally).toMatchObject({ boards: 0, stoppedBy: 'budget', candidatesChecked: 0 });
    expect(h.leases).toEqual([]);
    expect(w.urls).toEqual([]);
  });

  it('with no brand that writes board postings nothing is leased and no request is made: the boards are not read to be dropped (M4 cross-review)', async () => {
    // Before: every due board was downloaded once a day and its postings counted as dropped.
    const cases: Array<[string, readonly ('roboapply' | 'goapply')[], Record<string, string>]> = [
      ['the mainland stack with recruitment-info mode off', ['goapply'], { CN_RECRUITMENT_INFO_MODE: 'off' }],
      ['RoboApply narrowed to providers without ats_public', ['roboapply'], { JOB_PROVIDERS_ROBOAPPLY: 'jsearch,bank_robohire' }],
      ['both brands, neither writing boards', BOTH, { CN_RECRUITMENT_INFO_MODE: 'off', JOB_PROVIDERS_ROBOAPPLY: 'jsearch' }],
    ];
    for (const [name, brands, env] of cases) {
      expect(writingBrands(brands, env), name).toEqual({});
      // A due board, and a candidate waiting for its list-only check.
      const h = harness({ sources: [sourceRow(), sourceRow({ id: 'cand', boardToken: 'candco', companyName: 'Cand Co', enabled: false, origin: 'discovered' })] });
      const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')], candco: [ghJob('candco', 1, 'Singapore')] }, names: { candco: 'Cand Co' } });
      const rec = recorder();
      const tally = await run(h, w, { brands, env, process: rec.process });
      expect(w.urls, name).toEqual([]);
      expect(h.leases, name).toEqual([]);
      expect(rec.calls, name).toEqual([]);
      expect(tally, name).toMatchObject({ boards: 0, calls: 0, candidatesChecked: 0, droppedIntl: 0, droppedCn: 0 });
      // Nothing was stamped: the boards are as they were, and are read when a brand writes them again.
      expect(h.source('cs1'), name).toMatchObject({ lastSyncedAt: null, nextSyncAt: null, enabled: true });
      expect(h.source('cand'), name).toMatchObject({ enabled: false, lastSyncedAt: null });
      // The cron step answers "no work".
      expect(await runJobsBoards(createBudget(240_000, () => 0), { db: h.db, now: () => new Date(h.clock.now), env, fetch: w.fetch, brands, loadSeeds: async () => null, process: rec.process, kick: () => undefined }), name).toEqual({ skipped: 'no_work' });
    }
    // One writing brand is enough to read (the other market's postings are dropped, as before).
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    expect(await run(h, w, { env: { CN_RECRUITMENT_INFO_MODE: 'off' }, process: recorder().process })).toMatchObject({ boards: 1 });
    expect(w.urls).toHaveLength(1);
  });

  it('with the kill switch on the run reports skipped and touches neither a board nor the database', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    const loadSeeds = vi.fn(async () => null);
    const findMany = vi.spyOn(h.fake.rACareerSiteSource!, 'findMany');
    const res = await runBoardSync({ db: h.db, budget: createBudget(240_000, () => 0), env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' }, fetch: w.fetch, brands: BOTH, loadSeeds });
    expect(res).toEqual({ skipped: 'kill_switch' });
    expect(w.urls).toEqual([]);
    expect(h.leases).toEqual([]);
    expect(loadSeeds).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ── The cron step ────────────────────────────────────────────────────────

describe('runJobsBoards (the jobs-boards cron step)', () => {
  const budget = () => createBudget(240_000, () => 0);

  it('answers skipped: kill_switch, skipped: no_work, or what the run did', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    const deps = { db: h.db, now: () => new Date(h.clock.now), fetch: w.fetch, brands: BOTH, loadSeeds: async () => null, process: recorder().process, kick: () => undefined };
    expect(await runJobsBoards(budget(), { ...deps, env: { ATS_PUBLIC_SOURCES_DISABLED: 'true' } })).toEqual({ skipped: 'kill_switch' });
    expect(await runJobsBoards(budget(), { ...deps, env: {} })).toMatchObject({ processed: 1, boards: 1, inserted: 1, stoppedBy: 'idle' });
    // Nothing is due any more.
    expect(await runJobsBoards(budget(), { ...deps, env: {} })).toEqual({ skipped: 'no_work' });
  });

  it('loads the seed files first: on an empty list the seeded boards exist, are switched on and are read in that same run', async () => {
    const h = harness();
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      if (u.hostname === 'api.lever.co') return ok([]);
      if (u.hostname === 'api.smartrecruiters.com') return ok({ totalFound: 0, content: [] });
      return ok({ jobs: [] });
    };
    const res = await runJobsBoards(budget(), { db: h.db, now: () => new Date(h.clock.now), env: {}, fetch, brands: BOTH, process: recorder().process, kick: () => undefined });
    const seeded = careerSeedBoards().length;
    expect(res).toMatchObject({ seedBoardsAdded: seeded, boards: seeded, boardErrors: 0 });
    expect(h.sources()).toHaveLength(seeded);
    expect(h.sources().every((r) => r.origin === 'seed' && r.enabled === true && r.lastSyncedAt instanceof Date)).toBe(true);
    // A second run loads nothing and has nothing due.
    expect(await runJobsBoards(budget(), { db: h.db, now: () => new Date(h.clock.now), env: {}, fetch, brands: BOTH, process: recorder().process })).toEqual({ skipped: 'no_work' });
  });

  it('a seed file that cannot be loaded never stops the sync', async () => {
    const h = harness({ sources: [sourceRow()] });
    const w = world({ greenhouse: { globalco: [ghJob('globalco', 1, 'Singapore')] } });
    const tally = await run(h, w, {
      loadSeeds: async () => {
        throw new Error('seeds.tw.json: board 3 has no note');
      },
      process: recorder().process,
    });
    expect(tally).toMatchObject({ boards: 1, seedBoardsAdded: 0 });
  });
});

// ── Candidates (JI-3) ────────────────────────────────────────────────────

describe('validateCandidates: one list-only read, switched on only when the board answers and its company matches', () => {
  const candidate = (id: string, over: Row = {}) => sourceRow({ id, enabled: false, origin: 'discovered', discoveredFrom: 'jsearch:abc', ...over });
  const at = () => new Date(T0);

  it('Greenhouse: postings and the stated name Acme switch it on, due at once; the next sync reads it', async () => {
    const h = harness({ sources: [candidate('c1', { boardToken: 'acme', companyName: 'Acme' })] });
    const w = world({ greenhouse: { acme: [ghJob('acme', 1, 'Singapore')] }, names: { acme: 'Acme' } });
    const res = await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch });
    expect(res).toMatchObject({ checked: 1, enabled: 1, outcomes: { ok: 1 } });
    // List-only: the listing without the posting texts, and the board's own name (one more documented request).
    expect(w.urls).toEqual(['https://boards-api.greenhouse.io/v1/boards/acme/jobs', 'https://boards-api.greenhouse.io/v1/boards/acme']);
    expect(h.source('c1')).toMatchObject({ enabled: true, nextSyncAt: null, lastError: null, lastSyncedAt: null, origin: 'discovered' });
    const rec = recorder();
    expect(await run(h, w, { process: rec.process })).toMatchObject({ boards: 1, received: 1, candidatesChecked: 0 });
    expect(rec.calls[0]!.ids).toEqual(['acme:1']);
  });

  it('a board named Other Corp leaves it off with validation:name_mismatch and is not tried again', async () => {
    const h = harness({ sources: [candidate('c1', { boardToken: 'acme', companyName: 'Acme' })] });
    const w = world({ greenhouse: { acme: [ghJob('acme', 1, 'Singapore')] }, names: { acme: 'Other Corp' } });
    expect(await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch })).toMatchObject({ checked: 1, enabled: 0, outcomes: { name_mismatch: 1 } });
    expect(h.source('c1')).toMatchObject({ enabled: false, lastError: 'validation:name_mismatch', lastSyncedAt: new Date(T0) });
    w.urls.length = 0;
    expect(await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch })).toMatchObject({ checked: 0 });
    expect(w.urls).toEqual([]);
    // A Greenhouse board that states no name cannot be confirmed either.
    const silent = harness({ sources: [candidate('c2', { boardToken: 'quiet', companyName: 'Loud Inc' })] });
    await validateCandidates(silent.db, 20, { now: at, env: {}, fetch: world({ greenhouse: { quiet: [ghJob('quiet', 1, 'Singapore')] } }).fetch });
    expect(silent.source('c2')).toMatchObject({ enabled: false, lastError: 'validation:name_unconfirmed' });
  });

  it('Lever and Ashby state no company: the board id must be the company name as one word, or the first label of its domain; an empty board is never switched on', async () => {
    const posting = (id: string) => ({ id, text: 'Role', hostedUrl: `https://jobs.lever.co/x/${id}` });
    const ashbyJob = (id: string) => ({ id, title: 'Role', jobUrl: `https://jobs.ashbyhq.com/x/${id}` });
    const h = harness({
      sources: [
        candidate('ok-name', { ats: 'lever', boardToken: 'pinecloud', companyName: 'Pine Cloud' }),
        candidate('empty', { ats: 'lever', boardToken: 'emptyco', companyName: 'Emptyco' }),
        candidate('suffix', { ats: 'lever', boardToken: 'shopback-2', companyName: 'ShopBack' }),
        candidate('ok-domain', { ats: 'ashby', boardToken: 'kraken', companyName: 'Payward' }),
        candidate('no-domain', { ats: 'ashby', boardToken: 'islandlabs', companyName: 'Archipelago' }),
        // Registered without a company name: the name is the board id, which confirms nothing by itself.
        candidate('no-name', { ats: 'lever', boardToken: 'shopfront-2', companyName: 'shopfront-2', origin: 'import', discoveredFrom: null }),
        candidate('no-name-ashby', { ats: 'ashby', boardToken: 'harbor.example', companyName: 'harbor.example' }),
        // ...unless an employer we hold under that name has a domain that starts with it.
        candidate('no-name-domain', { ats: 'ashby', boardToken: 'northwind', companyName: 'northwind', origin: 'import', discoveredFrom: null }),
      ],
      companies: [
        { id: 'co1', market: 'intl', nameNormalized: normalizeCompanyName('Payward'), slug: 'payward', domain: 'kraken.com' },
        { id: 'co2', market: 'intl', nameNormalized: normalizeCompanyName('Northwind'), slug: 'northwind', domain: 'northwind.example' },
      ],
    });
    const w = world({
      lever: { pinecloud: [posting('a')], emptyco: [], 'shopback-2': [posting('b')], 'shopfront-2': [posting('c')] },
      ashby: { kraken: [ashbyJob('k')], islandlabs: [ashbyJob('i')], 'harbor.example': [ashbyJob('h')], northwind: [ashbyJob('n')] },
    });
    const res = await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch });
    expect(res).toMatchObject({ checked: 8, enabled: 3, outcomes: { ok: 3, empty_board: 1, name_unconfirmed: 4 } });
    for (const id of ['no-name', 'no-name-ashby']) expect(h.source(id), id).toMatchObject({ enabled: false, lastError: 'validation:name_unconfirmed', lastSyncedAt: new Date(T0) });
    expect(h.source('no-name-domain')).toMatchObject({ enabled: true, lastError: null });
    expect(h.source('ok-name')).toMatchObject({ enabled: true, nextSyncAt: null });
    expect(h.source('ok-domain')).toMatchObject({ enabled: true });
    expect(h.source('empty')).toMatchObject({ enabled: false, lastError: 'validation:empty_board', lastSyncedAt: new Date(T0) });
    expect(h.source('suffix')).toMatchObject({ enabled: false, lastError: 'validation:name_unconfirmed' });
    expect(h.source('no-domain')).toMatchObject({ enabled: false, lastError: 'validation:name_unconfirmed' });
  });

  it('SmartRecruiters: the listing itself states the company; a candidate registered without a name takes the stated one', async () => {
    const h = harness({
      sources: [
        candidate('sr', { ats: 'smartrecruiters', boardToken: 'HarborFoods', companyName: 'Harbor Foods' }),
        candidate('gh', { boardToken: 'acme', companyName: 'acme', origin: 'import', discoveredFrom: null }),
      ],
    });
    const w = world({ sr: { HarborFoods: { company: 'Harbor Foods Ltd', postings: [{ id: 'p1', country: 'tw', city: 'Taichung' }] } }, greenhouse: { acme: [ghJob('acme', 1, 'Singapore')] }, names: { acme: 'Acme Robotics' } });
    expect(await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch })).toMatchObject({ checked: 2, enabled: 2 });
    // No posting text was asked for.
    expect(w.urls.some((u) => /\/postings\/p1$/.test(u))).toBe(false);
    // A discovered source takes the name the board states: its own came from the posting that linked to the board.
    expect(h.source('sr')).toMatchObject({ enabled: true, companyName: 'Harbor Foods Ltd' });
    expect(h.source('gh')).toMatchObject({ enabled: true, companyName: 'Acme Robotics', origin: 'import' });
  });

  it('a name is matched on whole words: "Arc" is not "Search Party"; an imported source keeps the name its admin gave', async () => {
    const h = harness({
      sources: [
        candidate('arc', { boardToken: 'arc', companyName: 'Arc' }),
        candidate('bosch', { ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch', origin: 'import', discoveredFrom: null }),
      ],
    });
    const w = world({ greenhouse: { arc: [ghJob('arc', 1, 'Singapore')] }, names: { arc: 'Search Party' }, sr: { BoschGroup: { company: 'Bosch Group', postings: [{ id: 'p1', country: 'cn', city: 'Wuxi' }] } } });
    expect(await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch })).toMatchObject({ checked: 2, enabled: 1, outcomes: { name_mismatch: 1, ok: 1 } });
    expect(h.source('arc')).toMatchObject({ enabled: false, companyName: 'Arc', lastError: 'validation:name_mismatch' });
    expect(h.source('bosch')).toMatchObject({ enabled: true, companyName: 'Bosch' });
  });

  it('SmartRecruiters: a candidate is checked from ONE request, however large its board is', async () => {
    const big = Array.from({ length: 2300 }, (_, i) => ({ id: `p${i}`, country: i % 2 ? 'de' : 'cn', city: 'X' }));
    const h = harness({ sources: [candidate('sr', { ats: 'smartrecruiters', boardToken: 'BoschGroup', companyName: 'Bosch Group' })] });
    const w = world({ sr: { BoschGroup: { company: 'Bosch Group', postings: big } } });
    const res = await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch });
    expect(res).toMatchObject({ checked: 1, enabled: 1, calls: 1 });
    expect(w.urls).toEqual(['https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=0']);
  });

  it('a board that is not there, or that refuses us, is final; a read that failed in passing is tried again later, a bounded number of times', async () => {
    const h = harness({
      sources: [
        candidate('gone', { boardToken: 'gone', companyName: 'Gone', updatedAt: new Date(T0 - 4 * H) }),
        candidate('refused', { boardToken: 'refused', companyName: 'Refused', updatedAt: new Date(T0 - 3 * H) }),
        candidate('busy', { ats: 'smartrecruiters', boardToken: 'BusyCo', companyName: 'Busy Co', updatedAt: new Date(T0 - 2 * H) }),
        candidate('fresh', { boardToken: 'acme', companyName: 'Acme', updatedAt: new Date(T0 - H) }),
      ],
    });
    const w = world({ greenhouse: { acme: [ghJob('acme', 1, 'Singapore')], refused: 403 }, names: { acme: 'Acme' }, sr: { BusyCo: { postings: [], status: 503 } } });
    let clock = T0;
    const check = (limit = 20) => validateCandidates(h.db, limit, { now: () => new Date(clock), env: {}, fetch: w.fetch, concurrency: 1 });
    const first = await check(3);
    expect(first.outcomes).toEqual({ board_not_found: 1, http_403: 1, http_503: 1 });
    expect(h.source('gone')).toMatchObject({ enabled: false, lastError: 'validation:board_not_found', lastSyncedAt: new Date(T0) });
    expect(h.source('refused')).toMatchObject({ enabled: false, lastError: 'validation:http_403', lastSyncedAt: new Date(T0) });
    // Not final: no check time, so it stays a candidate. It waits an hour and is counted.
    expect(h.source('busy')).toMatchObject({ enabled: false, lastError: 'validation:http_503', lastSyncedAt: null, failCount: 1, nextSyncAt: new Date(T0 + H) });
    // The next runs do not ask it again before its time: only the candidate not looked at yet.
    const busyCalls = () => w.listings.get('BusyCo') ?? 0;
    expect(busyCalls()).toBe(1);
    clock = T0 + 5 * MIN;
    expect((await check()).outcomes).toEqual({ ok: 1 });
    expect(h.source('fresh').enabled).toBe(true);
    clock = T0 + 55 * MIN;
    expect(await check()).toMatchObject({ checked: 0 });
    expect(busyCalls()).toBe(1);
    // Second attempt after 1 h: waits 2 h. Third attempt: final, stamped, never asked again.
    clock = T0 + H;
    expect((await check()).outcomes).toEqual({ http_503: 1 });
    expect(h.source('busy')).toMatchObject({ failCount: 2, lastSyncedAt: null, nextSyncAt: new Date(T0 + 3 * H) });
    clock = T0 + 2 * H;
    expect(await check()).toMatchObject({ checked: 0 });
    clock = T0 + 3 * H;
    expect((await check()).outcomes).toEqual({ http_503: 1 });
    expect(h.source('busy')).toMatchObject({ enabled: false, failCount: 3, lastError: 'validation:http_503', lastSyncedAt: new Date(T0 + 3 * H), nextSyncAt: null });
    expect(busyCalls()).toBe(3);
    for (const later of [4, 24, 24 * 30]) {
      clock = T0 + later * H;
      expect(await check()).toMatchObject({ checked: 0 });
    }
    expect(busyCalls()).toBe(3);
  });

  it('a candidate whose read passes on a later attempt is switched on with a clean slate', async () => {
    const h = harness({ sources: [candidate('busy', { ats: 'smartrecruiters', boardToken: 'BusyCo', companyName: 'Busy Co' })] });
    const w = world({ sr: { BusyCo: { company: 'Busy Co', postings: [{ id: 'p1', country: 'tw', city: 'Taipei' }], status: (call) => (call === 1 ? 503 : undefined) } } });
    expect((await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch })).outcomes).toEqual({ http_503: 1 });
    expect((await validateCandidates(h.db, 20, { now: () => new Date(T0 + H), env: {}, fetch: w.fetch })).outcomes).toEqual({ ok: 1 });
    expect(h.source('busy')).toMatchObject({ enabled: true, failCount: 0, lastError: null, nextSyncAt: null });
  });

  it('a read cut short because the run ran out of time says nothing about the board: the candidate is left as it was', async () => {
    const h = harness({ sources: [candidate('c1', { boardToken: 'acme', companyName: 'Acme' })] });
    const stop = new AbortController();
    const fetch: FetchLike = async () => {
      stop.abort();
      throw new Error('aborted');
    };
    expect(await validateCandidates(h.db, 20, { now: at, env: {}, fetch, signal: stop.signal })).toMatchObject({ enabled: 0, outcomes: {} });
    expect(h.source('c1')).toMatchObject({ enabled: false, lastError: null, lastSyncedAt: null, failCount: 0, nextSyncAt: null });
  });

  it('checks at most the per-run limit, oldest first; leaves alone a system without a connector, an admin\'s own source and anything already switched on or off', async () => {
    const many = Array.from({ length: 30 }, (_, i) => candidate(`c${String(i).padStart(2, '0')}`, { boardToken: `co${i}`, companyName: `co${i}`, updatedAt: new Date(T0 - (100 - i) * H) }));
    const h = harness({
      sources: [
        ...many,
        candidate('workable', { ats: 'workable', boardToken: 'northwind', updatedAt: new Date(T0 - 500 * H) }),
        candidate('lever-eu', { ats: 'lever_eu', boardToken: 'eurofirm', updatedAt: new Date(T0 - 500 * H) }),
        sourceRow({ id: 'admin-off', boardToken: 'adminoff', enabled: false, origin: 'admin', updatedAt: new Date(T0 - 500 * H) }),
        candidate('switched-off', { boardToken: 'switchedoff', disabledAt: new Date(T0 - H), updatedAt: new Date(T0 - 500 * H) }),
        sourceRow({ id: 'import-on', boardToken: 'importon', enabled: true, origin: 'import', updatedAt: new Date(T0 - 500 * H) }),
      ],
    });
    const w = world({ greenhouse: Object.fromEntries(many.map((m) => [String(m.boardToken), [ghJob(String(m.boardToken), 1, 'Singapore')]])), names: Object.fromEntries(many.map((m) => [String(m.boardToken), String(m.boardToken)])) });
    const res = await validateCandidates(h.db, 20, { now: at, env: {}, fetch: w.fetch });
    expect(res).toMatchObject({ checked: 20, enabled: 20 });
    expect(h.sources().filter((r) => r.enabled === true && r.origin === 'discovered').map((r) => r.id).sort()).toEqual(many.slice(0, 20).map((m) => m.id));
    for (const id of ['workable', 'lever-eu', 'admin-off', 'switched-off']) expect(h.source(id), id).toMatchObject({ enabled: false, lastError: null, lastSyncedAt: null });
    expect(w.urls.some((u) => /northwind|eurofirm|adminoff|switchedoff|importon/.test(u))).toBe(false);
    expect(await validateCandidates(h.db, 0, { now: at, env: {}, fetch: w.fetch })).toMatchObject({ checked: 0 });
  });

  it('the board sync validates up to ATS_DISCOVERY_VALIDATIONS_PER_RUN candidates before its loop, and reads the ones it switched on', async () => {
    const many = Array.from({ length: 25 }, (_, i) => candidate(`c${String(i).padStart(2, '0')}`, { boardToken: `co${i}`, companyName: `co${i}`, updatedAt: new Date(T0 - (100 - i) * H) }));
    const greenhouse = Object.fromEntries(many.map((m) => [String(m.boardToken), [ghJob(String(m.boardToken), 1, 'Singapore')]]));
    const names = Object.fromEntries(many.map((m) => [String(m.boardToken), String(m.boardToken)]));
    const h = harness({ sources: many });
    const tally = await run(h, world({ greenhouse, names }), { process: recorder().process });
    expect(tally).toMatchObject({ candidatesChecked: 20, candidatesEnabled: 20, boards: 20 });
    const few = harness({ sources: many });
    expect(await run(few, world({ greenhouse, names }), { env: { ATS_DISCOVERY_VALIDATIONS_PER_RUN: '3' }, process: recorder().process })).toMatchObject({ candidatesChecked: 3, boards: 3 });
    const none = harness({ sources: many });
    expect(await run(none, world({ greenhouse, names }), { env: { ATS_DISCOVERY_VALIDATIONS_PER_RUN: '0' }, process: recorder().process })).toMatchObject({ candidatesChecked: 0, boards: 0 });
  });
});

// ── The schedule at scale ────────────────────────────────────────────────

describe('1,000 boards at 60 boards per 5-minute run', () => {
  it('every changed board is read within 2 hours and every quiet board within 12 hours; no run reads more than its capacity', async () => {
    const BOARDS = 1000;
    const HOT = 200;
    const CAPACITY = 60;
    const tokens = Array.from({ length: BOARDS }, (_, i) => `b${i}`);
    const isHot = (token: string) => Number(token.slice(1)) < HOT;
    // Quiet boards last changed 3 days ago (inside the 14-day window for the whole simulated day). Every board has
    // been read before (`lastJobCount`), so a posting a read adds is a change and not the board's first load.
    const h = harness({ sources: tokens.map((t, i) => sourceRow({ id: `s${i}`, boardToken: t, companyName: `Co ${i}`, lastJobCount: 1, lastChangeAt: i < HOT ? null : new Date(T0 - 72 * H) })) });
    const reads = new Map<string, number[]>(tokens.map((t) => [t, []]));
    let readsThisRun = 0;
    const fetch: FetchLike = async (url) => {
      const token = /\/boards\/([^/]+)\/jobs/.exec(url)![1]!;
      reads.get(token)!.push(h.clock.now);
      readsThisRun += 1;
      return ok({ jobs: [ghJob(token, 1, 'Singapore')] });
    };
    // A changed board gains a posting at every read.
    const rec = recorder((c) => (isHot(c.ids[0]!.split(':')[0]!) ? 1 : 0));
    const perRun: number[] = [];
    const RUNS = (26 * H) / (5 * MIN);
    for (let i = 0; i < RUNS; i += 1) {
      h.clock.now = T0 + i * 5 * MIN;
      readsThisRun = 0;
      rec.calls.length = 0;
      // The run's time is used up once it has read its capacity.
      const budget = { remainingMs: () => (readsThisRun >= CAPACITY ? 0 : 240_000), exhausted: (reserve = 0) => (readsThisRun >= CAPACITY ? 0 : 240_000) <= reserve };
      await run(h, { fetch }, { budget, process: rec.process });
      perRun.push(readsThisRun);
    }
    expect(Math.max(...perRun)).toBe(CAPACITY);
    const slack = 10 * MIN;
    let hotGap = 0;
    let quietGap = 0;
    let firstRead = 0;
    for (const token of tokens) {
      const times = reads.get(token)!;
      expect(times.length, token).toBeGreaterThan(0);
      firstRead = Math.max(firstRead, times[0]! - T0);
      // The gaps between reads, and from the last read to the end of the simulation.
      const end = T0 + (RUNS - 1) * 5 * MIN;
      const gaps = [...times.slice(1).map((t, i) => t - times[i]!), end - times.at(-1)!];
      const worst = Math.max(...gaps);
      if (isHot(token)) hotGap = Math.max(hotGap, worst);
      else quietGap = Math.max(quietGap, worst);
    }
    // New boards immediately: all 1,000 within 1,000 / 60 runs.
    expect(firstRead).toBeLessThanOrEqual(Math.ceil(BOARDS / CAPACITY) * 5 * MIN);
    expect(hotGap).toBeLessThanOrEqual(2 * H + slack);
    expect(quietGap).toBeLessThanOrEqual(12 * H + slack);
    // And not more often than needed: a quiet board is not read every 2 hours.
    const quietReads = reads.get(`b${BOARDS - 1}`)!.length;
    expect(quietReads).toBeLessThanOrEqual(4);
    expect(reads.get('b0')!.length).toBeGreaterThanOrEqual(12);
  }, 60_000);
});
