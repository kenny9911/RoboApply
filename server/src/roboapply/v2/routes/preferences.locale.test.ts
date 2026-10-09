// @vitest-environment node
//
// PUT /v2/preferences/locale saves only a locale the request's brand serves
// (WP-12 request R7, applied at the Wave 2 gate).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ updateMany: vi.fn(async () => ({ count: 1 })) }));

vi.mock('../../../lib/prisma.js', () => {
  const client = { seekerProfile: { updateMany: m.updateMany } };
  return { default: client, prisma: client };
});
vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1' };
    next();
  },
}));

import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';

let h: RouteHarness;
beforeAll(async () => {
  const router = (await import('./preferences.js')).default;
  h = await startRouteHarness({ env: { NODE_ENV: 'development' }, mounts: [['/api/v1/roboapply/v2/preferences', router]] });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => m.updateMany.mockClear());

describe('PUT /preferences/locale', () => {
  it('saves a locale the brand serves', async () => {
    const res = await h.request<{ locale: string }>('PUT', '/api/v1/roboapply/v2/preferences/locale', { host: 'localhost:3621', body: { locale: 'zh-TW' } });
    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('zh-TW');
    expect(m.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { locale: 'zh-TW' } });
  });

  it('refuses a locale the brand does not serve (zh-TW on GoApply) and writes nothing', async () => {
    const res = await h.request('PUT', '/api/v1/roboapply/v2/preferences/locale', { host: 'goapply.localhost:3621', body: { locale: 'zh-TW' } });
    expect(res.status).toBe(422);
    expect(m.updateMany).not.toHaveBeenCalled();
    const ok = await h.request('PUT', '/api/v1/roboapply/v2/preferences/locale', { host: 'goapply.localhost:3621', body: { locale: 'zh' } });
    expect(ok.status).toBe(200);
  });
});
