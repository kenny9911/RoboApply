// @vitest-environment node
//
// Wave 3 gate: the deprecated /v2 model routes (mock interview, legacy tailor)
// pass the GoApply phone gate and the AI consent gate before any model call.
// INT gate: so does POST /v2/discover/run (cross-bank search: the user's resume
// goes to three agents), which also closes on GoApply while the
// recruitment-info mode is off and has its own kill switch.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';

const m = vi.hoisted(() => ({
  aiAvailable: true,
  phoneBound: true,
  start: vi.fn(async () => ({ sessionId: 's1' })),
  nextTurn: vi.fn(async () => ({})),
  score: vi.fn(async () => ({})),
  tailorDiff: vi.fn(async () => ({ changes: [] })),
  discoverRun: vi.fn(async () => ({
    recommended: [], explore: [], coverage: null, insight: null, banksSwept: [], scorerCallsUsed: 0, scorerCacheHits: 0, zeroResults: true,
  })),
  deductionCount: vi.fn(async () => 0),
}));

vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../../features/resume/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resumeAiAvailable: async () => m.aiAvailable,
}));
vi.mock('../../../features/auth-cn/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requirePhoneBound: () => (_req: Request, res: Response, next: NextFunction) =>
    m.phoneBound ? next() : void res.status(403).json({ success: false, code: 'phone_binding_required' }),
}));
vi.mock('../services/RAMockService.js', () => ({
  raMockService: { start: m.start, nextTurn: m.nextTurn, score: m.score, catalog: () => ({}), recentSessions: async () => ({ sessions: [] }) },
  MockValidationError: class extends Error {},
  MockSessionNotFoundError: class extends Error {},
}));
vi.mock('../services/RACrossBankSearchService.js', () => ({ raCrossBankSearchService: { run: m.discoverRun } }));
// The discover route's daily cap counts deduction rows; everything else on the client is untouched.
vi.mock('../../../lib/prisma.js', async (orig) => {
  const real = await orig<{ default: object; prisma?: object }>();
  const client = new Proxy(real.default, {
    get: (t, k, r) => (k === 'usageDeductionLog' ? { count: m.deductionCount } : Reflect.get(t, k, r)),
  });
  return { ...real, default: client, prisma: client };
});
vi.mock('../services/RAResumeAIService.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  raResumeAIService: { tailorDiff: m.tailorDiff },
}));

let h: RouteHarness;
beforeAll(async () => {
  const [{ default: mock }, { default: resumes }, { default: discover }] = await Promise.all([import('./mock.js'), import('./resumes.js'), import('./discover.js')]);
  h = await startRouteHarness({ env: {}, mounts: [['/v2/mock', mock], ['/v2/resumes', resumes], ['/v2/discover', discover]] });
});
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  m.aiAvailable = true;
  m.phoneBound = true;
  vi.clearAllMocks();
});

const MODEL_ROUTES: Array<[string, string]> = [
  ['POST', '/v2/mock/start'],
  ['POST', '/v2/mock/next-turn'],
  ['POST', '/v2/mock/s1/score'],
  ['POST', '/v2/resumes/rv1/tailor-diff'],
  ['POST', '/v2/discover/run'],
];
const MODEL_CALLS = () => [m.start, m.nextTurn, m.score, m.tailorDiff, m.discoverRun];

describe('legacy /v2 model routes', () => {
  it.each(MODEL_ROUTES)('%s %s: 503 ai_unavailable without AI consent, zero model calls', async (method, path) => {
    m.aiAvailable = false;
    const res = await h.request<{ code?: string }>(method, path, { body: {} });
    expect(res.status).toBe(503);
    expect(res.body?.code).toBe('ai_unavailable');
    for (const fn of MODEL_CALLS()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(MODEL_ROUTES)('%s %s: 403 phone_binding_required for a GoApply user without a phone', async (method, path) => {
    m.phoneBound = false;
    const res = await h.request<{ code?: string }>(method, path, { body: {} });
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('phone_binding_required');
    for (const fn of MODEL_CALLS()) expect(fn).not.toHaveBeenCalled();
  });

  it('with consent and a phone the route runs', async () => {
    expect((await h.request('POST', '/v2/mock/start', { body: {} })).status).toBe(200);
    expect(m.start).toHaveBeenCalledTimes(1);
  });

  it('the catalog (no model call) is not gated', async () => {
    m.aiAvailable = false;
    expect((await h.request('GET', '/v2/mock/catalog')).status).toBe(200);
  });
});

describe('POST /v2/discover/run (cross-bank search)', () => {
  const GA = 'goapply.localhost:3621';
  async function discoverOn(env: Record<string, string>): Promise<RouteHarness> {
    const { createDiscoverRouter } = await import('./discover.js');
    return startRouteHarness({ env, mounts: [['/v2/discover', createDiscoverRouter({ env })]] });
  }

  it('with consent and a phone the run reaches the service once', async () => {
    const res = await h.request<{ zeroResults?: boolean }>('POST', '/v2/discover/run', { body: {} });
    expect(res.status).toBe(200);
    expect(res.body?.zeroResults).toBe(true);
    expect(m.discoverRun).toHaveBeenCalledTimes(1);
  });

  it('GoApply, recruitment-info mode off: 404 feature_disabled, no bank read and no model call (R-14)', async () => {
    const off = await discoverOn({});
    try {
      const res = await off.request<{ code?: string }>('POST', '/v2/discover/run', { host: GA, body: {} });
      expect(res.status).toBe(404);
      expect(res.body?.code).toBe('feature_disabled');
      expect(m.discoverRun).not.toHaveBeenCalled();
      // RoboApply is not affected by the GoApply mode.
      expect((await off.request('POST', '/v2/discover/run', { body: {} })).status).toBe(200);
    } finally {
      await off.close();
    }
  });

  it('GoApply with postings allowed still passes the phone and AI consent gates first', async () => {
    const on = await discoverOn({ CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' });
    try {
      m.aiAvailable = false;
      const noConsent = await on.request<{ code?: string }>('POST', '/v2/discover/run', { host: GA, body: {} });
      expect(noConsent.status).toBe(503);
      expect(noConsent.body?.code).toBe('ai_unavailable');
      m.aiAvailable = true;
      m.phoneBound = false;
      const noPhone = await on.request<{ code?: string }>('POST', '/v2/discover/run', { host: GA, body: {} });
      expect(noPhone.status).toBe(403);
      expect(noPhone.body?.code).toBe('phone_binding_required');
      expect(m.discoverRun).not.toHaveBeenCalled();
      m.phoneBound = true;
      expect((await on.request('POST', '/v2/discover/run', { host: GA, body: {} })).status).toBe(200);
      expect(m.discoverRun).toHaveBeenCalledTimes(1);
    } finally {
      await on.close();
    }
  });

  it('RA_V2_DISCOVER_DISABLED=true closes the route on both brands', async () => {
    const closed = await discoverOn({ RA_V2_DISCOVER_DISABLED: 'true', CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' });
    try {
      for (const host of [undefined, GA]) {
        const res = await closed.request<{ code?: string }>('POST', '/v2/discover/run', { host, body: {} });
        expect(res.status).toBe(404);
        expect(res.body?.code).toBe('feature_disabled');
      }
      expect(m.discoverRun).not.toHaveBeenCalled();
    } finally {
      await closed.close();
    }
  });
});
