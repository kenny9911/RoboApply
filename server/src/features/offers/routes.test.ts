// @vitest-environment node
//
// WP-64 route tests: every offers route answers through the platform
// envelope — auth (401), capability off (404 feature_disabled), validation
// (422), ownership (404), the GoApply phone gate and the daily limit on the AI
// routes (403 / 429), AI off (503, zero model calls) — and the happy paths.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { setFlagOverrideLoader } from '../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import type { TrackerEntryView, TrackerOffer } from '../tracker/index.js';
import type { NegotiationDraft, OfferBenchmark, OfferComparison, OfferExplanation, OfferView } from './contract.js';
import { createOffersRouter, OFFERS_AI_LIMIT_NAME, OFFERS_AI_WINDOWS } from './routes.js';
import { createOffersService } from './service.js';

const BASE = '/api/v1/roboapply/offers';
const OFF = '/off/offers';
const U = 'user_1';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

class NotFound extends Error {}

function entry(id: string, offer: TrackerOffer | null): TrackerEntryView {
  return {
    id,
    userId: U,
    jobId: null,
    status: 'offer',
    excitementStars: 0,
    maxSalary: null,
    maxSalaryCurrency: null,
    notesMarkdown: null,
    dateSaved: '2026-09-01T00:00:00.000Z',
    dateApplied: null,
    deadline: null,
    followUpAt: null,
    appliedVia: null,
    linkedRunId: null,
    job: null,
    externalSnapshot: { title: 'Data Analyst', companyName: `Co ${id}` },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: 'manual',
    stageDetail: null,
    outcome: null,
    interviewAt: null,
    offer,
    tailoredVariantId: null,
    coverLetterId: null,
  };
}

let h: RouteHarness;
let ai = true;
let phoneBound = true;
let limited = false;
const store = new Map<string, TrackerEntryView>();
const write = vi.fn(async () => ({ text: 'Thank you for the offer.', talkingPoints: ['Ask about the start date'] }));
const limiterCalls: Array<[string, unknown]> = [];
let limiterHits = 0;

const service = createOffersService({
  tracker: {
    entries: async () => [...store.values()],
    entry: async (_u, id) => {
      const e = store.get(id);
      if (!e) throw new NotFound();
      return e;
    },
    updateOffer: async (_u, id, offer) => {
      store.set(id, { ...store.get(id)!, offer });
    },
  },
  postedPay: { jobScope: async () => null, summary: async () => ({ postedRange: null, totalCount: 2, listedCount: 0 }) },
  market: () => 'intl',
  now: () => new Date('2026-10-10T00:00:00Z'),
  aiAvailable: async () => ai,
  write,
  isEntryNotFound: (err) => err instanceof NotFound,
});

const phoneGate: RequestHandler = (_req, res, next) => {
  if (phoneBound) return next();
  res.status(403).json({ success: false, code: 'phone_binding_required', error: 'Bind a phone first.' });
};
const limiter = (name: string, windows: unknown): RequestHandler => {
  limiterCalls.push([name, windows]);
  return (_req, res, next) => {
    limiterHits += 1;
    if (!limited) return next();
    res.status(429).json({ success: false, code: 'rate_limited', error: 'Too many.' });
  };
};

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  const auth = { seekerAuth: [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: U }))] };
  h = await startRouteHarness({
    mounts: [
      [BASE, createOffersRouter({ ...auth, env: { NODE_ENV: 'test' } }, { service, phoneGate, limiter })],
      [OFF, createOffersRouter({ ...auth, env: { NODE_ENV: 'test', FLAG_ROBOAPPLY_OFFERS: 'false', FLAG_GOAPPLY_OFFERS: 'false' } }, { service, phoneGate, limiter })],
    ],
  });
});
afterAll(async () => {
  setFlagOverrideLoader(null);
  await h.close();
});

describe('offers routes', () => {
  it('401 without a session on every route', async () => {
    const anon = { headers: { 'x-test-anon': '1' } };
    for (const [method, path] of [
      ['GET', BASE],
      ['POST', `${BASE}/compare`],
      ['POST', `${BASE}/explain`],
      ['PUT', `${BASE}/a`],
      ['DELETE', `${BASE}/a`],
      ['GET', `${BASE}/a/benchmark`],
      ['POST', `${BASE}/a/negotiation-draft`],
    ] as const) {
      expect((await h.request(method, path, anon)).status).toBe(401);
    }
  });

  it('404 feature_disabled when the offers capability is off', async () => {
    for (const [method, path, body] of [
      ['GET', OFF, undefined],
      ['POST', `${OFF}/compare`, { trackerEntryIds: ['a', 'b'] }],
      ['POST', `${OFF}/explain`, { trackerEntryIds: ['a', 'b'] }],
      ['PUT', `${OFF}/a`, { base: 1, currency: 'USD', period: 'year' }],
      ['DELETE', `${OFF}/a`, undefined],
      ['GET', `${OFF}/a/benchmark`, undefined],
      ['POST', `${OFF}/a/negotiation-draft`, {}],
    ] as const) {
      const res = await h.request<Env<unknown>>(method, path, { body });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('feature_disabled');
    }
  });

  it('PUT validates (422), 404s an unknown application, then saves; GET lists', async () => {
    store.set('a', entry('a', null));
    store.set('b', entry('b', null));
    const bad = await h.request<Env<unknown>>('PUT', `${BASE}/a`, { body: { base: 100, currency: 'usd', period: 'year' } });
    expect(bad.status).toBe(422);
    const extra = await h.request<Env<unknown>>('PUT', `${BASE}/a`, { body: { base: 100, currency: 'USD', period: 'year', surprise: true } });
    expect(extra.status).toBe(422);
    const missing = await h.request<Env<unknown>>('PUT', `${BASE}/zz`, { body: { base: 100, currency: 'USD', period: 'year' } });
    expect(missing.status).toBe(404);
    const ok = await h.request<Env<OfferView>>('PUT', `${BASE}/a`, { body: { base: 120000, currency: 'USD', period: 'year', signingBonus: 10000 } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ trackerEntryId: 'a', companyName: 'Co a', offer: { base: 120000, signingBonus: 10000 } });
    await h.request('PUT', `${BASE}/b`, { body: { base: 125000, currency: 'USD', period: 'year' } });
    const list = await h.request<Env<{ items: OfferView[]; aiAvailable: boolean }>>('GET', BASE);
    expect(list.body.data.items.map((i) => i.trackerEntryId).sort()).toEqual(['a', 'b']);
    expect(list.body.data.aiAvailable).toBe(true);
    ai = false; // the UI hides its AI actions on this answer
    expect((await h.request<Env<{ aiAvailable: boolean }>>('GET', BASE)).body.data.aiAvailable).toBe(false);
    ai = true;
  });

  it('POST /compare → totals; 422 for fewer than two ids or a repeated id', async () => {
    const one = await h.request<Env<unknown>>('POST', `${BASE}/compare`, { body: { trackerEntryIds: ['a'] } });
    expect(one.status).toBe(422);
    const same = await h.request<Env<unknown>>('POST', `${BASE}/compare`, { body: { trackerEntryIds: ['a', 'a'] } });
    expect(same.status).toBe(422);
    const sameExplain = await h.request<Env<unknown>>('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a', 'a'] } });
    expect(sameExplain.status).toBe(422);
    const res = await h.request<Env<OfferComparison>>('POST', `${BASE}/compare`, { body: { trackerEntryIds: ['a', 'b'] } });
    expect(res.status).toBe(200);
    expect(res.body.data.totals.map((t) => t.firstYear)).toEqual([130000, 125000]);
    expect(res.body.data.highest).toEqual({ recurringAnnual: ['b'], firstYear: ['a'] });
  });

  it('GET /:id/benchmark → absent below the sample, with the counts', async () => {
    const res = await h.request<Env<OfferBenchmark>>('GET', `${BASE}/a/benchmark`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ postedRange: null, reason: 'not_enough_data', totalCount: 2, listedCount: 0, minSample: 20 });
  });

  it('AI routes: limiter wired with the daily window; phone gate 403; limit 429; AI off 503 with no model call', async () => {
    expect(limiterCalls).toContainEqual([OFFERS_AI_LIMIT_NAME, OFFERS_AI_WINDOWS]);
    phoneBound = false;
    expect((await h.request('POST', `${BASE}/a/negotiation-draft`, { body: {} })).status).toBe(403);
    expect((await h.request('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a', 'b'] } })).status).toBe(403);
    phoneBound = true;
    limited = true;
    expect((await h.request('POST', `${BASE}/a/negotiation-draft`, { body: {} })).status).toBe(429);
    limited = false;
    ai = false;
    const off = await h.request<Env<unknown>>('POST', `${BASE}/a/negotiation-draft`, { body: {} });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('ai_unavailable');
    expect(write).not.toHaveBeenCalled();
    ai = true;
  });

  it('AI routes: bad input, an unknown offer and AI off answer before the daily limit (no call used)', async () => {
    const before = limiterHits;
    limited = true; // were the limiter consulted, these would all be 429
    expect((await h.request('POST', `${BASE}/a/negotiation-draft`, { body: { focus: 'everything' } })).status).toBe(422);
    expect((await h.request('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a'] } })).status).toBe(422);
    expect((await h.request('POST', `${BASE}/zz/negotiation-draft`, { body: {} })).status).toBe(404);
    expect((await h.request('POST', `${BASE}/a/negotiation-draft`, { body: { compareWith: ['zz'] } })).status).toBe(404);
    expect((await h.request('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a', 'zz'] } })).status).toBe(404);
    ai = false;
    const off = await h.request<Env<unknown>>('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a', 'b'] } });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('ai_unavailable');
    ai = true;
    expect(limiterHits).toBe(before);
    // A request that can reach the model does go through the limiter.
    expect((await h.request('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a', 'b'] } })).status).toBe(429);
    expect(limiterHits).toBe(before + 1);
    limited = false;
    expect(write).not.toHaveBeenCalled();
  });

  it('POST /:id/negotiation-draft and /explain → AI text, labelled as AI', async () => {
    const bad = await h.request<Env<unknown>>('POST', `${BASE}/a/negotiation-draft`, { body: { focus: 'everything' } });
    expect(bad.status).toBe(422);
    const draft = await h.request<Env<NegotiationDraft>>('POST', `${BASE}/a/negotiation-draft`, { body: { focus: 'start_date', compareWith: ['b'] }, headers: { 'x-robo-locale': 'zh' } });
    expect(draft.status).toBe(200);
    expect(draft.body.data).toMatchObject({ aiWritten: true, postedRange: null, text: 'Thank you for the offer.' });
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'negotiation', focus: 'start_date', locale: 'zh' }));
    const exp = await h.request<Env<OfferExplanation>>('POST', `${BASE}/explain`, { body: { trackerEntryIds: ['a', 'b'] } });
    expect(exp.status).toBe(200);
    expect(exp.body.data).toMatchObject({ aiWritten: true, trackerEntryIds: ['a', 'b'] });
  });

  it('DELETE clears the offer; a second delete is 404', async () => {
    const res = await h.request<Env<{ deleted: true }>>('DELETE', `${BASE}/a`);
    expect(res.body.data).toEqual({ deleted: true });
    expect((await h.request('DELETE', `${BASE}/a`)).status).toBe(404);
    expect((await h.request('GET', `${BASE}/a/benchmark`)).status).toBe(404);
  });
});
