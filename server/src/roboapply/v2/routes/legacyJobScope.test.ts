// @vitest-environment node
//
// Wave 3 gate: the deprecated /v2 job readers apply the job-detail scope and
// the GoApply recruitment-info mode (R-14). With CN_RECRUITMENT_INFO_MODE=off
// (the default) `POST /v2/search/run` lists no GoHire posting and
// `GET /v2/jobs/:id` answers 404 for one; another user's private import is
// 404 on both brands; the viewer's own import stays readable.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';

const fake = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../../../lib/prisma.js', () => ({
  get default() {
    return fake.db;
  },
}));

vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', subscriptionTier: 'free' };
    next();
  },
}));

const job = (over: Record<string, unknown>) => ({
  title: 'Product manager',
  titleNormalized: 'product manager',
  companyName: 'Example Co',
  companyNameNormalized: 'example co',
  description: 'Plan the product.',
  descriptionPlain: 'Plan the product.',
  location: 'Shanghai',
  archivedAt: null,
  closedAt: null,
  isCanonical: true,
  fraudFlags: null,
  postedAt: new Date('2026-10-01T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  applyUrl: 'https://example.com/apply',
  ...over,
});

const ROWS = [
  job({ id: 'cn_gohire', market: 'cn', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire', provider: 'gohire' }),
  job({ id: 'cn_own', market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import', provider: 'user_import' }),
  job({ id: 'cn_other', market: 'cn', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import', provider: 'user_import' }),
  job({ id: 'intl_public', market: 'intl', visibility: 'public', ownerUserId: null, sourceBoard: 'greenhouse', provider: 'greenhouse' }),
  job({ id: 'intl_other', market: 'intl', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import', provider: 'user_import' }),
];

const GA = 'goapply.localhost:3621';
const RA = 'localhost:3611';
let h: RouteHarness;

beforeAll(async () => {
  fake.db = createFakePrisma({ seed: { rAJob: ROWS, rATrackerEntry: [], rAJobMatchScore: [], rAKeywordExtraction: [] } });
  const [{ default: jobs }, { default: search }] = await Promise.all([import('./jobs.js'), import('./search.js')]);
  h = await startRouteHarness({
    env: {},
    mounts: [
      ['/api/v1/roboapply/v2/jobs', jobs],
      ['/api/v1/roboapply/v2/search', search],
    ],
  });
});
afterAll(async () => {
  await h?.close();
});

const ids = (body: unknown) => ((body as { jobs?: Array<{ id: string }> }).jobs ?? []).map((j) => j.id);

describe('legacy /v2 job readers', () => {
  it('GoApply, mode off: search lists no third-party posting', async () => {
    const res = await h.request('POST', '/api/v1/roboapply/v2/search/run', { host: GA, body: {} });
    expect(res.status).toBe(200);
    expect(ids(res.body)).not.toContain('cn_gohire');
    expect(ids(res.body)).not.toContain('intl_public');
    // Control: once the mode allows postings the same search lists it (the check is not vacuous).
    const prev = process.env.CN_RECRUITMENT_INFO_MODE;
    process.env.CN_RECRUITMENT_INFO_MODE = 'partner_deeplink';
    try {
      const on = await h.request('POST', '/api/v1/roboapply/v2/search/run', { host: GA, body: {} });
      expect(ids(on.body)).toContain('cn_gohire');
      expect((await h.request('GET', '/api/v1/roboapply/v2/jobs/cn_gohire', { host: GA })).status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.CN_RECRUITMENT_INFO_MODE;
      else process.env.CN_RECRUITMENT_INFO_MODE = prev;
    }
  });

  it('GoApply, mode off: a GoHire posting is 404 by id (detail and sub-routes); the own import is readable', async () => {
    expect((await h.request('GET', '/api/v1/roboapply/v2/jobs/cn_gohire', { host: GA })).status).toBe(404);
    expect((await h.request('POST', '/api/v1/roboapply/v2/jobs/cn_gohire/save', { host: GA, body: {} })).status).toBe(404);
    expect((await h.request('POST', '/api/v1/roboapply/v2/jobs/cn_gohire/score', { host: GA, body: { resumeVariantId: 'v1' } })).status).toBe(404);
    const own = await h.request('GET', '/api/v1/roboapply/v2/jobs/cn_own', { host: GA });
    expect(own.status).toBe(200);
  });

  it("another user's private import is 404 on both brands; another market's job is 404", async () => {
    expect((await h.request('GET', '/api/v1/roboapply/v2/jobs/cn_other', { host: GA })).status).toBe(404);
    expect((await h.request('GET', '/api/v1/roboapply/v2/jobs/intl_other', { host: RA })).status).toBe(404);
    expect((await h.request('GET', '/api/v1/roboapply/v2/jobs/cn_own', { host: RA })).status).toBe(404);
    expect((await h.request('GET', '/api/v1/roboapply/v2/jobs/intl_public', { host: RA })).status).toBe(200);
  });
});
