// @vitest-environment node
//
// WP-30: every onboarding route through the route harness (auth, envelopes,
// error codes, the SSE stream), over the in-memory repo. No DB, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { NotImplementedError } from '../../platform/http.js';
import { createOnboardingRouter } from './routes.js';
import { createOnboardingService, type OnboardingDeps } from './service.js';
import { suggestTitles } from './defaults.js';
import type { MatchPipelineDeps } from './match.js';
import type { RateLimitDb } from '../../platform/ratelimit/index.js';
import { SAMPLE_BASICS, createMemoryRepo, createMemorySearchProfiles, preScoreFixture } from './testkit.js';

const RA = 'localhost:3621';
const GO = 'goapply.localhost:3621';
type Body<T = Record<string, unknown>> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

let h: RouteHarness | undefined;
let userId: string | null = 'u1';
let mem: ReturnType<typeof createMemoryRepo>;

async function start(over: Partial<OnboardingDeps> = {}, routerOpts: { rateLimitDb?: RateLimitDb } = {}) {
  mem = createMemoryRepo({ u1: {} });
  const sp = createMemorySearchProfiles();
  const deps: OnboardingDeps = {
    repo: mem.repo,
    searchProfiles: sp.api,
    profile: { setLinkedin: async () => undefined, setSponsorship: async () => undefined, setCnFields: async () => undefined },
    validateCnStep: async () => {
      throw new NotImplementedError('onboardingCn.validateCnStep');
    },
    snapshot: async () => ({ jobCount: { value: 3, source: 'index' as const, sampleSize: 3, asOf: '2026-10-10T00:00:00.000Z' }, windowDays: 30, pay: null, topSkills: [] }),
    titleSuggest: suggestTitles,
    seedResume: () => ({ roles: ['Backend Engineer'], seniority: null, years: 4 }),
    aiAllowed: async () => true,
    consumeResumeQuota: async () => ({ allowed: true, retryAfterSec: 0 }),
    grantFreeResumeCheck: async () => 'already_granted' as const,
    queueResumeCheck: async () => undefined,
    ...over,
  };
  const service = createOnboardingService(deps);
  const matchDeps = (): MatchPipelineDeps => ({
    repo: mem.repo,
    brand: { id: 'roboapply', market: 'intl' },
    applyAnswers: async () => ({ id: 'sp1', version: 1 }),
    ingest: async () => ({}),
    preScore: async () => [preScoreFixture('j1', 82, 'great')],
    aiAllowed: async () => false,
    enqueue: async () => undefined,
  });
  h = await startRouteHarness({
    mounts: [
      [
        '/onboarding',
        createOnboardingRouter({
          seekerAuth: [fakeAuth(() => (userId ? { id: userId } : null))],
          service,
          matchDeps,
          ...(routerOpts.rateLimitDb ? { rateLimitDb: routerOpts.rateLimitDb } : { withoutRateLimit: true }),
        }),
      ],
    ],
  });
}

const call = <T = Record<string, unknown>>(method: string, path: string, body?: unknown, host = RA) =>
  h!.request<Body<T>>(method, `/onboarding${path}`, { host, body: method === 'GET' ? undefined : body });

beforeEach(() => {
  userId = 'u1';
});
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('auth', () => {
  beforeEach(() => start());
  it.each([
    ['GET', '/state'],
    ['PUT', '/steps/situation'],
    ['GET', '/title-suggest?q=engineer'],
    ['GET', '/market-snapshot?taxonomyId=backend_engineer&country=US'],
    ['POST', '/resume'],
    ['POST', '/match'],
    ['POST', '/confirm'],
    ['POST', '/complete'],
    ['POST', '/skip'],
  ])('%s %s → 401 without a session', async (method, path) => {
    userId = null;
    expect((await call(method, path, {})).status).toBe(401);
  });
});

describe('the flow over HTTP', () => {
  beforeEach(() => start());

  it('state → situation → basics, with the next route each time', async () => {
    const s = await call('GET', '/state');
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ stage: 'situation', nextRoute: '/onboarding/situation', brand: 'roboapply' });
    const a = await call('PUT', '/steps/situation', { timing: 'asap', seekerType: 'experienced' });
    expect(a.body.data).toEqual({ stage: 'basics', nextStage: 'basics', nextRoute: '/onboarding/basics' });
    const b = await call('PUT', '/steps/basics', SAMPLE_BASICS);
    expect(b.body.data).toMatchObject({ nextRoute: '/onboarding/resume' });
  });

  it('rejects an unknown step code (422), a bad body (422) and jumping ahead (409)', async () => {
    expect((await call('PUT', '/steps/warp', {})).status).toBe(422);
    const bad = await call('PUT', '/steps/situation', { timing: 'soon' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_request');
    const ahead = await call('PUT', '/steps/confirm', { experienceLevels: ['mid'] });
    expect(ahead.status).toBe(409);
    expect(ahead.body.details).toEqual({ reason: 'onboarding_step_not_available' });
  });

  it('GoApply steps answer 501 until WP-31 fills the validator', async () => {
    const res = await call('PUT', '/steps/consent', { agreement: true }, GO);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('not_implemented');
  });

  it('title suggest flags a broad title and offers more specific ones', async () => {
    const res = await call<{ items: Array<{ taxonomyId: string; tooGeneral: boolean; children: unknown[] }> }>('GET', '/title-suggest?q=software%20engineering');
    expect(res.status).toBe(200);
    const broad = res.body.data.items.find((i) => i.taxonomyId === 'software_engineering');
    expect(broad).toMatchObject({ tooGeneral: true });
    expect(broad!.children.length).toBeGreaterThan(0);
    expect((await call('GET', '/title-suggest?q=a')).status).toBe(422);
  });

  it('market snapshot validates its query and returns Sourced numbers', async () => {
    expect((await call('GET', '/market-snapshot?taxonomyId=backend_engineer&country=usa')).status).toBe(422);
    const res = await call('GET', '/market-snapshot?taxonomyId=backend_engineer&country=US');
    expect(res.body.data).toMatchObject({ jobCount: { value: 3, source: 'index' }, pay: null });
  });

  it('resume seed returns suggestions', async () => {
    mem.addResume('u1', { id: 'rv1', parsedData: { skills: ['Go'] }, resumeMarkdown: 'x' });
    const res = await call('POST', '/resume', { resumeVariantId: 'rv1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ suggestedTaxonomyIds: ['backend_engineer'], suggestedSkills: ['Go'], suggestedSeniority: ['mid'] });
    expect((await call('POST', '/resume', { resumeVariantId: 'nope' })).status).toBe(404);
  });

  it('match streams the five phases then done, and moves the stage to confirm', async () => {
    mem.rows.get('u1')!.step = 'matching';
    mem.rows.get('u1')!.path = 'urgent';
    mem.rows.get('u1')!.answers = { basics: { ...SAMPLE_BASICS } };
    mem.setCandidates(['j1']);
    const res = await h!.request('POST', '/onboarding/match', { host: RA, body: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = res.text
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => b.split('\n')[0].replace('event: ', '') + ':' + JSON.parse(b.split('\n')[1].replace('data: ', '')).phase);
    expect(events).toEqual(['phase:reading', 'phase:saving', 'phase:searching', 'phase:comparing', 'phase:ranking', 'done:undefined']);
    expect(res.text).toContain('"jobCount":1');
    expect(mem.rows.get('u1')!.step).toBe('confirm');
  });

  it('match reports an error event instead of a fake success', async () => {
    mem.rows.get('u1')!.step = 'matching';
    mem.setCandidates(['j1']);
    const repo = mem.repo;
    repo.findCandidates = async () => {
      throw new Error('db down');
    };
    const res = await h!.request('POST', '/onboarding/match', { host: RA, body: {} });
    expect(res.text).toContain('event: error');
    expect(res.text).not.toContain('event: done');
    expect(mem.rows.get('u1')!.step).toBe('matching');
  });

  it('confirm → tour; complete → done; skip leaves early', async () => {
    mem.rows.get('u1')!.step = 'confirm';
    mem.rows.get('u1')!.path = 'urgent';
    const c = await call('POST', '/confirm', { experienceLevels: ['mid'], alertFrequency: 'daily' });
    expect(c.body.data).toEqual({ stage: 'tour', nextRoute: '/jobs' });
    expect((await call('POST', '/complete')).body.data).toEqual({ stage: 'done', nextRoute: '/jobs' });
    mem.rows.get('u1')!.step = 'basics';
    mem.rows.get('u1')!.completedAt = null;
    expect((await call('POST', '/skip')).body.data).toEqual({ stage: 'done', nextRoute: '/jobs' });
    expect((await call('GET', '/state')).body.data).toMatchObject({ progress: { leftEarly: { stage: 'basics' } } });
  });

  it('confirm validates the LinkedIn URL', async () => {
    mem.rows.get('u1')!.step = 'confirm';
    const res = await call('POST', '/confirm', { experienceLevels: ['mid'], linkedinUrl: 'https://example.com/me' });
    expect(res.status).toBe(422);
  });
});

describe('daily resume limit over HTTP', () => {
  it('answers 429 with Retry-After', async () => {
    await start({ consumeResumeQuota: async () => ({ allowed: false, retryAfterSec: 120 }) });
    mem.addResume('u1', { id: 'rv1', parsedData: null, resumeMarkdown: 'x' });
    const res = await call('POST', '/resume', { resumeVariantId: 'rv1' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
  });
});

/** In-memory RARateCounter: counts hits per key and window (no database). */
function memoryRateLimitDb(): RateLimitDb {
  const counts = new Map<string, number>();
  const $queryRaw = (_strings: TemplateStringsArray, key: string, windowStart: Date, cost: number) => {
    const k = `${key}|${windowStart.toISOString()}`;
    counts.set(k, (counts.get(k) ?? 0) + cost);
    return Promise.resolve([{ count: counts.get(k)! }]);
  };
  return { $queryRaw, rARateCounter: {} } as unknown as RateLimitDb;
}

describe('POST /match is gated', () => {
  it('answers 409 before the resume step and after setup, without running anything', async () => {
    await start();
    mem.rows.get('u1')!.step = 'basics';
    mem.setCandidates(['j1']);
    const early = await call('POST', '/match', {});
    expect(early.status).toBe(409);
    expect(early.body.details).toEqual({ reason: 'onboarding_match_not_available' });
    mem.rows.get('u1')!.step = 'done';
    mem.rows.get('u1')!.completedAt = new Date('2026-10-01T00:00:00Z');
    expect((await call('POST', '/match', {})).status).toBe(409);
    expect(mem.candidateQueries).toHaveLength(0);
  });

  it('allows a deliberate re-run from O7 (stage confirm)', async () => {
    await start();
    mem.rows.get('u1')!.step = 'confirm';
    mem.rows.get('u1')!.path = 'urgent';
    mem.setCandidates(['j1']);
    const res = await h!.request('POST', '/onboarding/match', { host: RA, body: {} });
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: done');
  });

  it('is limited to 5 runs per hour per user (persisted counter)', async () => {
    await start({}, { rateLimitDb: memoryRateLimitDb() });
    mem.rows.get('u1')!.step = 'matching';
    mem.rows.get('u1')!.path = 'urgent';
    mem.setCandidates(['j1']);
    for (let i = 0; i < 5; i++) {
      const ok = await h!.request('POST', '/onboarding/match', { host: RA, body: {} });
      expect(ok.status).toBe(200);
    }
    const sixth = await call('POST', '/match', {});
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('rate_limited');
  });
});
