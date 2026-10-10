// @vitest-environment node
//
// Route tests for the compliance routers (auth, brand, public, admin).
// Prisma is an in-memory fake; the queue and the object store are mocked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown, enqueue: null as unknown, kick: null as unknown }));

vi.mock('../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: (_t, p) => (h.db as Record<string | symbol, unknown>)[p] }),
}));
vi.mock('../../platform/queue/index.js', async (orig) => {
  const real = await orig<typeof import('../../platform/queue/index.js')>();
  return {
    ...real,
    enqueue: (...a: unknown[]) => (h.enqueue as (...x: unknown[]) => unknown)(...a),
    kickDrain: (...a: unknown[]) => (h.kick as (...x: unknown[]) => unknown)(...a),
  };
});
vi.mock('../../services/ResumeOriginalFileStorageService.js', () => ({
  resumeOriginalFileStorageService: {
    readFile: async () => ({ buffer: Buffer.from('{"exported":true}'), fileName: 'export.json', mimeType: 'application/json' }),
  },
}));

import { requireAdmin } from '../../middleware/admin.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../test/routeHarness.js';
import { CONSENT_PROSE_VERSION } from './consents.js';
import { createComplianceAdminRouter, createComplianceRouter, createLegalPublicRouter } from './routes.js';

const GO = 'goapply.localhost:3611';
const RA = 'localhost:3611';
const ENV = { NODE_ENV: 'test', DEPLOY_REGION: '' };
/** The deployment the browser check ran on: Neon in us-west-2 and a mainland AI model; no voice, no email, not on Vercel. */
const QA_ENV = { ...ENV, DATABASE_URL: 'postgresql://u:p@ep-quiet.us-west-2.aws.neon.tech/db', CN_LLM_MODEL: 'deepseek/deepseek-v4-flash' };

let harness: RouteHarness;
let user: HarnessUser | null = { id: 'u1', brand: 'goapply' };
let admin: HarnessUser | null = { id: 'admin1', role: 'admin' };

beforeAll(async () => {
  const auth = [fakeAuth(() => user)];
  harness = await startRouteHarness({
    env: ENV,
    mounts: [
      ['/c', createComplianceRouter({ seekerAuth: auth, env: ENV })],
      ['/p', createLegalPublicRouter({ env: ENV })],
      ['/q', createLegalPublicRouter({ env: QA_ENV })],
      // The real admin gate behind a fake session (the production chain is requireAuth + requireAdmin).
      ['/a', createComplianceAdminRouter({ adminAuth: [fakeAuth(() => admin), requireAdmin], env: ENV })],
    ],
  });
});
afterAll(() => harness.close());

beforeEach(() => {
  user = { id: 'u1', brand: 'goapply' };
  admin = { id: 'admin1', role: 'admin' };
  h.db = createFakePrisma({
    seed: { seekerProfile: [{ id: 'sp1', userId: 'u1' }] },
    defaults: { rAPersonalInfoRequest: { status: 'open', closedAt: null } },
  });
  h.enqueue = vi.fn(async (kind: string) => ({ id: `w-${kind}`, kind, status: 'queued', dedupeKey: null, created: true }));
  h.kick = vi.fn();
});

const rows = (model: string) => (h.db as ReturnType<typeof createFakePrisma>).$rows(model);

describe('seeker routes require a session', () => {
  it.each([
    ['GET', '/c/disclosures'],
    ['GET', '/c/consents'],
    ['POST', '/c/consents'],
    ['GET', '/c/pi-requests'],
    ['POST', '/c/pi-requests'],
    ['POST', '/c/export'],
    ['GET', '/c/exports/r1/download'],
    ['GET', '/c/retention'],
  ])('%s %s → 401', async (method, path) => {
    user = null;
    expect((await harness.request(method, path, { host: GO })).status).toBe(401);
  });
});

describe('consents', () => {
  it('GET lists the GoApply catalog in Chinese with nothing pre-checked', async () => {
    const res = await harness.request<{ data: { items: Array<{ type: string; granted: boolean | null; proseLocale: string; defaultGranted: boolean }> } }>(
      'GET',
      '/c/consents?locale=zh',
      { host: GO },
    );
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(items.map((i) => i.type)).toContain('pipl_cross_border');
    expect(items.every((i) => i.granted === null && i.defaultGranted === false)).toBe(true);
    expect(items[0]!.proseLocale).toBe('zh');
  });

  it('POST records with the prose hash; withdrawing the cross-border consent enqueues the purge', async () => {
    const ok = await harness.request<{ data: { proseHash: string } }>('POST', '/c/consents', {
      host: GO,
      body: { type: 'ai_resume_parsing', granted: true, proseVersion: CONSENT_PROSE_VERSION },
    });
    expect(ok.status).toBe(200);
    expect(rows('seekerConsentRecord')[0]).toMatchObject({ consentType: 'ai_resume_parsing', proseHash: ok.body.data.proseHash });

    const out = await harness.request<{ data: { accountClosing: boolean } }>('POST', '/c/consents', {
      host: GO,
      body: { type: 'pipl_cross_border', granted: false, proseVersion: CONSENT_PROSE_VERSION },
    });
    expect(out.body.data.accountClosing).toBe(true);
    expect(h.enqueue).toHaveBeenCalledWith('compliance.purge', expect.objectContaining({ userId: 'u1' }), expect.anything());
  });

  it('POST: 409 outdated prose, 422 bad body', async () => {
    expect((await harness.request('POST', '/c/consents', { host: GO, body: { type: 'ai_resume_parsing', granted: true, proseVersion: 'old' } })).status).toBe(409);
    expect((await harness.request('POST', '/c/consents', { host: GO, body: { type: 'x' } })).status).toBe(422);
  });
});

describe('personal-information requests and export', () => {
  it('POST /pi-requests files one; a second of the same kind is 409', async () => {
    const res = await harness.request<{ data: { kind: string; status: string; dueAt: string } }>('POST', '/c/pi-requests', {
      host: GO,
      body: { kind: 'correction', detail: 'My school name is wrong' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'correction', status: 'open' });
    expect(rows('rAPersonalInfoRequest')[0]).toMatchObject({ brand: 'goapply', detail: { userNote: 'My school name is wrong' } });
    expect((await harness.request('POST', '/c/pi-requests', { host: GO, body: { kind: 'correction' } })).status).toBe(409);
    const list = await harness.request<{ data: { items: unknown[] } }>('GET', '/c/pi-requests', { host: GO });
    expect(list.body.data.items).toHaveLength(1);
  });

  it('POST /export opens a copy request and enqueues the job', async () => {
    const res = await harness.request<{ data: { exportId: string; requestId: string; status: string } }>('POST', '/c/export', { host: RA });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ exportId: 'w-compliance.export', status: 'queued' });
    expect(rows('rAPersonalInfoRequest')[0]).toMatchObject({ kind: 'copy', brand: 'roboapply' });
    expect(h.enqueue).toHaveBeenCalledWith('compliance.export', { requestId: res.body.data.requestId }, expect.objectContaining({ userId: 'u1' }));
  });

  it('POST /pi-requests portability keeps the right the user filed and starts an export', async () => {
    const res = await harness.request<{ data: { kind: string } }>('POST', '/c/pi-requests', { host: RA, body: { kind: 'portability' } });
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('portability');
    expect(rows('rAPersonalInfoRequest')[0]).toMatchObject({ kind: 'portability', brand: 'roboapply' });
    expect(h.enqueue).toHaveBeenCalledWith('compliance.export', { requestId: rows('rAPersonalInfoRequest')[0]!.id }, expect.anything());
    const copy = await harness.request<{ data: { kind: string } }>('POST', '/c/pi-requests', { host: RA, body: { kind: 'copy' } });
    expect(copy.body.data.kind).toBe('copy');
  });

  it('download: owner only, not expired', async () => {
    rows('rAPersonalInfoRequest').push(
      { id: 'r1', brand: 'roboapply', userId: 'u1', kind: 'copy', status: 'done', dueAt: new Date(), createdAt: new Date(), closedAt: new Date('2026-10-10T00:00:00Z'), detail: { export: { provider: 'local', key: 'k', bytes: 17, expiresAt: '2099-01-01T00:00:00.000Z' } } },
      { id: 'r2', brand: 'roboapply', userId: 'u2', kind: 'copy', status: 'done', dueAt: new Date(), createdAt: new Date(), closedAt: new Date(), detail: { export: { provider: 'local', key: 'k', bytes: 17, expiresAt: '2099-01-01T00:00:00.000Z' } } },
      { id: 'r3', brand: 'roboapply', userId: 'u1', kind: 'copy', status: 'done', dueAt: new Date(), createdAt: new Date(), closedAt: new Date(), detail: { export: { provider: 'local', key: 'k', bytes: 17, expiresAt: '2020-01-01T00:00:00.000Z' } } },
    );
    const ok = await harness.request('GET', '/c/exports/r1/download', { host: RA });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toBe('attachment; filename="data-export-2026-10-10.json"');
    expect(ok.text).toBe('{"exported":true}');
    expect((await harness.request('GET', '/c/exports/r2/download', { host: RA })).status).toBe(404);
    expect((await harness.request('GET', '/c/exports/r3/download', { host: RA })).status).toBe(404);
  });

  it('GET /disclosures and /retention', async () => {
    const d = await harness.request<{ data: { brand: string; offshore: boolean } }>('GET', '/c/disclosures', { host: GO });
    expect(d.body.data).toMatchObject({ brand: 'goapply', offshore: true });
    const r = await harness.request<{ data: { items: unknown[] } }>('GET', '/c/retention', { host: GO });
    expect(r.body.data.items.length).toBeGreaterThan(10);
  });
});

describe('public legal router (no session)', () => {
  it('footer and disclosures per host', async () => {
    const go = await harness.request<{ data: { market: string; icp: unknown } }>('GET', '/p/footer', { host: GO });
    expect(go.status).toBe(200);
    expect(go.body.data).toMatchObject({ market: 'cn', icp: null });
    expect(go.headers.get('cache-control')).toBe('public, max-age=300');
    const ra = await harness.request<{ data: { market: string } }>('GET', '/p/footer', { host: RA });
    expect(ra.body.data.market).toBe('intl');
    expect((await harness.request('GET', '/p/disclosures', { host: RA })).status).toBe(200);
    expect((await harness.request('GET', '/p/retention', { host: RA })).status).toBe(200);
  });

  it('signup consent catalog without an account', async () => {
    const res = await harness.request<{ data: { items: Array<{ type: string; required: boolean }> } }>('GET', '/p/consents', {
      host: RA,
      headers: { 'x-vercel-ip-country': 'TW' },
    });
    expect(res.body.data.items.filter((i) => i.required).map((i) => i.type)).toEqual(['age_16_plus', 'tw_pdpa_notice']);
  });

  it('the sign-up consent text and the /legal disclosures name the same processors, regions and AI destination (D3)', async () => {
    type Consents = { data: { items: Array<{ type: string; prose: string; proseLocale: string }> } };
    type Disclosures = { data: { processors: Array<{ name: string; purpose: string; country: string | null; region: string | null }>; llmEndpoints: { rule: string } } };
    const consents = (await harness.request<Consents>('GET', '/q/consents?locale=zh', { host: GO })).body.data.items;
    const legal = (await harness.request<Disclosures>('GET', '/q/disclosures', { host: GO })).body.data;
    const cross = consents.find((i) => i.type === 'pipl_cross_border')!.prose;
    const ai = consents.find((i) => i.type === 'ai_resume_parsing')!.prose;
    // /legal: Neon · database · US / us-west-2, and deepseek · AI models · CN.
    expect(legal.processors).toEqual([
      { name: 'Neon', purpose: 'database', country: 'US', region: 'us-west-2' },
      { name: 'deepseek', purpose: 'ai_models', country: 'CN', region: null },
    ]);
    // The consent names the one offshore processor with that same region — not "美国东部", and nothing that is switched off.
    expect(cross).toContain('境外处理方：数据库 Neon（美国，us-west-2）。');
    expect(cross).not.toMatch(/美国东部|Vercel|LiveKit|Deepgram|Cartesia|Resend|deepseek/);
    // /legal says only mainland AI services are used; the AI consent says the same.
    expect(legal.llmEndpoints.rule).toBe('mainland_only');
    expect(ai).toContain('AI 请求只发送到中国大陆境内的 AI 服务。');
    expect(ai).not.toMatch(/境外/);
    for (const item of consents) expect(item.prose, item.type).not.toMatch(/%[A-Z_]+%/);
  });

  it('documents: served as drafts outside production, aliases resolve, unknown → 404', async () => {
    const doc = await harness.request<{ data: { doc: string; draft: boolean; markdown: string; locale: string } }>('GET', '/p/privacy', { host: GO });
    expect(doc.status).toBe(200);
    expect(doc.body.data).toMatchObject({ doc: 'privacy', draft: true, locale: 'zh' });
    expect(doc.body.data.markdown).toContain('隐私政策');
    expect(doc.body.data.markdown).not.toMatch(/\{\{/);
    const alias = await harness.request<{ data: { doc: string } }>('GET', '/p/agreement', { host: GO });
    expect(alias.body.data.doc).toBe('terms');
    expect((await harness.request('GET', '/p/cookies', { host: GO })).status).toBe(404);
    expect((await harness.request('GET', '/p/nope', { host: RA })).status).toBe(404);
    expect((await harness.request('GET', '/p/..%2F..%2Fsecret', { host: RA })).status).toBe(422);
  });
});

describe('admin router', () => {
  it('requires an admin; lists and updates requests', async () => {
    rows('rAPersonalInfoRequest').push({ id: 'r9', brand: 'goapply', userId: 'u1', kind: 'access', status: 'open', dueAt: new Date('2020-01-01'), createdAt: new Date('2019-12-01'), closedAt: null, detail: {} });
    admin = null;
    expect((await harness.request('GET', '/a/pi-requests', { host: GO })).status).toBe(401);
    admin = { id: 'u2', role: 'user' };
    expect((await harness.request('GET', '/a/pi-requests', { host: GO })).status).toBe(403);
    expect((await harness.request('PATCH', '/a/pi-requests/r9', { host: GO, body: { status: 'done' } })).status).toBe(403);
    expect(rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'open' });
    admin = { id: 'admin1', role: 'admin' };
    const list = await harness.request<{ data: { items: Array<{ id: string; overdue: boolean }> } }>('GET', '/a/pi-requests?overdue=true', { host: GO });
    expect(list.body.data.items).toEqual([expect.objectContaining({ id: 'r9', overdue: true })]);
    const upd = await harness.request<{ data: { status: string } }>('PATCH', '/a/pi-requests/r9', { host: GO, body: { status: 'done', note: 'Sent the copy' } });
    expect(upd.body.data.status).toBe('done');
    expect((await harness.request('PATCH', '/a/pi-requests/r9', { host: GO, body: {} })).status).toBe(422);
  });
});
