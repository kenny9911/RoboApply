// @vitest-environment node
// WP-41 acceptance (R-14, CN-L-04): with CN_RECRUITMENT_INFO_MODE=off no
// GoApply route returns third-party postings. Route tests across the feed,
// job and alert routers as mounted by features/index.ts (FEATURE_MOUNTS),
// with injected auth and no database.
//
//   - POSTING_ONLY (feed, public feed, visitor alerts): every route answers
//     404 feature_disabled on GoApply in mode off (and not in partner mode);
//   - SCANNED (job detail, SEO job pages, this area, and since the INT wave:
//     Ready to apply, the extension, People, MATCH and saved searches): every
//     implemented route is called and its 2xx body scanned; each reader must
//     yield at least one scanned 2xx body, so the check cannot pass with
//     nothing scanned. Each added router runs its REAL service over fakes
//     that hold one GoHire posting, seeded through the router's own seam, and
//     has a control with postings allowed, so "nothing leaked" is never a
//     vacuous pass. A route that is still an FND-5 stub is listed as it.todo
//     naming its owner;
//   - jobs.companies: the real CompanyReadService over a fake database holding
//     one public GoHire posting, read by a signed-in user. Mode-gated since
//     the Wave 3 gate applied Request R41-1 (the router ANDs cnPostingsWhere);
//   - offers (WP-64): the benchmark's posted pay over a fake database holding
//     MIN_SAMPLE public GoHire postings with pay (Wave 5 gate);
//   - the tracker and the seeker alerts / inbox readers are covered by their
//     own areas' mode-off tests (COVERED_ELSEWHERE; join J8, INT gate). This
//     file only checks that those test files are still there;
//   - the two legacy routers outside FEATURE_MOUNTS that return postings (INT
//     gate): the job-search API (`/api/v1/job-search`, `/api/v1/roboapply/v2/
//     job-search`) is closed on GoApply in every mode, checked here with the
//     real brand middleware; `POST /v2/discover/run` is covered by
//     roboapply/v2/routes/legacyAiGates.test.ts (COVERED_ELSEWHERE).

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler, Router } from 'express';

vi.mock('../../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setRequestUserId: vi.fn() },
}));

import { FEATURE_MOUNTS, type FeatureMount, type FeatureRouterDeps } from '../../../index.js';
import { setFlagOverrideLoader } from '../../../../platform/flags.js';
import { isStubHandler } from '../../../../platform/http.js';
import { fakeAuth, startRouteHarness, type HarnessResponse, type RouteHarness } from '../../../../test/routeHarness.js';
import { createCompanyReadService, type CompaniesDb } from '../../../jobs/companies/service.js';
import { createJobDetailService, type JobDetailDb } from '../../../jobs/detail/service.js';
import { getCurrentBrandOrDefault } from '../../../../platform/brand/index.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';
import { MIN_SAMPLE } from '../../../../platform/http.js';
import { createOffersRouter, createOffersService, type OfferBenchmark } from '../../../offers/index.js';
import { createPrismaPostedPay, type PostedPayDb } from '../../../offers/postedRange.js';
import type { TrackerEntryView } from '../../../tracker/index.js';
import { getBrand, BRANDS } from '../../../../platform/brand/registry.js';
import type { RateLimitDb } from '../../../../platform/ratelimit/index.js';
import { createAgentRouter } from '../../../agent/routes.js';
import { feedItem as agentFeedItem, job as agentJob, makeDb as makeAgentDb, makeDeps as makeAgentDeps } from '../../../agent/__tests__/testkit.js';
import { createExtensionRouter } from '../../../extension/routes.js';
import { createExtensionService, type ExtensionDeps } from '../../../extension/service.js';
import type { ExtJobRow } from '../../../extension/repository.js';
import { createFeedQueryService } from '../../../feed/FeedQueryService.js';
import { FakeFeedRepo, feedRow } from '../../../feed/testkit.js';
import { createMatchService } from '../../../match/MatchService.js';
import { createMatchRouter } from '../../../match/routes.js';
import { createMemoryRepo as createMatchMemoryRepo, jobRecord } from '../../../match/testkit.js';
import { DEFAULT_MATCH_TIERS, DEFAULT_MATCH_WEIGHTS } from '../../../match/index.js';
import { createNetworkRouter } from '../../../network/routes.js';
import { createNetworkFixture, jobRow as networkJobRow } from '../../../network/testkit.js';
import { createSearchProfilesRouter } from '../../../search/routes.js';
import type { SearchProfileService, SearchProfileWire } from '../../../search/index.js';
import { createSeoPublicRouter } from '../../../seo/routes.js';
import { createSeoService } from '../../../seo/service.js';
import { createMemorySeoRepo, seoJob } from '../../../seo/testkit.js';
import { cnPostingVisible, cnPostingsWhere, filterCnPostings } from '../mode.js';
import { createJobSearchRouters } from '../../../../job-search/routes.js';

const GA = 'goapply.localhost:3621';
/** Routers that only ever return third-party postings: gated as a whole. */
const POSTING_ONLY = ['feed', 'feed.public', 'visitor.alerts'];
/** Routers that may return jobs next to other data: their 2xx bodies are scanned. */
const SCANNED = ['jobs.detail', 'seo', 'cn.jobs', 'agent', 'extension', 'network', 'match', 'search.profiles'];
/**
 * Job readers covered by their own areas' mode-off tests instead of this file
 * (join J8: both tests landed with INT-04 and INT-07). Paths are relative to
 * server/src/features.
 */
const COVERED_ELSEWHERE: Record<string, string> = {
  tracker: 'tracker/modeOff.test.ts',
  notifications: 'alerts/modeOff.test.ts',
  // Legacy cross-bank search (not a feature mount): GoApply + mode off → 404 before any bank read or model call.
  'v2.discover': '../roboapply/v2/routes/legacyAiGates.test.ts',
};
/**
 * GoApply AI-dependent routers (`agent`) answer 503 without a domestic model,
 * so the scan would see no 2xx body. This is a model CONFIGURATION for the
 * capability check only; nothing here calls a model.
 */
const CN_AI_ENV = { CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-key', CN_LLM_MODEL: 'deepseek/deepseek-chat' };

const passThrough: RequestHandler = (_req, _res, next) => next();
const mountOf = (id: string): FeatureMount => {
  const m = FEATURE_MOUNTS.find((x) => x.id === id);
  if (!m) throw new Error(`no mount ${id}`);
  return m;
};

interface RouteInfo {
  method: string;
  path: string;
  stub: boolean;
}

function routesOf(router: Router): RouteInfo[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const stack = (router as unknown as { stack: Layer[] }).stack;
  return stack.flatMap((l) =>
    l.route
      ? Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route!.path, stub: l.route!.stack.some((s) => isStubHandler(s.handle)) }))
      : [],
  );
}

const fill = (p: string) => p.replace(/:([A-Za-z_]+)/g, (_m, n: string) => `test-${n}`);

/** Any object in the body that is a posting not imported by the user (job rows and feed cards). */
function thirdPartyPostings(body: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const company = o.company && typeof o.company === 'object' ? (o.company as Record<string, unknown>) : null;
    const source = o.source && typeof o.source === 'object' ? (o.source as Record<string, unknown>) : null;
    const looksLikeJob =
      typeof o.title === 'string' &&
      (typeof o.companyName === 'string' || typeof o.applyUrl === 'string' || typeof company?.name === 'string' || typeof o.jobId === 'string');
    const ownImport = o.visibility === 'private' || o.provider === 'user_import' || source?.kind === 'user_import';
    if (looksLikeJob && !ownImport) out.push(o);
    Object.values(o).forEach(walk);
  };
  walk(body);
  return out;
}

function baseDeps(env: Record<string, string>): FeatureRouterDeps {
  return {
    seekerAuth: [fakeAuth({ id: 'u1', role: 'seeker' })],
    adminAuth: [fakeAuth({ id: 'a1', role: 'admin' })],
    optionalAuth: [passThrough],
    extensionAuth: [fakeAuth({ id: 'u1', role: 'seeker' })],
    env,
  };
}

/**
 * Per-router seams so live routers answer without a database (Wave 3 gate):
 *   - feed (WP-32): a service whose every call fails fast, a pass-through
 *     limiter and phone gate — the mode-on check only asserts "not
 *     feature_disabled", and without these the default service and limiter
 *     reach for the real database;
 *   - feed.public (WP-78): a failing publicList, an empty stillPublic and a
 *     pass-through limiter (Wave 5 gate), for the same reason;
 *   - jobs.detail (WP-34): the real JobDetailService over a fake database
 *     holding the viewer's own import at `test-id` (what `fill` calls every
 *     `:id`) and one public GoHire posting at `job_gh`; MATCH's score handler
 *     and the news limiter stubbed.
 */
const failingFeedService = new Proxy(
  { now: () => new Date('2026-10-10T00:00:00Z') } as Record<string, unknown>,
  // `then` stays undefined so `await service` does not treat the proxy as a promise.
  { get: (t, k) => (k === 'then' ? undefined : k in t ? t[k as string] : async () => { throw new Error('fake feed service'); }) },
);

function detailJob(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: '产品经理', titleNormalized: '产品经理', companyId: null, companyName: '示例科技有限公司', companyLogoUrl: null,
    location: '上海', locationCountry: 'CN', workModel: 'onsite', employmentType: null, seniority: null,
    salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, salaryText: null, salaryDisclosed: false,
    description: '负责产品规划。', qualifications: null, responsibilities: null, benefits: null, summary: null, skillsDetail: null,
    sponsorship: null, sponsorshipEvidence: null, marketTags: null, fraudFlags: null, applyUrl: '', atsType: null,
    postedAt: new Date('2026-10-01T00:00:00Z'), postedAtEstimated: false, lastSeenAt: new Date('2026-10-09T00:00:00Z'),
    closedAt: null, archivedAt: null, originalSourceName: null, sourceUrl: null, isAgency: false,
    market: 'cn', isCanonical: true, publicDisplay: false, slug: null, primaryTaxonomyId: null,
    ...over,
  };
}

const OWN_IMPORT = detailJob({ id: 'test-id', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', sourceName: null, fromRecruiterBank: false, employerVerified: false });
const GOHIRE_POSTING = detailJob({ id: 'job_gh', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true, employerVerified: true, applyUrl: 'https://gohire.top/jobs/1' });

function fakeDetailService(env: Record<string, string>) {
  const db = createFakePrisma({
    seed: {
      rAJob: [OWN_IMPORT, GOHIRE_POSTING],
      rATrackerEntry: [], rATrackerEvent: [], rAJobUserState: [], rAJobInteraction: [], rAResumeVariant: [], rACoverLetter: [], rACampusEvent: [],
    },
  });
  return createJobDetailService({ db: db as unknown as JobDetailDb, brand: () => getCurrentBrandOrDefault(), env, isEnabled: async () => false });
}

function seamsFor(id: string, env: Record<string, string>): Record<string, unknown> {
  if (id === 'feed') return { service: failingFeedService, limiter: () => passThrough, phoneGate: passThrough };
  // Wave 5 gate (WP-78 request): without these the mode-on case goes through the
  // real per-IP limiter (an INSERT into RARateCounter) and reads real RAJob rows.
  if (id === 'feed.public') {
    return { publicFeed: { publicList: async () => { throw new Error('fake'); }, stillPublic: async () => new Set<string>(), rateLimiter: passThrough } };
  }
  if (id === 'jobs.detail') {
    const noScore: RequestHandler = (_req, res) => void res.status(204).end();
    return { service: fakeDetailService(env), scoreHandler: noScore, newsLimiter: passThrough };
  }
  return {};
}

// ── Seams of the routers added in the INT wave ───────────────────────────
//
// Every one runs the area's real service. Each fake store holds the same two
// jobs: the viewer's own import at `test-id` (what `fill` calls every `:id`)
// and one public GoHire posting at `job_gh`.

const GOHIRE_URL = 'https://gohire.top/jobs/1';
const CN_JOB = { title: '产品经理', companyName: '示例科技有限公司' };

/** Ready to apply (WP-52): the real AgentService; the R-14 seam reads `env`. */
function agentRouter(env: Record<string, string>): Router {
  const db = makeAgentDb({
    user: [{ id: 'u1', brand: 'goapply' }],
    rAJob: [
      agentJob('test-id', { ...CN_JOB, market: 'cn', visibility: 'private', ownerUserId: 'u1', applyUrl: '' }),
      agentJob('job_gh', { ...CN_JOB, market: 'cn', visibility: 'public', applyUrl: GOHIRE_URL }),
    ],
    // The only queue item is a kit for the GoHire posting, queued while postings were allowed.
    // (A queue view carries no visibility field, so an own-import item would look like a posting to the scanner.)
    rAAgentQueueItem: [
      { id: 'test-id', userId: 'u1', jobId: 'job_gh', weekKey: '2026-W42', addedVia: 'manual', state: 'picked', createdAt: new Date('2026-10-09T00:00:00Z'), updatedAt: new Date('2026-10-09T00:00:00Z') },
    ],
  });
  const { service } = makeAgentDeps(db, 'goapply', {
    visibleJobs: async (jobs, userId) => filterCnPostings(jobs, userId, env),
    // The feed seam itself answers empty in mode off (feed/seams.test.ts); here it leaks on purpose.
    feedPreview: async () => [agentFeedItem('job_gh', 'good')],
    flag: async () => true,
  });
  return createAgentRouter(baseDeps({ ...CN_AI_ENV, ...env }), { service });
}

/** Extension (WP-55a): the real ExtensionService; every seam it does not need here fails loudly. */
function extensionRouter(env: Record<string, string>): Router {
  const jobs: Array<ExtJobRow & { urls: string[] }> = [
    { id: 'test-id', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', ...CN_JOB, archivedAt: null, urls: ['https://hr.example.cn/job/9'] },
    { id: 'job_gh', market: 'cn', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire', ...CN_JOB, archivedAt: null, urls: [GOHIRE_URL] },
  ];
  /** Members that are not set up reject when called (the route then answers 500, which is not scanned). */
  const partial = <T extends object>(what: string, real: T): T =>
    new Proxy(real, {
      get: (t, k) => {
        if (k in t) return (t as Record<string | symbol, unknown>)[k];
        if (k === 'then') return undefined;
        return async () => {
          throw new Error(`extension fake: ${what}.${String(k)} is not set up`);
        };
      },
    });
  const repo = partial('repo', {
    listDevices: async () => [],
    // A repository that forgot the mode filter: the service's own check must still hide the posting.
    findJobByUrls: async ({ urls }: { urls: string[] }) => jobs.find((j) => j.urls.some((u) => urls.includes(u))) ?? null,
    loadJob: async (id: string) => jobs.find((j) => j.id === id) ?? null,
  });
  const chip = { score: 62, tier: 'good', kind: 'pre' as const, topOverlap: null, topGap: null };
  const deps = partial('deps', {
    repo,
    now: () => new Date('2026-10-10T00:00:00Z'),
    env,
    brand: () => getBrand('goapply'),
    credits: partial('credits', {}),
    profile: partial('profile', {}),
    tracker: partial('tracker', {}),
    match: { cached: async () => chip, page: async () => chip },
    cnPostingVisible: (job: ExtJobRow, userId: string) => cnPostingVisible(job, userId, env),
    cnWhere: (userId: string) => cnPostingsWhere(userId, env),
  }) as unknown as ExtensionDeps;
  const rateDb = {
    $queryRaw: (async () => [{ count: 1 }]) as unknown as RateLimitDb['$queryRaw'],
    rARateCounter: {} as RateLimitDb['rARateCounter'],
  } as RateLimitDb;
  return createExtensionRouter({ ...baseDeps(env), service: createExtensionService(deps), rateLimitDb: rateDb } as never);
}

/** People (WP-54): the real NetworkService; the R-14 seam reads `env`. */
function networkRouter(env: Record<string, string>): Router {
  const fx = createNetworkFixture({
    credits: { withCredit: async (_o: unknown, fn: (r: { id: string }) => Promise<unknown>) => fn({ id: 'led_1' }) } as never,
    brand: BRANDS.goapply,
    mode: 'deeplinks_only',
    ai: false,
    overrides: { postingVisible: (job, userId) => cnPostingVisible(job, userId, env) },
  });
  fx.store.jobs.set('test-id', networkJobRow({ id: 'test-id', ...CN_JOB, market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', fromRecruiterBank: false, externalId: 'imp_1' }));
  fx.store.jobs.set('job_gh', networkJobRow({ id: 'job_gh', ...CN_JOB, market: 'cn', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire', externalId: 'gh_1' }));
  return createNetworkRouter(baseDeps(env), { service: fx.service, phoneGate: passThrough });
}

/** MATCH (WP-18): the real MatchService over the in-memory repo; `deps.env` carries the mode. No model. */
function matchRouter(env: Record<string, string>): Router {
  const repo = createMatchMemoryRepo({
    jobs: [
      jobRecord({ id: 'test-id', ...CN_JOB, market: 'cn', visibility: 'private', ownerUserId: 'u1', locationCountry: 'CN', location: '上海', locationCity: '上海' }),
      jobRecord({ id: 'job_gh', ...CN_JOB, market: 'cn', visibility: 'public', ownerUserId: null, locationCountry: 'CN', location: '上海', locationCity: '上海' }),
    ],
  });
  const service = createMatchService({
    repo,
    resolveModel: () => null,
    aiAllowed: async () => false,
    consume: async () => ({ allowed: true, retryAfterSec: 0, remaining: 10, windows: [] }),
    withCredit: (async (_o: unknown, fn: () => Promise<unknown>) => fn()) as never,
    costLog: async () => undefined,
    profileSnapshot: async () => null,
    brand: () => getBrand('goapply'),
    env,
    now: () => new Date('2026-10-10T00:00:00Z'),
  });
  const noReport = async () => {
    throw new Error('competitiveness is not part of this scan (flag-gated)');
  };
  return createMatchRouter(baseDeps(env), async () => service, noReport as never);
}

/** Saved searches (WP-20): the real feed count seams over a repo that counts one GoHire posting. */
function searchProfilesRouter(env: Record<string, string>): Router {
  const now = new Date('2026-10-10T00:00:00Z');
  const wire: SearchProfileWire = {
    id: 'test-id', name: '默认', isDefault: true, isActive: true, version: 1, schemaVersion: 1,
    filters: { workModels: ['onsite'] }, alertInstantMax: 0, alertDigest: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  const profiles = {
    list: async () => ({ profiles: [wire], maxProfiles: 1, maxInstantAlerts: 0, proMaxProfiles: null, upgradable: false }),
    get: async () => wire,
    getActive: async () => wire,
    activate: async () => wire,
  } as unknown as SearchProfileService;
  const repo = new FakeFeedRepo();
  repo.rows.push(feedRow({ id: 'job_gh', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', fromRecruiterBank: true, ...CN_JOB }));
  // Every count statement finds the posting; relaxing a filter finds two.
  repo.countResponder = (sql) => (sql.text.includes('j."workModel" = ANY(') ? 1 : 2);
  const feed = createFeedQueryService({
    repo,
    match: { userContext: async () => { throw new Error('no ranking in a count'); }, config: () => ({ weights: { ...DEFAULT_MATCH_WEIGHTS }, tiers: { ...DEFAULT_MATCH_TIERS } }) },
    search: profiles,
    personalized: async () => false,
    consumeRefresh: async () => ({ allowed: true, retryAfterSec: 0 }),
    aiAllowed: async () => false,
    planner: async () => ({ queries: [], unverifiedPreferences: [] }),
    env,
    now: () => now,
  });
  const ctx = (userId: string) => ({ userId, market: 'cn' as const, brandId: 'goapply', now });
  return createSearchProfilesRouter({
    ...baseDeps(env),
    service: profiles,
    feed: {
      countForFilters: (userId, filters) => feed.countForFilters(ctx(userId), filters),
      limitingFilters: (userId, id) => feed.limitingFilters(ctx(userId), id),
    },
    limiter: () => passThrough,
  });
}

/** SEO (WP-56): the real SeoService over the in-memory repository holding the GoHire posting. */
function seoRouter(env: Record<string, string>): Router {
  const repo = createMemorySeoRepo([
    seoJob({ id: 'job_gh', market: 'cn', sourceBoard: 'gohire', sourceName: 'GoHire', ...CN_JOB, locationCountry: 'CN', locationCity: '上海', location: '上海' }),
  ]);
  const service = createSeoService({ repo, env, now: () => new Date('2026-10-10T00:00:00Z'), isEnabled: async () => true });
  return createSeoPublicRouter({ ...baseDeps(env), service, limit: async () => undefined });
}

const CUSTOM_ROUTERS: Record<string, (env: Record<string, string>) => Router> = {
  agent: agentRouter,
  extension: extensionRouter,
  network: networkRouter,
  match: matchRouter,
  'search.profiles': searchProfilesRouter,
  seo: seoRouter,
};

function routerFor(id: string, env: Record<string, string>): Router {
  const custom = CUSTOM_ROUTERS[id];
  if (custom) return custom(env);
  return mountOf(id).build({ ...baseDeps(env), ...seamsFor(id, env) } as FeatureRouterDeps);
}

function harnessFor(env: Record<string, string>, ids: string[]): Promise<RouteHarness> {
  return startRouteHarness({ env, mounts: ids.map((id) => [mountOf(id).path, routerFor(id, env)] as [string, Router]) });
}

/** Requests a route needs to get past validation (default: no query, `{}` body). */
const REQUESTS: Record<string, { query?: string; body?: unknown; headers?: Record<string, string> }> = {
  'extension POST /page-job': { body: { url: GOHIRE_URL, title: CN_JOB.title, company: CN_JOB.companyName, descriptionText: '负责产品规划与落地。' } },
  'match POST /jobs/:id/fit-analysis': { headers: { 'Idempotency-Key': 'modeoff-scan-0001' } },
  'search.profiles POST /count': { body: { filters: { workModels: ['onsite'] } } },
};

async function call(h: RouteHarness, mount: FeatureMount, r: RouteInfo, id = '', jobId?: string): Promise<HarnessResponse<{ code?: string }>> {
  const custom = REQUESTS[`${id} ${r.method} ${r.path}`] ?? {};
  const path = jobId ? r.path.replace(/:id\b/, jobId) : r.path;
  const url = `${mount.path}${fill(path)}`.replace(/\/$/, '') + (r.path.includes('external-links') ? '?q=test' : (custom.query ?? ''));
  return h.request<{ code?: string }>(r.method, url, { host: GA, body: r.method === 'GET' ? undefined : (custom.body ?? {}), headers: custom.headers });
}

async function callAll(h: RouteHarness, mount: FeatureMount): Promise<Array<{ route: string; res: HarnessResponse<{ code?: string }> }>> {
  const out = [];
  for (const r of routesOf(mount.build({}))) out.push({ route: `${r.method} ${r.path}`, res: await call(h, mount, r) });
  return out;
}

const MODE_OFF = {};
const MODE_ON = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };

let off: RouteHarness;
let on: RouteHarness;
beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  off = await harnessFor(MODE_OFF, [...POSTING_ONLY, ...SCANNED]);
  on = await harnessFor(MODE_ON, POSTING_ONLY);
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([off?.close(), on?.close()]);
});

describe('GoApply, CN_RECRUITMENT_INFO_MODE=off', () => {
  it.each(POSTING_ONLY)('%s: every route answers 404 feature_disabled', async (id) => {
    const results = await callAll(off, mountOf(id));
    expect(results.length).toBeGreaterThan(0);
    for (const { route, res } of results) {
      expect(res.status, route).toBe(404);
      expect(res.body?.code, route).toBe('feature_disabled');
    }
  });

  it.each(POSTING_ONLY)('%s: the same routes are not feature_disabled once the mode allows postings', async (id) => {
    for (const { route, res } of await callAll(on, mountOf(id))) expect(res.body?.code, route).not.toBe('feature_disabled');
  });

  for (const id of SCANNED) {
    const mount = mountOf(id);
    const routes = routesOf(mount.build({}));
    for (const r of routes.filter((x) => x.stub)) {
      it.todo(`${id} ${r.method} ${r.path}: still a stub — scan its 2xx body for third-party postings once ${mount.owner} implements it (seed one GoHire posting)`);
    }
    const live = routes.filter((x) => !x.stub);
    if (!live.length) continue;
    it(`${id}: implemented routes return no third-party posting, and at least one 2xx body was scanned`, async () => {
      let scanned = 0;
      for (const r of live) {
        const res = await call(off, mount, r, id);
        if (res.status >= 200 && res.status < 300) {
          scanned += 1;
          expect(thirdPartyPostings(res.body), `${r.method} ${r.path}`).toEqual([]);
        }
      }
      expect(scanned, `${id}: no 2xx body scanned — seed a GoHire posting through the router's seam`).toBeGreaterThan(0);
    });
  }

  it('jobs.detail: a GoHire posting is a 404 on every job route in mode off, and opens once the mode allows postings (control) [R41-1b]', async () => {
    const path = mountOf('jobs.detail').path;
    for (const suffix of ['', '/similar', '/apply-click']) {
      const method = suffix === '/apply-click' ? 'POST' : 'GET';
      const res = await off.request<{ code?: string }>(method, `${path}/job_gh${suffix}`, { host: GA, body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${suffix}`).toBe(404);
      expect(thirdPartyPostings(res.body)).toEqual([]);
    }
    const h = await startRouteHarness({ env: MODE_ON, mounts: [[path, mountOf('jobs.detail').build({ ...baseDeps(MODE_ON), ...seamsFor('jobs.detail', MODE_ON) } as FeatureRouterDeps)]] });
    try {
      const res = await h.request<unknown>('GET', `${path}/job_gh`, { host: GA });
      expect(res.status).toBe(200);
      expect(thirdPartyPostings(res.body).length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  // ── The routers added in the INT wave: the GoHire posting itself, with a control ──
  //
  // The scan above calls every route with the viewer's own import. These ask for
  // the GoHire posting by id (or by its page URL) and repeat the same request
  // with postings allowed, so "hidden" is shown to be the mode's doing.

  type Body = { code?: string; data?: Record<string, unknown> };
  async function onOne<T>(id: string, env: Record<string, string>, fn: (h: RouteHarness, base: string) => Promise<T>): Promise<T> {
    const h = await harnessFor(env, [id]);
    try {
      return await fn(h, mountOf(id).path);
    } finally {
      await h.close();
    }
  }
  const COMPANY = CN_JOB.companyName;

  it('match: scoring, fit analysis and the keyword check answer 404 for a GoHire posting; the viewer’s own import still works [R41-1b]', async () => {
    const key = { 'Idempotency-Key': 'modeoff-match-0001' };
    await onOne('match', MODE_OFF, async (h, base) => {
      expect((await h.request<Body>('GET', `${base}/jobs/job_gh/keyword-check`, { host: GA })).status).toBe(404);
      const fit = await h.request<Body>('POST', `${base}/jobs/job_gh/fit-analysis`, { host: GA, body: {}, headers: key });
      expect(fit.status).toBe(404);
      expect(JSON.stringify(fit.body)).not.toContain(COMPANY);
      const own = await h.request<Body>('GET', `${base}/jobs/test-id/keyword-check`, { host: GA });
      expect(own.status).toBe(200);
      expect(own.body.data).toMatchObject({ jobId: 'test-id' });
    });
    await onOne('match', MODE_ON, async (h, base) => {
      const res = await h.request<Body>('GET', `${base}/jobs/job_gh/keyword-check`, { host: GA });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ jobId: 'job_gh' });
      expect((await h.request<Body>('POST', `${base}/jobs/job_gh/fit-analysis`, { host: GA, body: {}, headers: key })).status).toBe(200);
    });
  });

  it('search.profiles: "Show N jobs" and the limiting-filter counts never count a third-party posting [R41-1b]', async () => {
    const body = { filters: { workModels: ['onsite'] } };
    await onOne('search.profiles', MODE_OFF, async (h, base) => {
      const count = await h.request<Body>('POST', `${base}/count`, { host: GA, body });
      expect(count.status).toBe(200);
      expect(count.body.data).toEqual({ count: 0, capped: false });
      const limiting = await h.request<Body>('GET', `${base}/test-id/limiting`, { host: GA });
      expect(limiting.status).toBe(200);
      expect(limiting.body.data).toEqual({ items: [], available: true });
    });
    await onOne('search.profiles', MODE_ON, async (h, base) => {
      expect((await h.request<Body>('POST', `${base}/count`, { host: GA, body })).body.data).toEqual({ count: 1, capped: false });
      const limiting = await h.request<{ data: { items: Array<{ field: string; removalGain: number }> } }>('GET', `${base}/test-id/limiting`, { host: GA });
      expect(limiting.body.data.items).toEqual([expect.objectContaining({ field: 'workModels', removalGain: 1 })]);
    });
  });

  it('agent: a kit queued for a GoHire posting is not listed, opened or suggested [R41-1b]', async () => {
    await onOne('agent', MODE_OFF, async (h, base) => {
      const queue = await h.request<{ data: { items: unknown[] } }>('GET', `${base}/queue`, { host: GA });
      expect(queue.status).toBe(200);
      expect(queue.body.data.items).toEqual([]);
      for (const path of ['/queue/test-id', '/queue/test-id/history', '/suggestions']) {
        const res = await h.request<Body>('GET', `${base}${path}`, { host: GA });
        expect(thirdPartyPostings(res.body), path).toEqual([]);
        expect(JSON.stringify(res.body), path).not.toContain(COMPANY);
      }
      const add = await h.request<Body>('POST', `${base}/queue`, { host: GA, body: { jobIds: ['job_gh'] } });
      expect(add.status).toBe(404);
    });
    await onOne('agent', MODE_ON, async (h, base) => {
      const queue = await h.request<{ data: { items: unknown[] } }>('GET', `${base}/queue`, { host: GA });
      expect(queue.status).toBe(200);
      expect(queue.body.data.items).toHaveLength(1);
      expect(thirdPartyPostings(queue.body).length).toBeGreaterThan(0);
      expect(JSON.stringify(queue.body)).toContain(COMPANY);
    });
  });

  it('extension: the page of a GoHire posting is not linked to it (no job id), whatever the repository returns [R41-1b]', async () => {
    const body = REQUESTS['extension POST /page-job']!.body;
    await onOne('extension', MODE_OFF, async (h, base) => {
      const res = await h.request<{ data: { jobId: string | null } }>('POST', `${base}/page-job`, { host: GA, body });
      expect(res.status).toBe(200);
      expect(res.body.data.jobId).toBeNull();
      expect(thirdPartyPostings(res.body)).toEqual([]);
    });
    await onOne('extension', MODE_ON, async (h, base) => {
      const res = await h.request<{ data: { jobId: string | null } }>('POST', `${base}/page-job`, { host: GA, body });
      expect(res.body.data.jobId).toBe('job_gh');
    });
  });

  it('network: People for a GoHire posting answers 404; the viewer’s own import still opens [R41-1b]', async () => {
    await onOne('network', MODE_OFF, async (h, base) => {
      const res = await h.request<Body>('GET', `${base}/jobs/job_gh/connections`, { host: GA });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(COMPANY);
      expect((await h.request<Body>('GET', `${base}/jobs/test-id/connections`, { host: GA })).status).toBe(200);
    });
    await onOne('network', MODE_ON, async (h, base) => {
      expect((await h.request<Body>('GET', `${base}/jobs/job_gh/connections`, { host: GA })).status).toBe(200);
    });
  });

  it('seo: the seeded GoHire posting is on no public route (job page, ticker, sitemap) [R41-1b]', async () => {
    await onOne('seo', MODE_OFF, async (h, base) => {
      const bodies: string[] = [];
      for (const path of ['/jobs/job_gh', '/ticker', '/sitemap', '/sitemap/jobs-1']) {
        const res = await h.request<Body>('GET', `${base}${path}`, { host: GA });
        expect(thirdPartyPostings(res.body), path).toEqual([]);
        bodies.push(res.text);
      }
      expect(bodies.join('\n')).not.toContain(COMPANY);
      expect(bodies.join('\n')).not.toContain('job_gh');
    });
  });

  it.each(Object.entries(COVERED_ELSEWHERE))('%s: its own mode-off test exists (%s)', (_id, file) => {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    // The area's test must still exercise the mode switch, not just exist.
    expect(source).toMatch(/CN_RECRUITMENT_INFO_MODE/);
    expect(source).toMatch(/\bit(\.each)?\(/);
  });

  it('the scanner recognises a posting and a feed card (guards the check against running vacuously)', () => {
    expect(thirdPartyPostings({ data: { items: [{ title: '产品经理', companyName: 'A', sourceName: 'GoHire' }] } })).toHaveLength(1);
    expect(thirdPartyPostings({ data: { items: [{ jobId: 'j', title: '产品经理', company: { name: 'A' }, source: { kind: 'bank' } }] } })).toHaveLength(1);
    expect(thirdPartyPostings({ data: { items: [{ title: '产品经理', companyName: 'A', visibility: 'private' }] } })).toEqual([]);
    expect(thirdPartyPostings({ data: { items: [{ jobId: 'j', title: '产品经理', company: { name: 'A' }, source: { kind: 'user_import' } }] } })).toEqual([]);
  });
});

// ── The legacy job-search API (app.ts mounts; not in FEATURE_MOUNTS) ────────
//
// A RoboApply product that returns third-party postings from the RapidAPI
// providers and the hiring index and runs a planner model. On GoApply both
// routers are closed in EVERY mode (the recruitment-info mode does not open
// them), before the key or session lookup. The fakes below would return a
// posting, so "closed" is the gate's doing; RoboApply is the control.

const JOB_SEARCH_MOUNTS = { api: '/api/v1/job-search', website: '/api/v1/roboapply/v2/job-search' } as const;

function jobSearchHarness(env: Record<string, string>) {
  const posting = { id: 'ext_1', title: '产品经理', companyName: '示例科技有限公司', applyUrl: 'https://jobs.example.com/1', provider: 'jsearch', sources: [] };
  const meta = { totalReturned: 1, deduplicated: 0, partial: false, searchedAt: '2026-10-10T00:00:00Z', cache: 'miss', providers: [{ id: 'jsearch', name: 'JSearch', status: 'ok', resultCount: 1 }] };
  const calls = { search: 0, agent: 0, keys: 0, auth: 0 };
  const routers = createJobSearchRouters({
    service: { providers: () => [{ id: 'jsearch', name: 'JSearch', enabled: true }], search: async () => (calls.search++, { jobs: [posting], meta }) } as never,
    keys: {
      authenticate: async () => (calls.auth++, { userId: 'u1', apiKeyId: 'k1' }),
      list: async () => (calls.keys++, { keys: [] }),
      create: async () => (calls.keys++, { key: { id: 'k2' }, token: 'fixture' }),
      revoke: async () => void calls.keys++,
    } as never,
    quota: { reserve: async () => 'r1', finish: async () => undefined } as never,
    agent: { search: async () => (calls.agent++, { jobs: [posting], meta, agent: { queries: ['产品经理'], mode: 'planned', criteria: { country: 'cn' }, unverifiedPreferences: [], linkedinOnly: false }, searches: [] }) } as never,
    sessionAuth: (req, _res, next) => (calls.auth++, (req.user = { id: 'u1' } as never), next()),
  });
  const routes = { api: routesOf(routers.api), website: routesOf(routers.website) };
  return startRouteHarness({ env, mounts: [[JOB_SEARCH_MOUNTS.api, routers.api], [JOB_SEARCH_MOUNTS.website, routers.website]] }).then((h) => ({ h, routes, calls }));
}

describe('legacy job-search API on GoApply', () => {
  const BODY: Record<string, unknown> = { '/search': { query: '产品经理', country: 'cn' }, '/agent/search': { request: '找上海的产品经理职位' }, '/keys': { name: 'App' } };

  it.each([['mode off', MODE_OFF], ['postings allowed', MODE_ON]])('%s: every route of both routers answers 404 feature_disabled; nothing is looked up, searched or planned', async (_name, env) => {
    const { h, routes, calls } = await jobSearchHarness(env);
    try {
      let called = 0;
      for (const side of ['api', 'website'] as const) {
        expect(routes[side].length).toBeGreaterThan(0);
        for (const r of routes[side]) {
          const res = await h.request<{ code?: string }>(r.method, `${JOB_SEARCH_MOUNTS[side]}${fill(r.path)}`, { host: GA, body: r.method === 'GET' ? undefined : (BODY[r.path] ?? {}) });
          expect(res.status, `${side} ${r.method} ${r.path}`).toBe(404);
          expect(res.body?.code, `${side} ${r.method} ${r.path}`).toBe('feature_disabled');
          expect(thirdPartyPostings(res.body)).toEqual([]);
          called += 1;
        }
      }
      expect(called).toBeGreaterThanOrEqual(8);
      expect(calls).toEqual({ search: 0, agent: 0, keys: 0, auth: 0 });
    } finally {
      await h.close();
    }
  });

  it('control: on RoboApply the same routers answer and return the posting (the check above is not vacuous)', async () => {
    const { h, calls } = await jobSearchHarness(MODE_OFF);
    try {
      expect((await h.request('GET', `${JOB_SEARCH_MOUNTS.api}/openapi.json`)).status).toBe(200);
      const search = await h.request<unknown>('POST', `${JOB_SEARCH_MOUNTS.website}/search`, { body: BODY['/search'] });
      expect(search.status).toBe(200);
      expect(thirdPartyPostings(search.body).length).toBeGreaterThan(0);
      const planned = await h.request<unknown>('POST', `${JOB_SEARCH_MOUNTS.api}/agent/search`, { body: BODY['/agent/search'], headers: { authorization: 'Bearer fixture' } });
      expect(planned.status).toBe(200);
      expect(calls.search).toBe(1);
      expect(calls.agent).toBe(1);
    } finally {
      await h.close();
    }
  });
});

// ── jobs.companies: real service, fake database ─────────────────────────────

/** Minimal Prisma `where` evaluator: equality, null, AND / OR / NOT, `in`, `equals`, `not`. Anything else throws. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(Array.isArray(v) ? v : [v]).every((w) => matches(row, w as Record<string, unknown>))) return false;
    } else if (k === 'OR') {
      if (!(v as Array<Record<string, unknown>>).some((w) => matches(row, w))) return false;
    } else if (k === 'NOT') {
      if ((Array.isArray(v) ? v : [v]).some((w) => matches(row, w as Record<string, unknown>))) return false;
    } else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Record<string, unknown>;
      const keys = Object.keys(op);
      if (keys.some((x) => !['in', 'equals', 'not', 'gt', 'gte', 'has', 'contains', 'mode'].includes(x))) throw new Error(`fake where: unsupported operator on ${k}: ${keys.join(',')}`);
      const cell = row[k];
      const ci = op.mode === 'insensitive';
      if ('in' in op && !(op.in as unknown[]).includes(cell)) return false;
      if ('equals' in op) {
        const eq = op.equals;
        // Prisma.DbNull / JsonNull are sentinel objects: they match a null cell.
        const nullSentinel = eq !== null && typeof eq === 'object' && !Array.isArray(eq) && !(eq instanceof Date);
        if (nullSentinel ? cell != null : Array.isArray(eq) ? JSON.stringify(cell) !== JSON.stringify(eq) : ci && typeof cell === 'string' ? cell.toLowerCase() !== String(eq).toLowerCase() : cell !== eq) return false;
      }
      if ('gt' in op && !(cell != null && (cell as number) > (op.gt as number))) return false;
      if ('gte' in op && !(cell != null && (cell as number) >= (op.gte as number))) return false;
      if ('has' in op && !(Array.isArray(cell) && cell.includes(op.has))) return false;
      if ('contains' in op && !(typeof cell === 'string' && (ci ? cell.toLowerCase().includes(String(op.contains).toLowerCase()) : cell.includes(String(op.contains))))) return false;
      if ('not' in op && row[k] === op.not) return false;
    } else if ((row[k] ?? null) !== v) {
      return false;
    }
  }
  return true;
}

const COMPANY = {
  id: 'co_1',
  market: 'cn',
  nameNormalized: '示例科技',
  displayName: '示例科技有限公司',
  slug: 'c-example',
  domain: null,
  logoUrl: null,
  website: null,
  industries: [],
  sizeBand: null,
  hqLocation: null,
  foundedYear: null,
  description: null,
  facts: {},
};

const GOHIRE_JOB = {
  id: 'job_gh',
  companyId: 'co_1',
  market: 'cn',
  visibility: 'public',
  ownerUserId: null,
  isCanonical: true,
  archivedAt: null,
  publicDisplay: true,
  title: '产品经理',
  companyName: '示例科技有限公司',
  companyLogoUrl: null,
  location: '上海',
  workModel: 'onsite',
  employmentType: null,
  seniority: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null,
  salaryText: null,
  salaryDisclosed: false,
  postedAt: new Date('2026-10-01T00:00:00Z'),
  lastSeenAt: new Date('2026-10-09T00:00:00Z'),
  sourceBoard: 'gohire',
  sourceName: 'GoHire',
  originalSourceName: null,
  sourceUrl: null,
  fromRecruiterBank: true,
  employerVerified: true,
  isAgency: false,
};

function fakeCompaniesDb(): CompaniesDb {
  const jobs = [GOHIRE_JOB] as Array<Record<string, unknown>>;
  const db = {
    rACompany: { findFirst: async ({ where }: { where: Record<string, unknown> }) => (matches(COMPANY, where) ? COMPANY : null) },
    rAJob: {
      count: async ({ where }: { where: Record<string, unknown> }) => jobs.filter((j) => matches(j, where)).length,
      findMany: async ({ where, skip = 0, take = 50 }: { where: Record<string, unknown>; skip?: number; take?: number }) =>
        jobs.filter((j) => matches(j, where)).slice(skip, skip + take),
    },
    rAH1bEmployerStat: { findMany: async () => [] },
    $queryRaw: async () => [],
  };
  return db as unknown as CompaniesDb;
}

async function companiesHarness(env: Record<string, string>): Promise<RouteHarness> {
  const mount = mountOf('jobs.companies');
  const deps = { ...baseDeps(env), optionalAuth: [fakeAuth({ id: 'u1', role: 'seeker' })], service: createCompanyReadService(fakeCompaniesDb()) };
  return startRouteHarness({ env, mounts: [[mount.path, mount.build(deps as FeatureRouterDeps)]] });
}

async function readCompany(h: RouteHarness) {
  const path = mountOf('jobs.companies').path;
  const profile = await h.request<{ data?: { openJobs?: { value?: number } } }>('GET', `${path}/co_1`, { host: GA });
  const jobs = await h.request<unknown>('GET', `${path}/co_1/jobs`, { host: GA });
  return { profile, jobs };
}

describe('jobs.companies on GoApply (signed-in viewer)', () => {
  it('control: with postings allowed, the fixture posting is listed and counted (the scan below is not vacuous)', async () => {
    const h = await companiesHarness(MODE_ON);
    try {
      const { profile, jobs } = await readCompany(h);
      expect(profile.status).toBe(200);
      expect(jobs.status).toBe(200);
      expect(profile.body.data?.openJobs?.value).toBe(1);
      expect(thirdPartyPostings(jobs.body)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  // R41-1 (applied at the Wave 3 gate): companies.jobs() and profile() AND
  // cnPostingsWhere(viewerId) when market === 'cn'.
  it('mode off: GET /companies/:id/jobs lists no third-party posting and the profile counts none [R41-1]', async () => {
    const h = await companiesHarness(MODE_OFF);
    try {
      const { profile, jobs } = await readCompany(h);
      expect(jobs.status).toBe(200);
      expect(thirdPartyPostings(jobs.body)).toEqual([]);
      expect(profile.body.data?.openJobs?.value ?? 0).toBe(0);
    } finally {
      await h.close();
    }
  });
});

// ── offers: the benchmark's posted pay (Wave 5 gate) ────────────────────────

/** MIN_SAMPLE public GoHire postings for the offer's role, with pay in the offer's currency. */
const GOHIRE_PAID = Array.from({ length: MIN_SAMPLE }, (_v, i) => ({
  ...GOHIRE_JOB,
  id: `job_pay_${i}`,
  closedAt: null,
  fraudFlags: null,
  taxonomyIds: ['product_manager'],
  primaryTaxonomyId: 'product_manager',
  locationCountry: null,
  locationCity: null,
  salaryMin: 15000 + i * 100,
  salaryMax: 20000 + i * 100,
  salaryCurrency: 'CNY',
  salaryPeriod: 'month',
}));

function fakePostedPayDb(): PostedPayDb {
  const jobs = GOHIRE_PAID as Array<Record<string, unknown>>;
  const pick = (j: Record<string, unknown>, select: Record<string, true>) => Object.fromEntries(Object.keys(select).map((k) => [k, j[k] ?? null]));
  return {
    rAJob: {
      findMany: async ({ where, select, take }) => jobs.filter((j) => matches(j, where as Record<string, unknown>)).slice(0, take).map((j) => pick(j, select)) as never,
      count: async ({ where }) => jobs.filter((j) => matches(j, where as Record<string, unknown>)).length,
      findFirst: async () => null,
    },
  };
}

const OFFER_ENTRY = {
  id: 'te_offer',
  userId: 'u1',
  jobId: null,
  status: 'offer',
  job: null,
  externalSnapshot: { title: '产品经理', companyName: '示例科技有限公司' },
  offer: { base: 18000, currency: 'CNY', period: 'month' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
} as unknown as TrackerEntryView;

async function offersHarness(env: Record<string, string>): Promise<RouteHarness> {
  const service = createOffersService({
    tracker: { entries: async () => [OFFER_ENTRY], entry: async () => OFFER_ENTRY, updateOffer: async () => undefined },
    postedPay: createPrismaPostedPay(async () => fakePostedPayDb(), { env }),
    market: () => 'cn',
    now: () => new Date('2026-10-10T00:00:00Z'),
    aiAvailable: async () => false,
    write: async () => {
      throw new Error('no model in this test');
    },
  });
  const router = createOffersRouter(baseDeps(env), { service, phoneGate: passThrough, limiter: () => passThrough });
  return startRouteHarness({ env, mounts: [[mountOf('offers').path, router]] });
}

async function readBenchmark(h: RouteHarness) {
  return h.request<{ data?: OfferBenchmark }>('GET', `${mountOf('offers').path}/te_offer/benchmark`, { host: GA });
}

describe('offers on GoApply: GET /offers/:id/benchmark', () => {
  it('control: with postings allowed, the GoHire postings give the posted range (the check below is not vacuous)', async () => {
    const h = await offersHarness(MODE_ON);
    try {
      const res = await readBenchmark(h);
      expect(res.status).toBe(200);
      expect(res.body.data?.scope.taxonomyId).toBe('product_manager');
      expect(res.body.data?.totalCount).toBe(MIN_SAMPLE);
      expect(res.body.data?.postedRange?.sampleSize).toBe(MIN_SAMPLE);
    } finally {
      await h.close();
    }
  });

  it('mode off: no third-party posting is counted and no posted range is shown', async () => {
    const h = await offersHarness(MODE_OFF);
    try {
      const res = await readBenchmark(h);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ totalCount: 0, listedCount: 0, postedRange: null });
    } finally {
      await h.close();
    }
  });
});
