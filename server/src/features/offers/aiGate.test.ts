// @vitest-environment node
//
// WP-64 production wiring (§2.2): the real `offersAiAvailable` — the user's AI
// consent through the real `aiAllowed` (GoApply needs a live
// `ai_resume_parsing` grant) AND the brand's `ai.text` capability — and the
// service from `getOffersService()` / the router with no injected service
// answer 503 ai_unavailable with ZERO model calls (OfferWriterAgent is never
// constructed) when either is off. No database, no model: prisma, the tracker
// core and the agent are mocked; the consent and user-brand lookups use their
// test seams.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

const flags = vi.hoisted(() => ({ isEnabled: vi.fn() }));
vi.mock('../../platform/flags.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isEnabled: flags.isEnabled }));

const model = vi.hoisted(() => ({ constructed: vi.fn(), run: vi.fn() }));
vi.mock('./OfferWriterAgent.js', () => ({
  OfferWriterAgent: class {
    constructor() {
      model.constructed();
    }
    run = model.run;
  },
}));

const tracker = vi.hoisted(() => {
  class TrackerNotFoundError extends Error {}
  const offer = (base: number) => ({ base, currency: 'USD', period: 'year' });
  const entry = (id: string, base: number) => ({
    id,
    userId: 'u',
    jobId: null,
    status: 'offer',
    externalSnapshot: { title: 'Data Analyst', companyName: `Co ${id}` },
    job: null,
    offer: offer(base),
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  const entries = [entry('a', 120000), entry('b', 125000)];
  return {
    TrackerNotFoundError,
    entries,
    core: {
      exportEntries: vi.fn(async () => entries),
      getById: vi.fn(async (_u: string, id: string) => {
        const e = entries.find((x) => x.id === id);
        if (!e) throw new TrackerNotFoundError('nope');
        return e;
      }),
      updateOffer: vi.fn(async () => undefined),
    },
  };
});
vi.mock('../tracker/index.js', () => ({ trackerCore: tracker.core, TrackerNotFoundError: tracker.TrackerNotFoundError }));

import { setConsentLookup } from '../../platform/consent/aiAllowed.js';
import { setUserBrandLookup } from '../../platform/brand/userBrand.js';
import { BRANDS } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createOffersRouter, getOffersService, offersAiAvailable } from './index.js';

const RA_USER = 'user_ra';
const GA_USER = 'user_ga';
let consent: boolean | null;

beforeEach(() => {
  flags.isEnabled.mockReset();
  model.constructed.mockReset();
  model.run.mockReset();
  setUserBrandLookup(async (id) => (id === GA_USER ? 'goapply' : id === RA_USER ? 'roboapply' : null));
  consent = null;
  setConsentLookup(async () => (consent === null ? null : { consentType: 'ai_resume_parsing', granted: consent, createdAt: new Date('2026-10-01T00:00:00Z') }));
  flags.isEnabled.mockResolvedValue(true);
});

afterAll(() => {
  setUserBrandLookup(null);
  setConsentLookup(null);
});

async function expectAiUnavailable(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe('ai_unavailable');
}

describe('offersAiAvailable (consent AND the ai.text capability)', () => {
  it('GoApply without a live ai_resume_parsing grant: false, before the capability is read', async () => {
    expect(await offersAiAvailable(GA_USER)).toBe(false);
    consent = false; // revoked
    expect(await offersAiAvailable(GA_USER)).toBe(false);
    expect(flags.isEnabled).not.toHaveBeenCalled();
  });

  it('with consent (GoApply) and on RoboApply: follows ai.text for that user', async () => {
    consent = true;
    expect(await offersAiAvailable(GA_USER)).toBe(true);
    expect(await offersAiAvailable(RA_USER)).toBe(true);
    expect(flags.isEnabled).toHaveBeenCalledWith('ai.text', { userId: RA_USER });
    flags.isEnabled.mockResolvedValue(false);
    expect(await offersAiAvailable(GA_USER)).toBe(false);
    expect(await offersAiAvailable(RA_USER)).toBe(false);
  });

  it('GoApply with consent but no CN text model configured (real ai.text check): false', async () => {
    consent = true;
    const real = await vi.importActual<typeof import('../../platform/flags.js')>('../../platform/flags.js');
    setFlagOverrideLoader(async () => []);
    flags.isEnabled.mockImplementation((key: Parameters<typeof real.isEnabled>[0], opts: Parameters<typeof real.isEnabled>[1]) =>
      real.isEnabled(key, { ...opts, brand: BRANDS.goapply, env: { NODE_ENV: 'test' } }),
    );
    expect(await offersAiAvailable(GA_USER)).toBe(false);
    // Control: the same check is true once a CN text model is configured.
    flags.isEnabled.mockImplementation((key: Parameters<typeof real.isEnabled>[0], opts: Parameters<typeof real.isEnabled>[1]) =>
      real.isEnabled(key, { ...opts, brand: BRANDS.goapply, env: { NODE_ENV: 'test', CN_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', CN_LLM_MODEL: 'deepseek-chat' } }),
    );
    expect(await offersAiAvailable(GA_USER)).toBe(true);
    setFlagOverrideLoader(null);
  });

  it('an unknown user fails closed', async () => {
    expect(await offersAiAvailable('nobody')).toBe(false);
  });
});

describe('the production service (getOffersService)', () => {
  it('GoApply without consent: 503 and zero model calls (draft and explanation)', async () => {
    const svc = getOffersService();
    await expectAiUnavailable(svc.negotiationDraft(GA_USER, 'a', {}, 'zh'));
    await expectAiUnavailable(svc.explain(GA_USER, ['a', 'b'], 'zh'));
    expect(model.constructed).not.toHaveBeenCalled();
    expect(model.run).not.toHaveBeenCalled();
  });

  it('ai.text off (RoboApply): 503 and zero model calls', async () => {
    flags.isEnabled.mockResolvedValue(false);
    const svc = getOffersService();
    await expectAiUnavailable(svc.negotiationDraft(RA_USER, 'a', {}, 'en'));
    await expectAiUnavailable(svc.explain(RA_USER, ['a', 'b'], 'en'));
    expect(model.constructed).not.toHaveBeenCalled();
  });

  it('with consent and ai.text on, the same wiring does reach the model (control)', async () => {
    consent = true;
    model.run.mockResolvedValue({ text: 'Offer a pays 120,000 and offer b pays 125,000.', talkingPoints: [] });
    const out = await getOffersService().explain(GA_USER, ['a', 'b'], 'zh');
    expect(out.aiWritten).toBe(true);
    expect(model.constructed).toHaveBeenCalledTimes(1);
  });
});

describe('the router with its default service', () => {
  let h: RouteHarness;
  const limiterHits = vi.fn();
  const limiter = (): RequestHandler => (_req, _res, next) => {
    limiterHits();
    next();
  };
  const pass: RequestHandler = (_req, _res, next) => next();

  beforeAll(async () => {
    setFlagOverrideLoader(async () => []);
    h = await startRouteHarness({
      mounts: [
        [
          '/offers',
          createOffersRouter(
            { seekerAuth: [fakeAuth((req) => ({ id: String(req.headers['x-test-user'] ?? GA_USER) }))], env: { NODE_ENV: 'test' } },
            { phoneGate: pass, limiter },
          ),
        ],
      ],
    });
  });
  afterAll(async () => {
    setFlagOverrideLoader(null);
    await h.close();
  });

  it('GoApply without consent: both AI routes answer 503 before the daily limit, with no model call', async () => {
    const draft = await h.request<{ code?: string }>('POST', '/offers/a/negotiation-draft', { body: {} });
    expect(draft.status).toBe(503);
    expect(draft.body.code).toBe('ai_unavailable');
    const explain = await h.request<{ code?: string }>('POST', '/offers/explain', { body: { trackerEntryIds: ['a', 'b'] } });
    expect(explain.status).toBe(503);
    expect(limiterHits).not.toHaveBeenCalled();
    expect(model.constructed).not.toHaveBeenCalled();
  });
});
