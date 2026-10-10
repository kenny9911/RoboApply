// @vitest-environment node
//
// WP-55a route tests over a stub service (service.test.ts covers the rules):
// auth per route kind, the device token check (hashed lookup, revoked,
// other brand), the token's scope (a device token is not a session),
// capability gates, rate limits, envelopes and the file download.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setRequestUserId: vi.fn() },
}));

import { Router } from 'express';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import type { RateLimitDb } from '../../platform/ratelimit/index.js';
import { createRequireExtensionDevice } from './auth.js';
import { createExtensionPublicRouter, createExtensionRouter, contentDisposition } from './routes.js';
import type { DeviceWithUser } from './repository.js';
import type { ExtensionService } from './service.js';
import { hashDeviceToken, issueDeviceToken } from './tokens.js';

const BASE = '/api/v1/roboapply/ext';
const PUB = '/api/v1/public/ext';
const HOST = 'localhost:3621';
const CN_HOST = 'goapply.localhost:3621';

type Env<T = unknown> = { success: boolean; data: T; code?: string; details?: { reason?: string } };

/** In-memory RARateCounter (`INSERT … ON CONFLICT … RETURNING count`). */
function memoryRateDb(): RateLimitDb & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const db = {
    counts,
    $queryRaw: (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = `${String(values[0])}@${(values[1] as Date).toISOString()}`;
      const next = (counts.get(key) ?? 0) + Number(values[2]);
      counts.set(key, next);
      return [{ count: next }];
    }) as unknown as RateLimitDb['$queryRaw'],
    rARateCounter: {} as RateLimitDb['rARateCounter'],
  };
  return db as RateLimitDb & { counts: Map<string, number> };
}

const svc = {
  createDevice: vi.fn(async () => ({ deviceId: 'dev_1', token: 'rax_' + 'a'.repeat(43) })),
  listDevices: vi.fn(async () => []),
  status: vi.fn(async () => ({ minExtVersion: '1.2.0', devices: [] })),
  revokeDevice: vi.fn(async () => undefined),
  createPairCode: vi.fn(async () => ({ code: 'ABCD2345', expiresAt: '2026-10-10T12:10:00.000Z' })),
  redeemPairCode: vi.fn(async () => ({ deviceId: 'dev_2', token: 'rax_' + 'b'.repeat(43) })),
  me: vi.fn(async (userId: string) => ({ user: { id: userId } })),
  autofillProfile: vi.fn(async () => ({ sensitive: null })),
  pageJob: vi.fn(async () => ({ jobId: null, fit: null })),
  saveJob: vi.fn(async () => ({ jobId: 'j1', trackerEntryId: 't1', matched: null })),
  createRun: vi.fn(async () => ({ runId: 'run_1', jobId: null })),
  patchRun: vi.fn(async () => ({ runId: 'run_1' })),
  answer: vi.fn(async () => ({ answer: null, source: 'none', saveable: false, questionType: 'free_text', reason: 'ai_off' })),
  resumeForJob: vi.fn(async () => ({ variantId: 'rv', isTailored: false, fileName: 'a.pdf', downloadUrl: 'x', tailoredNeedsReview: false })),
  file: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.7 bytes'), fileName: '简历 Ada.pdf', contentType: 'application/pdf', artifactId: 'a1' })),
  siteRequest: vi.fn(async () => undefined),
  uninstallSurvey: vi.fn(async () => undefined),
} as unknown as ExtensionService & Record<string, ReturnType<typeof vi.fn>>;

// Devices known to the fake token lookup.
const good = issueDeviceToken();
const revoked = issueDeviceToken();
const cnDevice = issueDeviceToken();
function deviceRow(id: string, brand: string, revokedAt: Date | null): DeviceWithUser {
  return {
    id,
    userId: 'u1',
    brand,
    tokenPrefix: 'rax_xxxx',
    name: 'Chrome',
    browser: 'chrome',
    extVersion: '1.0.0',
    lastSeenAt: null,
    revokedAt,
    createdAt: new Date(),
    user: { id: 'u1', email: 'u@example.test', brand, role: 'user', isActive: true },
  };
}
const byHash = new Map<string, DeviceWithUser>([
  [good.tokenHash, deviceRow('dev_good', 'roboapply', null)],
  [revoked.tokenHash, deviceRow('dev_revoked', 'roboapply', new Date())],
  [cnDevice.tokenHash, deviceRow('dev_cn', 'goapply', null)],
]);
const touch = vi.fn(async () => undefined);
const lookup = vi.fn(async (h: string) => byHash.get(h) ?? null);
const deviceAuth = createRequireExtensionDevice({ repo: () => ({ findDeviceByTokenHash: lookup, touchDevice: touch }) });

let user: { id: string } | null = { id: 'u1' };
let on: RouteHarness;
let off: RouteHarness;
let rateDb: ReturnType<typeof memoryRateDb>;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  rateDb = memoryRateDb();
  const deps = { seekerAuth: [fakeAuth(() => user)], extensionAuth: [deviceAuth], env: {}, service: svc, rateLimitDb: rateDb };
  on = await startRouteHarness({ env: {}, mounts: [[BASE, createExtensionRouter(deps)], [PUB, createExtensionPublicRouter(deps)]] });
  const offEnv = { FLAG_ROBOAPPLY_EXTENSION: 'false', FLAG_GOAPPLY_EXTENSION: 'false' };
  const offDeps = { ...deps, env: offEnv };
  off = await startRouteHarness({ env: offEnv, mounts: [[BASE, createExtensionRouter(offDeps)], [PUB, createExtensionPublicRouter(offDeps)]] });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([on.close(), off.close()]);
});
beforeEach(() => {
  user = { id: 'u1' };
  rateDb.counts.clear();
  vi.clearAllMocks();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const SESSION_ROUTES = [
  ['POST', '/devices', { name: 'Chrome' }],
  ['GET', '/devices', undefined],
  ['GET', '/status', undefined],
  ['DELETE', '/devices/dev_1', undefined],
  ['POST', '/pair-codes', undefined],
] as const;

const DEVICE_ROUTES = [
  ['GET', '/me', undefined],
  ['GET', '/autofill-profile', undefined],
  ['POST', '/page-job', { url: 'https://x.example/1', title: 'T', company: 'C', descriptionText: 'd' }],
  ['POST', '/jobs/save', { url: 'https://x.example/1', title: 'T', company: 'C', descriptionText: 'd' }],
  ['POST', '/autofill-runs', { host: 'x.example', atsType: 'greenhouse', url: 'https://x.example/1', fieldsTotal: 3 }],
  ['PATCH', '/autofill-runs/run_1', { fieldsFilled: 1, outcome: 'filled' }],
  ['POST', '/answers', { runId: 'run_1', question: 'Why us?', fieldType: 'textarea' }],
  ['POST', '/resume-for-job', { jobId: 'j1', runId: 'run_1' }],
  ['GET', '/files/' + 'x'.repeat(40), undefined],
  ['POST', '/site-requests', { host: 'x.example', url: 'https://x.example/1' }],
] as const;

describe('auth', () => {
  it('session routes answer 401 without a session', async () => {
    user = null;
    for (const [m, p, body] of SESSION_ROUTES) {
      const r = await on.request(m, `${BASE}${p}`, { host: HOST, body });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('device routes answer 401 without a device token, even with a session cookie', async () => {
    for (const [m, p, body] of DEVICE_ROUTES) {
      const r = await on.request(m, `${BASE}${p}`, { host: HOST, body, cookies: { session_token: 'abc' } });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    expect(svc.me).not.toHaveBeenCalled();
  });

  it('looks the device up by token hash and sets the owner', async () => {
    const r = await on.request<Env<{ user: { id: string } }>>('GET', `${BASE}/me`, { host: HOST, headers: bearer(good.token) });
    expect(r.status).toBe(200);
    expect(r.body.data.user.id).toBe('u1');
    expect(lookup).toHaveBeenCalledWith(hashDeviceToken(good.token));
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('a revoked device is refused with reason device_revoked', async () => {
    const r = await on.request<Env>('GET', `${BASE}/me`, { host: HOST, headers: bearer(revoked.token) });
    expect(r.status).toBe(401);
    expect(r.body.details?.reason).toBe('device_revoked');
  });

  it('an unknown token is refused', async () => {
    const r = await on.request<Env>('GET', `${BASE}/me`, { host: HOST, headers: bearer(issueDeviceToken().token) });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('unauthorized');
  });

  it('a device of the other brand is refused', async () => {
    const r = await on.request<Env>('GET', `${BASE}/me`, { host: HOST, headers: bearer(cnDevice.token) });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('auth_other_brand');
    const cn = await on.request<Env>('GET', `${BASE}/me`, { host: CN_HOST, headers: bearer(cnDevice.token) });
    expect(cn.status).toBe(200);
  });

  it('a device token is not a session: requireAuth refuses it outside /ext', async () => {
    const { requireAuth } = await import('../../middleware/auth.js');
    const r = Router();
    r.get('/probe', requireAuth, (_req, res) => {
      res.json({ ok: true });
    });
    const h = await startRouteHarness({ env: {}, mounts: [['/api/v1/roboapply/other', r]] });
    try {
      const res = await h.request<{ code?: string }>('GET', '/api/v1/roboapply/other/probe', { host: HOST, headers: bearer(good.token) });
      expect(res.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});

describe('capability', () => {
  it('404 feature_disabled on every route when `extension` is off', async () => {
    for (const [m, p, body] of [...SESSION_ROUTES, ['POST', '/pair-codes/redeem', { code: 'ABCD2345', name: 'Edge' }] as const]) {
      const r = await off.request<Env>(m, `${BASE}${p}`, { host: HOST, body });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.code).toBe('feature_disabled');
    }
    for (const [m, p, body] of DEVICE_ROUTES) {
      const r = await off.request<Env>(m, `${BASE}${p}`, { host: HOST, body, headers: bearer(good.token) });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.code).toBe('feature_disabled');
    }
    const s = await off.request<Env>('POST', `${PUB}/uninstall-survey`, { host: HOST, body: { reasons: ['other'] } });
    expect(s.body.code).toBe('feature_disabled');
    expect(svc.uninstallSurvey).not.toHaveBeenCalled();
  });
});

describe('session routes', () => {
  it('POST /devices returns the token once (201)', async () => {
    const r = await on.request<Env<{ token: string }>>('POST', `${BASE}/devices`, { host: HOST, body: { name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.0.0' } });
    expect(r.status).toBe(201);
    expect(r.body.data.token.startsWith('rax_')).toBe(true);
    expect(svc.createDevice).toHaveBeenCalledWith('u1', { name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.0.0' });
  });

  it('POST /devices is limited to 5 a day', async () => {
    for (let i = 0; i < 5; i++) expect((await on.request('POST', `${BASE}/devices`, { host: HOST, body: { name: 'Chrome' } })).status).toBe(201);
    const r = await on.request<Env>('POST', `${BASE}/devices`, { host: HOST, body: { name: 'Chrome' } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
  });

  it('GET /devices lists, DELETE revokes (204), GET /status reports the min version', async () => {
    expect((await on.request<Env<{ items: unknown[] }>>('GET', `${BASE}/devices`, { host: HOST })).body.data.items).toEqual([]);
    expect((await on.request('DELETE', `${BASE}/devices/dev_9`, { host: HOST })).status).toBe(204);
    expect(svc.revokeDevice).toHaveBeenCalledWith('u1', 'dev_9');
    expect((await on.request<Env<{ minExtVersion: string }>>('GET', `${BASE}/status`, { host: HOST })).body.data.minExtVersion).toBe('1.2.0');
  });

  it('422 on an invalid device name', async () => {
    const r = await on.request<Env>('POST', `${BASE}/devices`, { host: HOST, body: { name: '' } });
    expect(r.status).toBe(422);
  });
});

describe('pair-code redeem (public)', () => {
  it('works without a session and is limited per IP', async () => {
    user = null;
    const ok = await on.request<Env<{ token: string }>>('POST', `${BASE}/pair-codes/redeem`, { host: HOST, body: { code: 'ABCD2345', name: 'Edge' } });
    expect(ok.status).toBe(201);
    for (let i = 0; i < 9; i++) await on.request('POST', `${BASE}/pair-codes/redeem`, { host: HOST, body: { code: 'ABCD2345', name: 'Edge' } });
    expect((await on.request('POST', `${BASE}/pair-codes/redeem`, { host: HOST, body: { code: 'ABCD2345', name: 'Edge' } })).status).toBe(429);
  });

  it('422 on a malformed code', async () => {
    expect((await on.request('POST', `${BASE}/pair-codes/redeem`, { host: HOST, body: { code: 'abc', name: 'Edge' } })).status).toBe(422);
  });

  it('accepts a code typed in lower case or with spaces (normalized before the format check)', async () => {
    const { RedeemPairCodeBodySchema } = await import('./contract.js');
    expect(RedeemPairCodeBodySchema.parse({ code: ' abcd2345 ', name: 'Edge' }).code).toBe('ABCD2345');
    // Characters the generator never uses (0, O, 1, I) are still refused.
    expect(RedeemPairCodeBodySchema.safeParse({ code: 'ABCD1234', name: 'Edge' }).success).toBe(false);
    expect(RedeemPairCodeBodySchema.safeParse({ code: 'abcd234', name: 'Edge' }).success).toBe(false);
  });
});

describe('device routes', () => {
  const h = () => ({ host: HOST, headers: bearer(good.token) });

  it('page-job is a POST only (no page-load GET exists) and passes the body', async () => {
    const router = createExtensionRouter({ extensionAuth: [deviceAuth], service: svc });
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    const pageJob = stack.filter((l) => l.route?.path === '/page-job').map((l) => Object.keys(l.route!.methods));
    expect(pageJob).toEqual([['post']]);
    const body = { url: 'https://x.example/1', title: 'T', company: 'C', descriptionText: 'd' };
    const r = await on.request('POST', `${BASE}/page-job`, { ...h(), body });
    expect(r.status).toBe(200);
    expect(svc.pageJob).toHaveBeenCalledWith('u1', body);
  });

  it('autofill runs pass the device id and the Idempotency-Key', async () => {
    const r = await on.request('POST', `${BASE}/autofill-runs`, {
      host: HOST,
      headers: { ...bearer(good.token), 'Idempotency-Key': 'k-1' },
      body: { host: 'x.example', atsType: 'greenhouse', url: 'https://x.example/1', fieldsTotal: 3 },
    });
    expect(r.status).toBe(201);
    expect(svc.createRun).toHaveBeenCalledWith('u1', 'dev_good', expect.objectContaining({ atsType: 'greenhouse' }), 'k-1');
  });

  it('a 402 from the credit service reaches the extension as credits_exhausted', async () => {
    (svc.createRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('No autofill credits left'), { code: 'credits_exhausted', bucket: 'autofill', resetsAt: new Date('2026-10-11T00:00:00Z'), upgradable: true }),
    );
    const r = await on.request<Env>('POST', `${BASE}/autofill-runs`, { ...h(), body: { host: 'x.example', atsType: 'greenhouse', url: 'https://x.example/1', fieldsTotal: 3 } });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('credits_exhausted');
  });

  it('PATCH passes userMarkedSubmitted only as the user sent it', async () => {
    await on.request('PATCH', `${BASE}/autofill-runs/run_1`, { ...h(), body: { fieldsFilled: 3, outcome: 'filled', userMarkedSubmitted: true } });
    expect(svc.patchRun).toHaveBeenCalledWith('u1', 'run_1', { fieldsFilled: 3, outcome: 'filled', userMarkedSubmitted: true });
  });

  it('answers and resume-for-job', async () => {
    expect((await on.request('POST', `${BASE}/answers`, { ...h(), body: { runId: 'run_1', question: 'Why us?', fieldType: 'textarea' } })).status).toBe(200);
    expect((await on.request('POST', `${BASE}/answers`, { ...h(), body: { runId: 'run_1', question: 'Why us?', fieldType: 'essay' } })).status).toBe(422);
    const r = await on.request('POST', `${BASE}/resume-for-job`, { ...h(), body: { jobId: 'j1', runId: 'run_1' } });
    expect(r.status).toBe(200);
    expect(svc.resumeForJob).toHaveBeenCalledWith('u1', { jobId: 'j1', runId: 'run_1' }, expect.stringMatching(/^http:\/\/localhost:3621$/));
  });

  it('GET /files/:token sends the bytes as an attachment, not cached', async () => {
    const r = await on.request('GET', `${BASE}/files/${'x'.repeat(40)}`, h());
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-disposition')).toBe(contentDisposition('简历 Ada.pdf'));
    expect(r.text).toBe('%PDF-1.7 bytes');
  });

  it('site requests answer 204', async () => {
    expect((await on.request('POST', `${BASE}/site-requests`, { ...h(), body: { host: 'x.example', url: 'https://x.example/1' } })).status).toBe(204);
  });
});

describe('uninstall survey (public)', () => {
  it('204 without a session; 5 a day per IP', async () => {
    user = null;
    for (let i = 0; i < 5; i++) expect((await on.request('POST', `${PUB}/uninstall-survey`, { host: HOST, body: { reasons: ['privacy'] } })).status).toBe(204);
    expect((await on.request('POST', `${PUB}/uninstall-survey`, { host: HOST, body: { reasons: ['privacy'] } })).status).toBe(429);
  });

  it('422 on an unknown reason', async () => {
    expect((await on.request('POST', `${PUB}/uninstall-survey`, { host: HOST, body: { reasons: ['spam'] } })).status).toBe(422);
  });
});

describe('contentDisposition', () => {
  it('keeps an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('Ada "CV".pdf')).toBe(`attachment; filename="Ada _CV_.pdf"; filename*=UTF-8''Ada%20%22CV%22.pdf`);
  });
});
