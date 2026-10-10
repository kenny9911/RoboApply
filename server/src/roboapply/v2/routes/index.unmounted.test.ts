// @vitest-environment node
// WP-75 (ARCH §10.6 step 4): the dead V2 surfaces are no longer served by the
// /api/v1/roboapply/v2 aggregate. Auth is stubbed to always answer 401, so a
// path that is still mounted answers 401 and an unmounted one falls through to
// a 404 — no handler (and no database) is reached either way.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../middleware/auth.js', () => {
  const deny = (_req: unknown, res: { status(n: number): { json(b: unknown): void } }) => {
    res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
  };
  return {
    requireAuth: deny,
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: deny,
    rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    resolveUserFromTokens: async () => null,
  };
});
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';

let h: RouteHarness;

beforeAll(async () => {
  const { default: v2 } = await import('./index.js');
  h = await startRouteHarness({ mounts: [['/api/v1/roboapply/v2', v2]] });
});
afterAll(async () => {
  await h?.close();
});

describe('legacy V2 aggregate after WP-75', () => {
  it.each([
    ['GET', '/queue'],
    ['POST', '/queue/q1/send'],
    ['GET', '/activity'],
    ['GET', '/activity/orb-stats'],
    ['GET', '/integrations'],
    ['POST', '/integrations/gmail/connect'],
    ['POST', '/onboarding/bootstrap'],
    ['GET', '/onboarding/session'],
    ['GET', '/jobs/job1'],
    ['POST', '/jobs/job1/score'],
    ['POST', '/search/saved'],
    ['GET', '/search/saved'],
    ['DELETE', '/search/saved/s1'],
  ] as const)('%s %s is no longer served (404)', async (method, path) => {
    const res = await h.request(method, `/api/v1/roboapply/v2${path}`, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(404);
  });

  it.each([
    ['POST', '/search/run'],
    ['GET', '/tracker'],
    ['GET', '/goal'],
    ['GET', '/preferences'],
  ] as const)('%s %s is still mounted (auth runs first)', async (method, path) => {
    const res = await h.request(method, `/api/v1/roboapply/v2${path}`, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(401);
  });
});
