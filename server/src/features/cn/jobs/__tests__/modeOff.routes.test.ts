// @vitest-environment node
// WP-41 acceptance (R-14, CN-L-04): with CN_RECRUITMENT_INFO_MODE=off no
// GoApply route returns third-party postings. Route tests across the feed,
// job and alert routers as mounted by features/index.ts (FEATURE_MOUNTS),
// with injected auth and no database.
//
//   - POSTING_ONLY (feed, public feed, visitor alerts): every route answers
//     404 feature_disabled on GoApply in mode off (and not in partner mode);
//   - SCANNED (job detail, SEO job pages, this area): every implemented route
//     is called and its 2xx body scanned; each reader must yield at least one
//     scanned 2xx body, so the check cannot pass with nothing scanned. A route
//     that is still an FND-5 stub is listed as it.todo naming its owner;
//   - jobs.companies: the real CompanyReadService over a fake database holding
//     one public GoHire posting, read by a signed-in user. Mode-gated since
//     the Wave 3 gate applied Request R41-1 (the router ANDs cnPostingsWhere);
//   - NOT_EXERCISED readers (tracker, match, seeker alerts, saved searches)
//     need data seeded through their own seams: it.todo with the owner WP.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { FEATURE_MOUNTS, type FeatureMount, type FeatureRouterDeps } from '../../../index.js';
import { setFlagOverrideLoader } from '../../../../platform/flags.js';
import { isStubHandler } from '../../../../platform/http.js';
import { fakeAuth, startRouteHarness, type HarnessResponse, type RouteHarness } from '../../../../test/routeHarness.js';
import { createCompanyReadService, type CompaniesDb } from '../../../jobs/companies/service.js';
import { createJobDetailService, type JobDetailDb } from '../../../jobs/detail/service.js';
import { getCurrentBrandOrDefault } from '../../../../platform/brand/index.js';
import { createFakePrisma } from '../../../../test/fakePrisma.js';

const GA = 'goapply.localhost:3621';
/** Routers that only ever return third-party postings: gated as a whole. */
const POSTING_ONLY = ['feed', 'feed.public', 'visitor.alerts'];
/** Routers that may return jobs next to other data: their 2xx bodies are scanned. */
const SCANNED = ['jobs.detail', 'seo', 'cn.jobs'];
/** Job readers this file does not exercise yet (owner WP fills the seam and seeds a posting). */
const NOT_EXERCISED: Record<string, string> = { tracker: 'WP-38', match: 'WP-18', notifications: 'WP-39b', 'search.profiles': 'WP-20' };

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
  if (id === 'jobs.detail') {
    const noScore: RequestHandler = (_req, res) => void res.status(204).end();
    return { service: fakeDetailService(env), scoreHandler: noScore, newsLimiter: passThrough };
  }
  return {};
}

function harnessFor(env: Record<string, string>, ids: string[]): Promise<RouteHarness> {
  const deps = baseDeps(env);
  return startRouteHarness({
    env,
    mounts: ids.map((id) => [mountOf(id).path, mountOf(id).build({ ...deps, ...seamsFor(id, env) } as FeatureRouterDeps)] as [string, Router]),
  });
}

async function call(h: RouteHarness, mount: FeatureMount, r: RouteInfo): Promise<HarnessResponse<{ code?: string }>> {
  const url = `${mount.path}${fill(r.path)}`.replace(/\/$/, '') + (r.path.includes('external-links') ? '?q=test' : '');
  return h.request<{ code?: string }>(r.method, url, { host: GA, body: r.method === 'GET' ? undefined : {} });
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
        const res = await call(off, mount, r);
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

  for (const [id, owner] of Object.entries(NOT_EXERCISED)) {
    it.todo(`${id}: with mode off, no response carries a third-party posting (owner ${owner}: seed a GoHire posting through the router's seam)`);
  }

  it('the scanner recognises a posting and a feed card (guards the check against running vacuously)', () => {
    expect(thirdPartyPostings({ data: { items: [{ title: '产品经理', companyName: 'A', sourceName: 'GoHire' }] } })).toHaveLength(1);
    expect(thirdPartyPostings({ data: { items: [{ jobId: 'j', title: '产品经理', company: { name: 'A' }, source: { kind: 'bank' } }] } })).toHaveLength(1);
    expect(thirdPartyPostings({ data: { items: [{ title: '产品经理', companyName: 'A', visibility: 'private' }] } })).toEqual([]);
    expect(thirdPartyPostings({ data: { items: [{ jobId: 'j', title: '产品经理', company: { name: 'A' }, source: { kind: 'user_import' } }] } })).toEqual([]);
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
      if (keys.some((x) => !['in', 'equals', 'not'].includes(x))) throw new Error(`fake where: unsupported operator on ${k}: ${keys.join(',')}`);
      if ('in' in op && !(op.in as unknown[]).includes(row[k])) return false;
      if ('equals' in op && row[k] !== op.equals) return false;
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
