// @vitest-environment node
//
// Wave 3 gate: the deprecated /v2 model routes (mock interview, legacy tailor)
// pass the GoApply phone gate and the AI consent gate before any model call.

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
vi.mock('../services/RAResumeAIService.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  raResumeAIService: { tailorDiff: m.tailorDiff },
}));

let h: RouteHarness;
beforeAll(async () => {
  const [{ default: mock }, { default: resumes }] = await Promise.all([import('./mock.js'), import('./resumes.js')]);
  h = await startRouteHarness({ env: {}, mounts: [['/v2/mock', mock], ['/v2/resumes', resumes]] });
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
];

describe('legacy /v2 model routes', () => {
  it.each(MODEL_ROUTES)('%s %s: 503 ai_unavailable without AI consent, zero model calls', async (method, path) => {
    m.aiAvailable = false;
    const res = await h.request<{ code?: string }>(method, path, { body: {} });
    expect(res.status).toBe(503);
    expect(res.body?.code).toBe('ai_unavailable');
    for (const fn of [m.start, m.nextTurn, m.score, m.tailorDiff]) expect(fn).not.toHaveBeenCalled();
  });

  it.each(MODEL_ROUTES)('%s %s: 403 phone_binding_required for a GoApply user without a phone', async (method, path) => {
    m.phoneBound = false;
    const res = await h.request<{ code?: string }>(method, path, { body: {} });
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe('phone_binding_required');
    for (const fn of [m.start, m.nextTurn, m.score, m.tailorDiff]) expect(fn).not.toHaveBeenCalled();
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
