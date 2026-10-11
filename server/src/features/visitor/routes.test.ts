// @vitest-environment node
//
// WP-78 public routes over the route harness (no session anywhere):
//   GET  /api/v1/public/feed            20 items max, no fit, re-checked against the
//                                       public-page predicate, public job path, cache
//                                       headers, 429 from the per-IP limiter,
//                                       on by default on GoApply; 404 feature_disabled only
//                                       with CN_RECRUITMENT_INFO_MODE=off
//   POST /api/v1/public/copilot         SSE of the visitor turn; 404 with the flag off (the
//                                       default on both brands); GoApply with the flag on:
//                                       422 consent_required without the ticked consent
//                                       version, the same turn as RoboApply with it;
//                                       429 from the limiter; 422 on a bad body; envelope
//                                       error before the stream
//   /api/v1/public/alerts               202 signup on both brands with only the shared email
//                                       credentials, confirm GET (no change) + POST,
//                                       unsubscribe, 404 with alerts off (flag, or GoApply
//                                       mode off), 501 signup without an email transport

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { setFlagOverrideLoader } from '../../platform/flags.js';
import { HttpError } from '../../platform/http.js';
import { createUnsubscribeToken } from '../../platform/email/unsubscribe.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import type { PublicFeedItem } from '../feed/contract.js';
import { createPublicFeedRouter, createPublicFeedService, publicPathFor } from '../feed/publicRoutes.js';
import { VisitorAlertsService } from './alerts.js';
import { VISITOR_CONSENT_VERSION, VisitorTurnBodySchema, type AnonAlertView, type VisitorFeedResponse } from './contract.js';
import { createVisitorAlertsRouter, createVisitorCopilotRouter, publicCardOnly, type VisitorTurnFn } from './routes.js';
import { createMemoryVisitorAlertsRepo } from './testkit.js';
import { getBrand } from '../../platform/brand/registry.js';

type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown>; error?: string };

const ROBO_HOST = 'localhost:3621';
const GO_HOST = 'goapply.localhost:3621';
const NOW = new Date('2026-10-10T08:00:00.000Z');
const SECRET = { EMAIL_UNSUBSCRIBE_SECRET: 'route-secret' };
/**
 * "On" with only shared credentials: no CN_ value at all (D5). The visitor
 * assistant is the one opt-in (its registry default is off on both brands).
 */
const ENV_ON = {
  FLAG_ROBOAPPLY_VISITOR_ASSISTANT: 'true',
  FLAG_GOAPPLY_VISITOR_ASSISTANT: 'true',
  RESEND_API_KEY: 'k',
  ...SECRET,
};
const ENV_OFF = { FLAG_ROBOAPPLY_VISITOR_ASSISTANT: 'false', FLAG_ROBOAPPLY_JOBS_ALERTS: 'false', ...SECRET };
/** GoApply's operator off switches, each named explicitly. */
const ENV_CN_MODE_OFF = { ...ENV_ON, CN_RECRUITMENT_INFO_MODE: 'off' };
const ENV_CN_ALERTS_FLAG_OFF = { ...ENV_ON, FLAG_GOAPPLY_JOBS_ALERTS: 'false' };
const ENV_CN_EMAIL_NONE = { ...ENV_ON, CN_EMAIL_TRANSPORT: 'none' };
// A content-safety setting that cannot run turns GoApply AI off only under the
// strict posture; by default it degrades to the keyword list (plan §3.3, PAR-2 item 6).
const ENV_CN_AI_OFF = { ...ENV_ON, CN_CONTENT_SAFETY_PROVIDER: 'nonsense', CN_RESIDENCY_STRICT: 'true' };

function item(id: string, extra: Record<string, unknown> = {}): PublicFeedItem {
  return {
    jobId: id,
    title: 'Data Analyst',
    company: { id: null, name: 'Acme', logoUrl: null },
    location: 'Taipei',
    workModel: 'onsite',
    employmentType: 'full_time',
    seniority: null,
    pay: null,
    postedAt: '2026-10-09T00:00:00.000Z',
    lastSeenAt: '2026-10-10T00:00:00.000Z',
    source: { name: 'Acme careers', kind: 'ats_public' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    campus: null,
    position: null,
    ...extra,
  } as PublicFeedItem;
}

const passThrough: RequestHandler = (_req, _res, next) => next();
let limited = false;
const fakeLimiter: RequestHandler = (_req, res, next) => {
  if (limited) {
    res.setHeader('Retry-After', '30');
    res.status(429).json({ success: false, code: 'rate_limited', details: { retryAfterSec: 30 } });
    return;
  }
  next();
};

const publicList = vi.fn(async (input: { role?: string; limit: number }) => {
  const rows = Array.from({ length: 30 }, (_, i) => item(`j${i}`, i === 0 ? { fit: { tier: 'great', score: 91 }, tracker: { status: 'saved' } } : {}));
  return input.role === 'none' ? [] : rows;
});
const stillPublic = vi.fn(async (ids: string[]) => new Set(ids.filter((id) => id !== 'j1')));

let turnImpl: VisitorTurnFn = async () => ({
  async *[Symbol.asyncIterator]() {
    yield { event: 'meta', data: { threadId: 'visitor', messageId: 'm1' } };
    yield { event: 'delta', data: { text: 'Here are jobs.' } };
    yield { event: 'done', data: { messageId: 'm1', usage: { inputTokens: 1, outputTokens: 1 }, creditsRemaining: null } };
  },
});
const turnSpy = vi.fn<VisitorTurnFn>((input, options) => turnImpl(input, options));
/** `expired` and `dropped-provider` fail the public-page predicate. */
const copilotStillPublic = vi.fn(async (ids: string[]) => new Set(ids.filter((id) => id !== 'expired' && id !== 'dropped-provider')));

const repo = createMemoryVisitorAlertsRepo(() => NOW);
const sendConfirm = vi.fn(async () => ({ status: 'sent' as const }));
const alerts = new VisitorAlertsService({
  repo,
  rate: { consume: async () => ({ allowed: true, retryAfterSec: 0 }) },
  sendConfirm,
  origin: () => 'https://www.roboapply.io',
  now: () => NOW,
  env: SECRET,
  newToken: () => 'route-token-abcdefghijklmnop',
});

let h: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const feedDeps = { publicList, stillPublic, now: () => NOW, rateLimiter: fakeLimiter };
  h = await startRouteHarness({
    env: {},
    mounts: [
      ['/on/feed', createPublicFeedRouter({ env: ENV_ON, publicFeed: feedDeps })],
      ['/default/feed', createPublicFeedRouter({ env: {}, publicFeed: feedDeps })],
      ['/modeoff/feed', createPublicFeedRouter({ env: ENV_CN_MODE_OFF, publicFeed: feedDeps })],
      ['/on/copilot', createVisitorCopilotRouter({ env: ENV_ON, visitorCopilot: { turn: turnSpy, rateLimiter: fakeLimiter, stillPublic: copilotStillPublic, now: () => NOW } })],
      ['/off/copilot', createVisitorCopilotRouter({ env: ENV_OFF, visitorCopilot: { turn: turnSpy, rateLimiter: passThrough } })],
      ['/default/copilot', createVisitorCopilotRouter({ env: SECRET, visitorCopilot: { turn: turnSpy, rateLimiter: passThrough } })],
      ['/aioff/copilot', createVisitorCopilotRouter({ env: ENV_CN_AI_OFF, visitorCopilot: { turn: turnSpy, rateLimiter: passThrough } })],
      ['/on/alerts', createVisitorAlertsRouter({ env: ENV_ON, visitorAlerts: alerts })],
      ['/off/alerts', createVisitorAlertsRouter({ env: ENV_OFF, visitorAlerts: alerts })],
      ['/nomail/alerts', createVisitorAlertsRouter({ env: SECRET, visitorAlerts: alerts })],
      ['/modeoff/alerts', createVisitorAlertsRouter({ env: ENV_CN_MODE_OFF, visitorAlerts: alerts })],
      ['/flagoff/alerts', createVisitorAlertsRouter({ env: ENV_CN_ALERTS_FLAG_OFF, visitorAlerts: alerts })],
      ['/cnnomail/alerts', createVisitorAlertsRouter({ env: ENV_CN_EMAIL_NONE, visitorAlerts: alerts })],
    ],
  });
});

afterAll(async () => {
  setFlagOverrideLoader(null);
  await h.close();
});

describe('GET /public/feed', () => {
  it('lists at most 20 public items, drops what fails the public-page re-check, never a fit', async () => {
    const res = await h.request<Env<VisitorFeedResponse>>('GET', '/on/feed?role=Data%20analyst&city=Taipei&country=TW', { host: ROBO_HOST });
    expect(res.status).toBe(200);
    const { items, asOf } = res.body.data;
    expect(items).toHaveLength(20);
    expect(items.map((i) => i.jobId)).not.toContain('j1');
    expect(items.every((i) => !('fit' in i) && !('tracker' in i))).toBe(true);
    expect(items[0]!.path).toBe('/job/j0-data-analyst-acme');
    expect(asOf).toBe(NOW.toISOString());
    expect(publicList).toHaveBeenCalledWith({ role: 'Data analyst', city: 'Taipei', country: 'TW', limit: 50 });
    expect(res.headers.get('cache-control')).toContain('s-maxage=900');
  });

  it('serves the same query from the 15-minute cache', async () => {
    publicList.mockClear();
    await h.request('GET', '/on/feed?role=Data%20analyst&city=Taipei&country=TW', { host: ROBO_HOST });
    expect(publicList).not.toHaveBeenCalled();
  });

  it('GoApply lists postings by default (no CN_ value); CN_RECRUITMENT_INFO_MODE=off → 404 feature_disabled', async () => {
    for (const mount of ['/on/feed', '/default/feed']) {
      const res = await h.request<Env<VisitorFeedResponse>>('GET', `${mount}?role=x`, { host: GO_HOST });
      expect(res.status, mount).toBe(200);
      expect(res.body.data.items.length, mount).toBeGreaterThan(0);
      // The item's page is the public job page or null (an older feed build); never an app path.
      const path = res.body.data.items[0]!.path;
      expect(path === null || path.startsWith('/job/'), mount).toBe(true);
      // Market cn: the CDN keeps a list 60 s, so a mode switched off is not outlived by cached postings.
      expect(res.headers.get('cache-control'), mount).toBe('public, max-age=0, s-maxage=60');
    }
    const off = await h.request<Env<unknown>>('GET', '/modeoff/feed', { host: GO_HOST });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
    // The switch is GoApply's: RoboApply still lists with it set.
    expect((await h.request('GET', '/modeoff/feed?role=y', { host: ROBO_HOST })).status).toBe(200);
  });

  it('422 on a bad country, 429 from the per-IP limiter', async () => {
    expect((await h.request('GET', '/on/feed?country=taiwan', { host: ROBO_HOST })).status).toBe(422);
    limited = true;
    try {
      const res = await h.request<Env<unknown>>('GET', '/on/feed?role=other', { host: ROBO_HOST });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('30');
    } finally {
      limited = false;
    }
  });

  it('empty list is an empty list (no padding)', async () => {
    const res = await h.request<Env<VisitorFeedResponse>>('GET', '/on/feed?role=none', { host: ROBO_HOST });
    expect(res.body.data.items).toEqual([]);
  });

  it('cache is per brand and query; the service caps and evicts', async () => {
    const svc = createPublicFeedService({ publicList, stillPublic, now: () => NOW });
    publicList.mockClear();
    await svc.list({ role: 'A' }, getBrand('roboapply'));
    await svc.list({ role: ' a ' }, getBrand('roboapply'));
    await svc.list({ role: 'a' }, getBrand('goapply'));
    expect(publicList).toHaveBeenCalledTimes(2);
    expect(publicPathFor({ jobId: 'x', title: '工程师', company: { id: null, name: '公司', logoUrl: null } }, getBrand('roboapply'))).toBe('/job/x');
  });
});

describe('POST /public/copilot', () => {
  const body = { text: 'Remote data jobs?', pageContext: { path: '/browse/data-analyst', role: 'Data analyst' } };

  it('streams the turn as SSE with page context and the visitor locale; public tools only', async () => {
    const res = await h.request('POST', '/on/copilot', { host: ROBO_HOST, body, headers: { 'x-robo-locale': 'ja' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.text).toContain('event: meta');
    expect(res.text).toContain('event: delta\ndata: {"text":"Here are jobs."}');
    expect(res.text).toContain('event: done');
    expect(turnSpy).toHaveBeenCalledWith(body, expect.objectContaining({ tools: 'public', locale: 'ja' }));
  });

  it('re-checks job_list cards against the public-page rules: drops failing items, drops a card left empty, passes other cards', async () => {
    turnImpl = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { event: 'meta', data: { threadId: 'visitor', messageId: 'm3' } };
        yield { event: 'card', data: { type: 'job_list', id: 'c1', data: { items: [item('ok'), item('expired')], visitor: true } } };
        yield { event: 'card', data: { type: 'job_list', id: 'c2', data: { items: [item('dropped-provider')], visitor: true } } };
        yield { event: 'card', data: { type: 'salary', id: 'c3', data: { note: 'kept' } } };
        yield { event: 'done', data: { messageId: 'm3' } };
      },
    });
    copilotStillPublic.mockClear();
    const res = await h.request('POST', '/on/copilot', { host: ROBO_HOST, body });
    expect(res.status).toBe(200);
    expect(copilotStillPublic).toHaveBeenCalledWith(['ok', 'expired'], expect.objectContaining({ id: 'roboapply' }), NOW);
    const cards = res.text
      .split('\n\n')
      .filter((frame) => frame.startsWith('event: card'))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { id: string; data: { items?: Array<{ jobId: string }> } });
    expect(cards.map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(cards[0]!.data.items!.map((i) => i.jobId)).toEqual(['ok']);
    expect(res.text).not.toContain('expired');
    expect(res.text).not.toContain('dropped-provider');
  });

  it('a job_list card is dropped when the public-page check fails (fail closed)', async () => {
    const card = { type: 'job_list', id: 'c', data: { items: [item('a')] } };
    const boom = async () => {
      throw new Error('db down');
    };
    expect(await publicCardOnly(card, getBrand('roboapply'), NOW, boom)).toBeNull();
    expect(await publicCardOnly({ type: 'job_list', id: 'c', data: { items: [] } }, getBrand('roboapply'), NOW, copilotStillPublic)).toBeNull();
    const other = { type: 'notice', id: 'n', data: {} };
    expect(await publicCardOnly(other, getBrand('roboapply'), NOW, boom)).toBe(other);
  });

  it('an error thrown mid-stream becomes an error event', async () => {
    turnImpl = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { event: 'meta', data: { threadId: 'visitor', messageId: 'm2' } };
        throw new Error('model down');
      },
    });
    const res = await h.request('POST', '/on/copilot', { host: ROBO_HOST, body });
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('"retryable":true');
  });

  it('an error before the stream (daily budget) answers as an envelope', async () => {
    turnImpl = async () => {
      throw new HttpError('ai_unavailable', 'busy', { reason: 'copilot_daily_budget' });
    };
    const res = await h.request<Env<unknown>>('POST', '/on/copilot', { host: ROBO_HOST, body });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
  });

  it('422 on a bad body, 429 from the limiter, 404 with the flag off', async () => {
    expect((await h.request('POST', '/on/copilot', { host: ROBO_HOST, body: { text: '' } })).status).toBe(422);
    limited = true;
    try {
      expect((await h.request('POST', '/on/copilot', { host: ROBO_HOST, body })).status).toBe(429);
    } finally {
      limited = false;
    }
    const off = await h.request<Env<unknown>>('POST', '/off/copilot', { host: ROBO_HOST, body });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
    // The registry default is off on both brands: no override → 404, with or without the consent.
    for (const host of [ROBO_HOST, GO_HOST]) {
      const res = await h.request<Env<unknown>>('POST', '/default/copilot', { host, body: { ...body, consent: VISITOR_CONSENT_VERSION } });
      expect(res.status, host).toBe(404);
      expect(res.body.code, host).toBe('feature_disabled');
    }
  });

  it('RoboApply is unchanged: no consent is asked, and one that is sent is not passed on', async () => {
    turnImpl = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { event: 'done', data: { messageId: 'm9' } };
      },
    });
    turnSpy.mockClear();
    expect((await h.request('POST', '/on/copilot', { host: ROBO_HOST, body })).status).toBe(200);
    expect((await h.request('POST', '/on/copilot', { host: ROBO_HOST, body: { ...body, consent: VISITOR_CONSENT_VERSION } })).status).toBe(200);
    expect(turnSpy).toHaveBeenCalledTimes(2);
    for (const call of turnSpy.mock.calls) expect(call[0]).toEqual(body);
  });
});

describe('POST /public/copilot on GoApply (flag on, shared stack only)', () => {
  const body = { text: '上海有哪些数据分析岗位？', pageContext: { path: '/browse/data-analyst', role: '数据分析师' } };
  const ok: VisitorTurnFn = async () => ({
    async *[Symbol.asyncIterator]() {
      yield { event: 'meta', data: { threadId: 'visitor', messageId: 'g1' } };
      yield { event: 'delta', data: { text: '这里是公开职位。' } };
      yield { event: 'done', data: { messageId: 'g1' } };
    },
  });

  it('without the consent: 422 consent_required, no model call, and the visitor allowance is not used', async () => {
    turnImpl = ok;
    turnSpy.mockClear();
    // The limiter would refuse: the consent check answers first, so a refused turn costs nothing.
    limited = true;
    try {
      for (const bad of [body, { ...body, consent: '' }, { ...body, consent: 'yes' }, { ...body, consent: 'visitor-assistant.2026-01-01.v0' }]) {
        const res = await h.request<Env<unknown>>('POST', '/on/copilot', { host: GO_HOST, body: bad });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'invalid_request', details: { reason: 'consent_required', consentVersion: VISITOR_CONSENT_VERSION } });
      }
    } finally {
      limited = false;
    }
    expect(turnSpy).not.toHaveBeenCalled();
  });

  it('with the ticked consent version: the visitor gets an answer, in Chinese, through the same turn as RoboApply', async () => {
    turnImpl = ok;
    turnSpy.mockClear();
    const res = await h.request('POST', '/on/copilot', { host: GO_HOST, body: { ...body, consent: VISITOR_CONSENT_VERSION }, headers: { 'x-robo-locale': 'zh' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.text).toContain('这里是公开职位。');
    expect(res.text).toContain('event: done');
    // The Assistant receives the turn only (no consent field), with public tools and the visitor's locale.
    expect(turnSpy).toHaveBeenCalledWith(body, expect.objectContaining({ tools: 'public', locale: 'zh' }));
  });

  it('job cards are re-checked against the public-page rules for GoApply too', async () => {
    turnImpl = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { event: 'card', data: { type: 'job_list', id: 'c1', data: { items: [item('ok'), item('expired')] } } };
        yield { event: 'done', data: { messageId: 'g2' } };
      },
    });
    copilotStillPublic.mockClear();
    const res = await h.request('POST', '/on/copilot', { host: GO_HOST, body: { ...body, consent: VISITOR_CONSENT_VERSION } });
    expect(copilotStillPublic).toHaveBeenCalledWith(['ok', 'expired'], expect.objectContaining({ id: 'goapply', market: 'cn' }), NOW);
    expect(res.text).toContain('"jobId":"ok"');
    expect(res.text).not.toContain('expired');
  });

  it('the limiter and a bad body still apply once the consent is there', async () => {
    limited = true;
    try {
      expect((await h.request('POST', '/on/copilot', { host: GO_HOST, body: { ...body, consent: VISITOR_CONSENT_VERSION } })).status).toBe(429);
    } finally {
      limited = false;
    }
    expect((await h.request('POST', '/on/copilot', { host: GO_HOST, body: { text: '', pageContext: { path: '/' }, consent: VISITOR_CONSENT_VERSION } })).status).toBe(422);
    expect((await h.request('POST', '/on/copilot', { host: GO_HOST, body: { ...body, consent: VISITOR_CONSENT_VERSION, extra: 1 } })).status).toBe(422);
  });

  it('off switch: under CN_RESIDENCY_STRICT an unusable content-safety filter turns GoApply AI off (503 ai_unavailable), consent or not; RoboApply is not affected', async () => {
    turnImpl = ok;
    turnSpy.mockClear();
    const go = await h.request<Env<unknown>>('POST', '/aioff/copilot', { host: GO_HOST, body: { ...body, consent: VISITOR_CONSENT_VERSION } });
    expect(go.status).toBe(503);
    expect(go.body.code).toBe('ai_unavailable');
    expect(turnSpy).not.toHaveBeenCalled();
    expect((await h.request('POST', '/aioff/copilot', { host: ROBO_HOST, body })).status).toBe(200);
  });

  it('the body schema: consent is optional text, unknown keys are refused', () => {
    expect(VisitorTurnBodySchema.safeParse(body).success).toBe(true);
    expect(VisitorTurnBodySchema.safeParse({ ...body, consent: VISITOR_CONSENT_VERSION }).success).toBe(true);
    expect(VisitorTurnBodySchema.safeParse({ ...body, consent: 'x'.repeat(65) }).success).toBe(false);
    expect(VisitorTurnBodySchema.safeParse({ ...body, other: true }).success).toBe(false);
    expect(VISITOR_CONSENT_VERSION).toMatch(/^visitor-assistant\.\d{4}-\d{2}-\d{2}\.v\d+$/);
  });
});

describe('/public/alerts', () => {
  const signup = { email: 'Visitor@Example.com', filters: { q: 'Data analyst' }, frequency: 'daily', locale: 'en', consent: true };

  it('202 pending_confirmation; consent must be ticked', async () => {
    const res = await h.request<Env<unknown>>('POST', '/on/alerts', { host: ROBO_HOST, body: signup });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'pending_confirmation' });
    expect(sendConfirm).toHaveBeenCalledTimes(1);
    expect((await h.request('POST', '/on/alerts', { host: ROBO_HOST, body: { ...signup, consent: false } })).status).toBe(422);
  });

  it('422 on loose filters: over-long or empty place, unknown keys, long search, control characters, more than one place', async () => {
    sendConfirm.mockClear();
    const bad = [
      { q: 'x'.repeat(121) },
      { q: 'Data\u0007analyst' },
      { locations: [{ label: 'x'.repeat(81) }] },
      { locations: [{ label: '   ' }] },
      { locations: [{ label: 'Taipei', country: 'taiwan' }] },
      { locations: [{ label: 'Taipei', evil: 'payload' }] },
      { locations: [{ label: 'Taipei' }, { label: 'Tainan' }] },
      { q: 'Data', extra: true },
    ];
    for (const filters of bad) {
      const res = await h.request<Env<unknown>>('POST', '/on/alerts', { host: ROBO_HOST, body: { ...signup, email: 'loose@example.com', filters } });
      expect(res.status, JSON.stringify(filters)).toBe(422);
    }
    expect(sendConfirm).not.toHaveBeenCalled();
    expect(repo.rows.some((r) => r.email === 'loose@example.com')).toBe(false);
    const ok = await h.request('POST', '/on/alerts', {
      host: ROBO_HOST,
      body: { ...signup, email: 'strict@example.com', filters: { q: 'Nurse', locations: [{ label: 'Taipei', city: 'Taipei', country: 'TW' }], workModels: ['remote'] } },
    });
    expect(ok.status).toBe(202);
    expect(repo.rows.find((r) => r.email === 'strict@example.com')!.filters).toEqual({ q: 'Nurse', locations: [{ label: 'Taipei', city: 'Taipei', country: 'TW' }], workModels: ['remote'] });
  });

  it('GET /confirm reads without change, POST /confirm confirms', async () => {
    const q = '?token=route-token-abcdefghijklmnop';
    const read = await h.request<Env<AnonAlertView>>('GET', `/on/alerts/confirm${q}`, { host: ROBO_HOST });
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ state: 'pending', cadence: 'daily', emailMasked: 'v•••@example.com' });
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(repo.rows[0]!.status).toBe('pending');
    const done = await h.request<Env<AnonAlertView>>('POST', '/on/alerts/confirm', { host: ROBO_HOST, body: { token: 'route-token-abcdefghijklmnop' } });
    expect(done.body.data.state).toBe('confirmed');
    const bad = await h.request<Env<unknown>>('GET', '/on/alerts/confirm?token=xxxxxxxxxxxxxxxxxxxx', { host: ROBO_HOST });
    expect(bad.status).toBe(404);
    expect(bad.body.details).toEqual({ reason: 'alert_token_invalid' });
  });

  it('one-click unsubscribe with the email token', async () => {
    const token = createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', email: 'visitor@example.com', env: SECRET });
    const res = await h.request<Env<unknown>>('POST', '/on/alerts/unsubscribe', { host: ROBO_HOST, body: { token } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ unsubscribed: true });
    expect(repo.rows[0]!.status).toBe('unsubscribed');
  });

  it('404 feature_disabled with alerts off; 501 provider_not_configured for signup without an email transport', async () => {
    const off = await h.request<Env<unknown>>('POST', '/off/alerts', { host: ROBO_HOST, body: signup });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
    expect((await h.request('GET', '/off/alerts/confirm?token=route-token-abcdefghijklmnop', { host: ROBO_HOST })).status).toBe(404);
    expect((await h.request('POST', '/off/alerts/unsubscribe', { host: ROBO_HOST, body: { token: 'x'.repeat(20) } })).status).toBe(404);
    sendConfirm.mockClear();
    const nomail = await h.request<Env<unknown>>('POST', '/nomail/alerts', { host: ROBO_HOST, body: signup });
    expect(nomail.status).toBe(501);
    expect(nomail.body.code).toBe('provider_not_configured');
    expect(sendConfirm).not.toHaveBeenCalled();
  });
});

describe('/public/alerts on GoApply (shared email credentials only)', () => {
  const signup = { email: 'Reader@Example.cn', filters: { q: '数据分析师', locations: [{ label: '上海', city: '上海', country: 'CN' }] }, frequency: 'weekly', locale: 'zh', consent: true };

  it('202 pending_confirmation and the confirmation mail is sent, with no CN_ value set', async () => {
    sendConfirm.mockClear();
    const res = await h.request<Env<unknown>>('POST', '/on/alerts', { host: GO_HOST, body: signup });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'pending_confirmation' });
    expect(sendConfirm).toHaveBeenCalledTimes(1);
    expect(sendConfirm).toHaveBeenCalledWith(expect.objectContaining({ brand: expect.objectContaining({ id: 'goapply' }), to: 'reader@example.cn', locale: 'zh' }));
    expect(repo.rows.find((r) => r.email === 'reader@example.cn')).toMatchObject({ brand: 'goapply', status: 'pending', cadence: 'weekly' });
    // The consent tick is required on GoApply exactly as on RoboApply.
    expect((await h.request('POST', '/on/alerts', { host: GO_HOST, body: { ...signup, consent: false } })).status).toBe(422);
  });

  it('off switch CN_RECRUITMENT_INFO_MODE=off: every alerts route is 404 feature_disabled on GoApply, not on RoboApply', async () => {
    sendConfirm.mockClear();
    const off = await h.request<Env<unknown>>('POST', '/modeoff/alerts', { host: GO_HOST, body: { ...signup, email: 'off@example.cn' } });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
    expect((await h.request('GET', '/modeoff/alerts/confirm?token=route-token-abcdefghijklmnop', { host: GO_HOST })).status).toBe(404);
    expect((await h.request('POST', '/modeoff/alerts/unsubscribe', { host: GO_HOST, body: { token: 'x'.repeat(20) } })).status).toBe(404);
    expect(sendConfirm).not.toHaveBeenCalled();
    expect(repo.rows.some((r) => r.email === 'off@example.cn')).toBe(false);
    expect((await h.request('POST', '/modeoff/alerts', { host: ROBO_HOST, body: { ...signup, email: 'intl-mode@example.com', locale: 'en' } })).status).toBe(202);
  });

  it('off switch FLAG_GOAPPLY_JOBS_ALERTS=false: 404 feature_disabled', async () => {
    const off = await h.request<Env<unknown>>('POST', '/flagoff/alerts', { host: GO_HOST, body: { ...signup, email: 'flag@example.cn' } });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
  });

  it('off switch CN_EMAIL_TRANSPORT=none, or no email credentials at all: 501 provider_not_configured, nothing stored', async () => {
    sendConfirm.mockClear();
    for (const mount of ['/cnnomail/alerts', '/nomail/alerts']) {
      const res = await h.request<Env<unknown>>('POST', mount, { host: GO_HOST, body: { ...signup, email: 'nomail@example.cn' } });
      expect(res.status, mount).toBe(501);
      expect(res.body.code, mount).toBe('provider_not_configured');
    }
    expect(sendConfirm).not.toHaveBeenCalled();
    expect(repo.rows.some((r) => r.email === 'nomail@example.cn')).toBe(false);
    // CN_EMAIL_TRANSPORT is GoApply's switch: RoboApply still signs up with it set.
    expect((await h.request('POST', '/cnnomail/alerts', { host: ROBO_HOST, body: { ...signup, email: 'intl-mail@example.com', locale: 'en' } })).status).toBe(202);
  });
});
