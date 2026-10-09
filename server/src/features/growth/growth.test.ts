// @vitest-environment node
//
// WP-23: first-party events, attribution and the getting-started checklist.
// No database and no network: Prisma is the in-memory fake, the rate limiter
// and the practice-credit grant are injected.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import type { RateLimitResult } from '../../platform/ratelimit/index.js';
import type { PracticeGrantResult } from '../../platform/credits/index.js';
import {
  CHECKLIST_REWARD_KEY,
  EventsBatchBodySchema,
  PRODUCT_EVENT_NAMES,
  analyticsIdentity,
  createEventsPublicRouter,
  createGrowthRouter,
  createGrowthService,
  isAnalyticsConsentRequired,
  sanitizeEventProps,
  touchFromQuery,
  touchesFromClient,
  type ChecklistStore,
  type GrowthDb,
  type IngestContext,
} from './index.js';
import { createDelegateChecklistStore, resolvePrismaChecklistStore, type ChecklistDelegate } from './checklistStore.js';
import { eventTime, sanitizeEventPath } from './events.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const AT = '2026-10-10T11:59:00.000Z';

function allowAll(): RateLimitResult {
  return { allowed: true, retryAfterSec: 0, remaining: 100, windows: [] };
}

function fakeDb(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  return createFakePrisma({ seed, uniqueFields: { rAAttribution: ['userId'], rAGrowthChecklist: ['userId'] } });
}

function memoryChecklistStore(fake = fakeDb()): ChecklistStore {
  return createDelegateChecklistStore(fake.rAGrowthChecklist as unknown as ChecklistDelegate);
}

const intlEU: IngestContext = { brand: 'roboapply', market: 'intl', userId: 'u1', country: 'DE', consent: null, ip: '1.2.3.4' };

// ── Registry ─────────────────────────────────────────────────────────────

describe('event registry', () => {
  it('covers the PRODUCT/ARCH funnel events and has no server-only completion events', () => {
    for (const name of ['onboarding_step_viewed', 'onboarding_step_completed', 'onboarding_abandoned', 'feed_rating_submitted', 'job_saved', 'tailor_finalized', 'practice_completed', 'upgrade_viewed']) {
      expect(PRODUCT_EVENT_NAMES).toContain(name);
    }
    expect(PRODUCT_EVENT_NAMES).not.toContain('checklist_step_completed');
    for (const name of PRODUCT_EVENT_NAMES) expect(name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
  });

  it('keeps only registry prop keys and drops contact details', () => {
    expect(
      sanitizeEventProps('feed_rating_submitted', { rating: 6, reasons: 'wrong_level,jobs_old', email: 'a@b.co', note: 'free text' }),
    ).toEqual({ rating: 6, reasons: 'wrong_level,jobs_old' });
    expect(sanitizeEventProps('job_saved', { jobId: '4012345678', from: 'call me +1 415 555 0100' })).toEqual({ jobId: '4012345678' });
    expect(sanitizeEventProps('job_saved', { from: 'someone@example.com' })).toBeNull();
    expect(sanitizeEventProps('job_opened', { position: Number.NaN, jobId: 'x'.repeat(300) })).toEqual({ jobId: 'x'.repeat(200) });
  });

  it('strips query strings from paths and clamps implausible times', () => {
    expect(sanitizeEventPath('/jobs?token=secret&email=a@b.co#x')).toBe('/jobs');
    expect(sanitizeEventPath('https://evil.test/')).toBeNull();
    expect(sanitizeEventPath('/reset-password/abc123')).toBe('/reset-password/:token');
    expect(sanitizeEventPath('/verify-email/tok_9?next=/jobs')).toBe('/verify-email/:token');
    expect(sanitizeEventPath('/unsubscribe/u_tok/confirm')).toBe('/unsubscribe/:token');
    expect(sanitizeEventPath('/alerts/confirm/abc')).toBe('/alerts/confirm/:token');
    expect(sanitizeEventPath('/de/reset-password/abc')).toBe('/de/reset-password/:token');
    expect(sanitizeEventPath('/auth/callback')).toBe('/auth/callback');
    expect(sanitizeEventPath('/alerts')).toBe('/alerts');
    expect(sanitizeEventPath('/jobs/cm1')).toBe('/jobs/cm1');
    expect(eventTime(AT, NOW).toISOString()).toBe(AT);
    expect(eventTime('2020-01-01T00:00:00.000Z', NOW)).toEqual(NOW);
    expect(eventTime('2027-01-01T00:00:00.000Z', NOW)).toEqual(NOW);
  });

  it('asks for consent on RoboApply in the EEA, UK, CH and when the country is unknown; never on GoApply', () => {
    expect(isAnalyticsConsentRequired('intl', 'DE')).toBe(true);
    expect(isAnalyticsConsentRequired('intl', 'gb')).toBe(true);
    expect(isAnalyticsConsentRequired('intl', 'CH')).toBe(true);
    expect(isAnalyticsConsentRequired('intl', 'NO')).toBe(true);
    expect(isAnalyticsConsentRequired('intl', null)).toBe(true);
    expect(isAnalyticsConsentRequired('intl', 'US')).toBe(false);
    expect(isAnalyticsConsentRequired('intl', 'TW')).toBe(false);
    expect(isAnalyticsConsentRequired('cn', 'DE')).toBe(false);
  });

  it('caps a batch at 50 events', () => {
    const ev = { name: 'page_viewed', at: AT };
    expect(EventsBatchBodySchema.safeParse({ events: Array(50).fill(ev) }).success).toBe(true);
    expect(EventsBatchBodySchema.safeParse({ events: Array(51).fill(ev) }).success).toBe(false);
    expect(EventsBatchBodySchema.safeParse({ events: [] }).success).toBe(false);
  });
});

// ── Ingest ───────────────────────────────────────────────────────────────

describe('ingestEvents', () => {
  function setup(consume = vi.fn(async () => allowAll())) {
    const fake = fakeDb();
    const service = createGrowthService({ db: fake as unknown as GrowthDb, consumeRateLimit: consume, now: () => NOW, checklistStore: null });
    return { fake, service, consume };
  }

  it('stores registry events and counts unknown names as rejected', async () => {
    const { fake, service } = setup();
    const res = await service.ingestEvents(
      { anonId: 'anon_12345678', events: [{ name: 'job_saved', props: { jobId: 'j1', bogus: 1 }, path: '/jobs?x=1', at: AT }, { name: 'made_up_event', at: AT }] },
      { ...intlEU, country: 'US' },
    );
    expect(res).toEqual({ accepted: 1, rejected: 1 });
    const rows = await fake.rAProductEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brand: 'roboapply', name: 'job_saved', userId: 'u1', anonId: 'anon_12345678', path: '/jobs', props: { jobId: 'j1' } });
    expect((rows[0] as { createdAt: Date }).createdAt.toISOString()).toBe(AT);
  });

  it('never stores the secret segment of a token route (reset, verify, unsubscribe, alert confirm)', async () => {
    const { fake, service } = setup();
    await service.ingestEvents(
      {
        anonId: 'anon_12345678',
        events: [
          { name: 'page_viewed', path: '/reset-password/abc123', at: AT },
          { name: 'page_viewed', path: '/unsubscribe/live_tok?x=1', at: AT },
          { name: 'page_viewed', path: '/alerts/confirm/c0nf1rm', at: AT },
        ],
      },
      { ...intlEU, country: 'US' },
    );
    const rows = (await fake.rAProductEvent.findMany({})) as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).toEqual(['/reset-password/:token', '/unsubscribe/:token', '/alerts/confirm/:token']);
    expect(JSON.stringify(rows)).not.toMatch(/abc123|live_tok|c0nf1rm/);
  });

  it('EEA visitor without consent: no anonId and no account link (session-only)', async () => {
    const { fake, service } = setup();
    await service.ingestEvents({ anonId: 'anon_12345678', sessionId: 'sess_abcdefgh', events: [{ name: 'page_viewed', at: AT }] }, intlEU);
    const [row] = (await fake.rAProductEvent.findMany({})) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ userId: null, anonId: null, props: { sessionId: 'sess_abcdefgh' } });
  });

  it('EEA visitor who rejected stays unlinked; one who accepted is linked', async () => {
    const { fake, service } = setup();
    await service.ingestEvents({ anonId: 'anon_12345678', events: [{ name: 'page_viewed', at: AT }] }, { ...intlEU, consent: 'denied' });
    await service.ingestEvents({ anonId: 'anon_12345678', events: [{ name: 'page_viewed', at: AT }] }, { ...intlEU, consent: 'granted' });
    const rows = (await fake.rAProductEvent.findMany({})) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.userId, r.anonId])).toEqual([
      [null, null],
      ['u1', 'anon_12345678'],
    ]);
  });

  it('GoApply links without the banner (collection is in the personal-information list)', async () => {
    const { fake, service } = setup();
    await service.ingestEvents({ anonId: 'anon_12345678', events: [{ name: 'page_viewed', at: AT }] }, { ...intlEU, brand: 'goapply', market: 'cn', country: 'CN' });
    const [row] = (await fake.rAProductEvent.findMany({})) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ brand: 'goapply', userId: 'u1', anonId: 'anon_12345678' });
  });

  it('rate limits by anonId (cost = events) plus a per-IP ceiling, or by IP alone, and answers 429 when over', async () => {
    const consume = vi.fn(async (_o: { key: string; windows: readonly unknown[]; cost: number }) => allowAll());
    const { service } = setup(consume);
    await service.ingestEvents({ anonId: 'anon_12345678', events: [{ name: 'page_viewed', at: AT }, { name: 'page_viewed', at: AT }] }, { ...intlEU, country: 'US' });
    expect(consume).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: expect.stringMatching(/^rl:roboapply:eventsPerAnon:id:/), cost: 2, windows: [{ limit: 120, windowSec: 60 }] }));
    expect(consume).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: expect.stringMatching(/^rl:roboapply:eventsPerIp:ip:/), cost: 2, windows: [{ limit: 600, windowSec: 60 }] }));
    await service.ingestEvents({ events: [{ name: 'page_viewed', at: AT }] }, intlEU);
    expect(consume).toHaveBeenLastCalledWith(expect.objectContaining({ key: expect.stringMatching(/^rl:roboapply:eventsPerAnon:ip:/), cost: 1 }));

    const blocked = setup(vi.fn(async () => ({ allowed: false, retryAfterSec: 30, remaining: 0, windows: [] })));
    await expect(blocked.service.ingestEvents({ events: [{ name: 'page_viewed', at: AT }] }, intlEU)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(await blocked.fake.rAProductEvent.count({})).toBe(0);
  });

  it('rotating anonIds from one IP is still limited by the per-IP ceiling', async () => {
    // A counter that behaves like the real fixed window: one count per key.
    const counts = new Map<string, number>();
    const consume = vi.fn(async (o: { key: string; windows: readonly { limit: number; windowSec: number }[]; cost: number }) => {
      const n = (counts.get(o.key) ?? 0) + o.cost;
      counts.set(o.key, n);
      const allowed = o.windows.every((w) => n <= w.limit);
      return { allowed, retryAfterSec: allowed ? 0 : 60, remaining: 0, windows: [] } as RateLimitResult;
    });
    const { fake, service } = setup(consume);
    const batch = Array.from({ length: 50 }, () => ({ name: 'page_viewed', at: AT }));
    const us = { ...intlEU, country: 'US' };
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 20; i += 1) {
      const anonId = `anon_rotate_${String(i).padStart(4, '0')}`;
      try {
        accepted += (await service.ingestEvents({ anonId, events: batch }, us)).accepted;
      } catch (err) {
        expect(err).toMatchObject({ code: 'rate_limited', status: 429 });
        limited += 1;
      }
    }
    expect(accepted).toBe(600);
    expect(limited).toBe(8);
    expect(await fake.rAProductEvent.count({})).toBe(600);
    // A different IP is not affected.
    await expect(service.ingestEvents({ anonId: 'anon_other_ip01', events: batch }, { ...us, ip: '5.6.7.8' })).resolves.toMatchObject({ accepted: 50 });
  });

  it('fails open when the limiter itself errors', async () => {
    const { fake, service } = setup(vi.fn(async () => Promise.reject(new Error('db down'))));
    await expect(service.ingestEvents({ events: [{ name: 'page_viewed', at: AT }] }, intlEU)).resolves.toEqual({ accepted: 1, rejected: 0 });
    expect(await fake.rAProductEvent.count({})).toBe(1);
  });
});

// ── Attribution ──────────────────────────────────────────────────────────

describe('attribution', () => {
  it('builds a touch from the entry query (from, job, action, ref, invite, utm_*, alert)', () => {
    const q = new URLSearchParams('from=alert&job=cm1&action=apply&ref=ABCD2345&invite=INV1&utm_source=newsletter&utm_medium=email&utm_campaign=oct&alert=tok_1&other=x');
    expect(touchFromQuery(q, { landingPath: '/signup?from=alert', now: NOW })).toEqual({
      from: 'alert',
      jobId: 'cm1',
      action: 'apply',
      ref: 'ABCD2345',
      inviteCode: 'INV1',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'oct',
      alert: 'tok_1',
      landingPath: '/signup',
      at: NOW.toISOString(),
    });
    expect(touchFromQuery({}, { now: NOW })).toBeNull();
    expect(touchFromQuery({ utm_source: ['a', 'b'], from: 'x'.repeat(200) }, { now: NOW })).toMatchObject({ utmSource: 'a', from: 'x'.repeat(80) });
  });

  it('reads the anonId cookie only where linking is allowed', () => {
    const cookies = { ra_anon: 'anon_12345678' };
    expect(analyticsIdentity({ headers: { 'x-vercel-ip-country': 'FR' }, cookies }, 'intl')).toMatchObject({ country: 'FR', linkAllowed: false, anonId: null });
    expect(analyticsIdentity({ headers: { 'x-vercel-ip-country': 'FR' }, cookies: { ...cookies, ra_analytics_consent: 'granted' } }, 'intl')).toMatchObject({ linkAllowed: true, anonId: 'anon_12345678' });
    expect(analyticsIdentity({ headers: { 'x-vercel-ip-country': 'US' }, cookies }, 'intl').anonId).toBe('anon_12345678');
    expect(analyticsIdentity({ headers: { 'x-vercel-ip-country': 'US' }, cookies: { ra_anon: 'bad id!' } }, 'intl').anonId).toBeNull();
  });

  it('captures firstTouch once at signup, never overwrites it, and links earlier anonId events', async () => {
    const fake = fakeDb({
      rAProductEvent: [
        { id: 'e1', brand: 'roboapply', userId: null, anonId: 'anon_12345678', name: 'page_viewed', createdAt: NOW },
        { id: 'e2', brand: 'roboapply', userId: null, anonId: 'anon_other000', name: 'page_viewed', createdAt: NOW },
      ],
    });
    const service = createGrowthService({ db: fake as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    await service.recordAttribution('u1', { from: 'alert', utmSource: 'mail', at: NOW.toISOString() }, { anonId: 'anon_12345678', linkAllowed: true });
    await service.recordAttribution('u1', { from: 'later', at: NOW.toISOString() }, { anonId: 'anon_12345678', linkAllowed: true });
    const row = (await fake.rAAttribution.findUnique({ where: { userId: 'u1' } })) as Record<string, unknown>;
    expect(row).toMatchObject({ anonId: 'anon_12345678', firstTouch: { from: 'alert', utmSource: 'mail' } });
    expect(row.lastTouch ?? null).toBeNull();
    const events = (await fake.rAProductEvent.findMany({ orderBy: { id: 'asc' } })) as Array<Record<string, unknown>>;
    expect(events.map((e) => e.userId)).toEqual(['u1', null]);
  });

  it('later visits move lastTouch only, and only for users who have a signup row', async () => {
    const fake = fakeDb();
    const service = createGrowthService({ db: fake as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    await service.recordAttribution('u2', { from: 'alert', at: NOW.toISOString() }, { lastTouchOnly: true, linkAllowed: true });
    expect(await fake.rAAttribution.count({})).toBe(0);
    await service.recordAttribution('u2', { from: 'seo', at: NOW.toISOString() }, { linkAllowed: true });
    await service.recordAttribution('u2', { from: 'alert', alert: 'tok', at: NOW.toISOString() }, { lastTouchOnly: true, linkAllowed: true });
    const row = (await fake.rAAttribution.findUnique({ where: { userId: 'u2' } })) as Record<string, unknown>;
    expect(row).toMatchObject({ firstTouch: { from: 'seo' }, lastTouch: { from: 'alert', alert: 'tok' } });
  });

  it("round trip: the client's getAttribution() shape → touchesFromClient → recordAttribution keeps every field", async () => {
    // Exactly what lib/analytics.ts getAttribution() returns (Touch field names).
    const client = {
      firstTouch: { from: 'alert', utmSource: 'mail', utmCampaign: 'oct', jobId: 'cm1', action: 'apply', inviteCode: 'INV1', ref: 'ABCD2345', alert: 'a1', landingPath: '/jobs/cm1', at: AT },
      lastTouch: { from: 'seo', utmSource: 'google', jobId: 'cm2', at: AT },
    };
    const { firstTouch, lastTouch } = touchesFromClient(JSON.parse(JSON.stringify(client)), NOW);
    expect(firstTouch).toEqual(client.firstTouch);
    expect(lastTouch).toEqual(client.lastTouch);

    const fake = fakeDb();
    const service = createGrowthService({ db: fake as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    const opts = { anonId: 'anon_12345678', linkAllowed: true };
    await service.recordAttribution('u5', firstTouch ?? touchFromQuery({}, { now: NOW })!, opts);
    await service.recordAttribution('u5', lastTouch!, { ...opts, lastTouchOnly: true });
    const row = (await fake.rAAttribution.findUnique({ where: { userId: 'u5' } })) as Record<string, unknown>;
    expect(row).toMatchObject({
      anonId: 'anon_12345678',
      firstTouch: { utmSource: 'mail', jobId: 'cm1', inviteCode: 'INV1', from: 'alert', ref: 'ABCD2345' },
      lastTouch: { utmSource: 'google', jobId: 'cm2', from: 'seo' },
    });
  });

  it('touchesFromClient ignores a bare query object, junk keys and non-objects; redacts token landing paths', () => {
    expect(touchesFromClient({ from: 'alert', utm_source: 'x' }, NOW)).toEqual({ firstTouch: null, lastTouch: null });
    expect(touchesFromClient(null, NOW)).toEqual({ firstTouch: null, lastTouch: null });
    expect(touchesFromClient('x', NOW)).toEqual({ firstTouch: null, lastTouch: null });
    const { firstTouch } = touchesFromClient({ firstTouch: { utmSource: 'm', evil: 'x', landingPath: '/reset-password/abc?y=1', at: AT } }, NOW);
    expect(firstTouch).toEqual({ utmSource: 'm', landingPath: '/reset-password/:token', at: AT });
    expect(touchFromQuery({ from: 'x' }, { landingPath: '/verify-email/tok', now: NOW })).toMatchObject({ landingPath: '/verify-email/:token' });
  });

  it('without linkAllowed (e.g. an EEA visitor who said no) only the functional fields are stored and no anonId is linked', async () => {
    const fake = fakeDb({
      rAProductEvent: [{ id: 'e1', brand: 'roboapply', userId: null, anonId: 'anon_12345678', name: 'page_viewed', createdAt: NOW }],
    });
    const service = createGrowthService({ db: fake as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    const touch = { from: 'alert', utmSource: 'newsletter', alert: 'a1', landingPath: '/jobs', inviteCode: 'INV1', jobId: 'cm1', at: AT };
    await service.recordAttribution('u6', touch, { anonId: 'anon_12345678', linkAllowed: false });
    const row = (await fake.rAAttribution.findUnique({ where: { userId: 'u6' } })) as Record<string, unknown>;
    expect(row).toMatchObject({ anonId: null, firstTouch: { inviteCode: 'INV1', jobId: 'cm1', at: AT } });
    expect(row.firstTouch).not.toHaveProperty('utmSource');
    expect(row.firstTouch).not.toHaveProperty('from');
    expect(row.firstTouch).not.toHaveProperty('alert');
    expect(row.firstTouch).not.toHaveProperty('landingPath');
    expect(((await fake.rAProductEvent.findMany({})) as Array<{ userId: unknown }>)[0]!.userId).toBeNull();

    // Default (option omitted) behaves the same; a marketing-only touch stores nothing.
    await service.recordAttribution('u7', { utmSource: 'newsletter', from: 'ad', at: AT });
    expect(await fake.rAAttribution.findUnique({ where: { userId: 'u7' } })).toBeNull();
  });

  it('a concurrent signup write (unique violation) is not an error', async () => {
    const fake = fakeDb({ rAAttribution: [{ userId: 'u3', anonId: null, firstTouch: { from: 'a', at: AT } }] });
    const db = { ...fake, rAAttribution: { ...fake.rAAttribution, findUnique: async () => null } };
    const service = createGrowthService({ db: db as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    await expect(service.recordAttribution('u3', { from: 'b', at: AT }, { linkAllowed: true })).resolves.toBeUndefined();
    expect(await fake.rAAttribution.count({})).toBe(1);
  });
});

// ── Delete + retention ───────────────────────────────────────────────────

describe('deleteEventsForUser / pruneProductEvents', () => {
  it('removes rows by userId and by every linked anonId, and nothing else', async () => {
    const fake = fakeDb({
      rAAttribution: [{ userId: 'u1', anonId: 'anon_signup01', firstTouch: { at: AT } }],
      rAProductEvent: [
        { id: 'e1', brand: 'roboapply', userId: 'u1', anonId: null, name: 'job_saved', createdAt: NOW },
        { id: 'e2', brand: 'roboapply', userId: null, anonId: 'anon_signup01', name: 'page_viewed', createdAt: NOW },
        { id: 'e3', brand: 'roboapply', userId: 'u1', anonId: 'anon_device02', name: 'page_viewed', createdAt: NOW },
        { id: 'e4', brand: 'roboapply', userId: null, anonId: 'anon_device02', name: 'page_viewed', createdAt: NOW },
        { id: 'e5', brand: 'roboapply', userId: 'u9', anonId: 'anon_someone9', name: 'page_viewed', createdAt: NOW },
        // Shared browser: another account's signed-in row on the same anonId survives.
        { id: 'e6', brand: 'roboapply', userId: 'u9', anonId: 'anon_signup01', name: 'job_saved', createdAt: NOW },
      ],
    });
    const service = createGrowthService({ db: fake as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    expect(await service.deleteEventsForUser('u1')).toEqual({ deleted: 4 });
    expect(((await fake.rAProductEvent.findMany({ orderBy: { id: 'asc' } })) as Array<{ id: string }>).map((r) => r.id)).toEqual(['e5', 'e6']);
  });

  it('prunes events older than the ≈13-month retention', async () => {
    const old = new Date(NOW.getTime() - 400 * 86_400_000);
    const recent = new Date(NOW.getTime() - 30 * 86_400_000);
    const fake = fakeDb({
      rAProductEvent: [
        { id: 'old', brand: 'roboapply', name: 'page_viewed', createdAt: old },
        { id: 'new', brand: 'roboapply', name: 'page_viewed', createdAt: recent },
      ],
    });
    const service = createGrowthService({ db: fake as unknown as GrowthDb, now: () => NOW, checklistStore: null });
    expect(await service.pruneProductEvents()).toEqual({ deleted: 1 });
  });
});

// ── Checklist ────────────────────────────────────────────────────────────

describe('getting-started checklist', () => {
  function setup(grantResults: PracticeGrantResult['status'][] = ['granted']) {
    const store = memoryChecklistStore();
    const statuses = [...grantResults];
    const grantPracticeCredit = vi.fn(async (): Promise<PracticeGrantResult> => ({ status: statuses.shift() ?? 'already_granted', ledgerId: 'l1', balanceAfter: 2 }));
    const service = createGrowthService({ db: fakeDb() as unknown as GrowthDb, checklistStore: store, grantPracticeCredit, now: () => NOW });
    return { store, service, grantPracticeCredit };
  }

  it('completes steps idempotently and grants 1 practice credit once, after the third step', async () => {
    const { service, grantPracticeCredit } = setup();
    expect((await service.markChecklistStep('u1', 'tailor')).steps).toEqual({ tailor: true, practice: false, save_job: false });
    await service.markChecklistStep('u1', 'tailor');
    await service.markChecklistStep('u1', 'save_job');
    expect(grantPracticeCredit).not.toHaveBeenCalled();
    const done = await service.markChecklistStep('u1', 'practice');
    expect(done).toEqual({ steps: { tailor: true, practice: true, save_job: true }, rewarded: true, dismissed: false });
    expect(grantPracticeCredit).toHaveBeenCalledTimes(1);
    expect(grantPracticeCredit).toHaveBeenCalledWith('u1', 'checklist_complete', CHECKLIST_REWARD_KEY);
    await service.markChecklistStep('u1', 'save_job');
    await service.markChecklistStep('u1', 'practice');
    expect(grantPracticeCredit).toHaveBeenCalledTimes(1);
  });

  it('keeps the first completion time', async () => {
    const { store, service } = setup();
    await service.markChecklistStep('u1', 'save_job');
    const first = (await store.get('u1'))!.saveJobAt;
    const later = createGrowthService({ db: fakeDb() as unknown as GrowthDb, checklistStore: store, now: () => new Date(NOW.getTime() + 60_000) });
    await later.markChecklistStep('u1', 'save_job');
    expect((await store.get('u1'))!.saveJobAt).toEqual(first);
  });

  it('a failed grant is retried by the next markChecklistStep call; reading the card never grants', async () => {
    const { service, grantPracticeCredit } = setup(['failed', 'granted']);
    await service.markChecklistStep('u1', 'tailor');
    await service.markChecklistStep('u1', 'practice');
    expect((await service.markChecklistStep('u1', 'save_job')).rewarded).toBe(false);
    expect((await service.getChecklist('u1')).rewarded).toBe(false);
    expect(grantPracticeCredit).toHaveBeenCalledTimes(1);
    expect((await service.markChecklistStep('u1', 'save_job')).rewarded).toBe(true);
    expect(grantPracticeCredit).toHaveBeenCalledTimes(2);
  });

  it('an already-granted ledger row counts as rewarded (idempotent across retries)', async () => {
    const { service } = setup(['already_granted']);
    for (const step of ['tailor', 'practice', 'save_job'] as const) await service.markChecklistStep('u1', step);
    expect((await service.getChecklist('u1')).rewarded).toBe(true);
  });

  it('dismisses, reports the reward from the catalog constant, and rejects unknown steps', async () => {
    const { service } = setup();
    expect(await service.getChecklist('u1')).toEqual({
      steps: { tailor: false, practice: false, save_job: false },
      rewarded: false,
      dismissed: false,
      reward: { bucket: 'practice', credits: 1 },
    });
    expect((await service.dismissChecklist('u1')).dismissed).toBe(true);
    await expect(service.markChecklistStep('u1', 'apply' as never)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('without the checklist table (SR-23-1 pending): markChecklistStep is a no-op, the card is feature_disabled', async () => {
    const grantPracticeCredit = vi.fn();
    const service = createGrowthService({ db: fakeDb() as unknown as GrowthDb, checklistStore: null, grantPracticeCredit });
    expect(await service.markChecklistStep('u1', 'tailor')).toEqual({ steps: { tailor: false, practice: false, save_job: false }, rewarded: false, dismissed: false });
    await expect(service.getChecklist('u1')).rejects.toMatchObject({ code: 'feature_disabled', status: 404 });
    expect(grantPracticeCredit).not.toHaveBeenCalled();
  });

  it('resolves the Prisma store only when the generated client has the model', () => {
    expect(resolvePrismaChecklistStore({})).toBeNull();
    expect(resolvePrismaChecklistStore(null)).toBeNull();
    expect(resolvePrismaChecklistStore({ rAGrowthChecklist: fakeDb().rAGrowthChecklist })).not.toBeNull();
  });

  it.todo('SR-23-1: markChecklistStep against the real RAGrowthChecklist table (after SCHEMA-2 generates the model)');
});

// ── Routes ───────────────────────────────────────────────────────────────

describe('routes', () => {
  let h: RouteHarness;
  const fake = fakeDb();
  const store = memoryChecklistStore();
  const service = createGrowthService({
    db: fake as unknown as GrowthDb,
    checklistStore: store,
    consumeRateLimit: async () => allowAll(),
    grantPracticeCredit: async () => ({ status: 'granted', ledgerId: 'l', balanceAfter: 1 }),
    now: () => NOW,
  });
  const offService = createGrowthService({ db: fake as unknown as GrowthDb, checklistStore: null });
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

  beforeAll(async () => {
    h = await startRouteHarness({
      env: { NODE_ENV: 'development' },
      mounts: [
        ['/api/v1/public/events', createEventsPublicRouter({ optionalAuth: [passThrough as never], service })],
        ['/api/v1/roboapply/growth', createGrowthRouter({ seekerAuth: [fakeAuth({ id: 'u1' })], service })],
        ['/off/growth', createGrowthRouter({ seekerAuth: [fakeAuth({ id: 'u1' })], service: offService })],
        ['/anon/growth', createGrowthRouter({ seekerAuth: [fakeAuth(null)], service })],
      ],
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('POST /events stores a batch per brand and validates the body', async () => {
    const ok = await h.request<{ success: boolean; data: unknown }>('POST', '/api/v1/public/events', {
      host: 'goapply.localhost:3621',
      body: { anonId: 'anon_12345678', events: [{ name: 'page_viewed', at: AT }, { name: 'nope_event', at: AT }] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, data: { accepted: 1, rejected: 1 } });
    expect(await fake.rAProductEvent.findFirst({ where: { brand: 'goapply' } })).toMatchObject({ anonId: 'anon_12345678' });

    const bad = await h.request<{ code: string }>('POST', '/api/v1/public/events', { host: 'localhost:3621', body: { events: [] } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_request');
  });

  it('POST /events honours the consent cookie for an EEA visitor on RoboApply', async () => {
    const send = (cookies: Record<string, string>) =>
      h.request('POST', '/api/v1/public/events', {
        host: 'localhost:3621',
        headers: { 'x-vercel-ip-country': 'NL' },
        cookies,
        body: { anonId: 'anon_nl000001', events: [{ name: 'job_opened', props: { jobId: 'j9' }, at: AT }] },
      });
    await send({});
    await send({ ra_analytics_consent: 'granted' });
    const rows = (await fake.rAProductEvent.findMany({ where: { name: 'job_opened' } })) as Array<{ anonId: string | null }>;
    expect(rows.map((r) => r.anonId)).toEqual([null, 'anon_nl000001']);
  });

  it('GET /checklist and POST /checklist/dismiss need a session and read server state', async () => {
    expect((await h.request('GET', '/anon/growth/checklist')).status).toBe(401);
    await service.markChecklistStep('u1', 'save_job');
    const res = await h.request<{ data: { steps: Record<string, boolean>; reward: unknown } }>('GET', '/api/v1/roboapply/growth/checklist', { host: 'localhost:3621' });
    expect(res.status).toBe(200);
    expect(res.body.data.steps).toEqual({ tailor: false, practice: false, save_job: true });
    expect(res.body.data.reward).toEqual({ bucket: 'practice', credits: 1 });
    const dismissed = await h.request<{ data: { dismissed: boolean } }>('POST', '/api/v1/roboapply/growth/checklist/dismiss', { host: 'localhost:3621' });
    expect(dismissed.body.data.dismissed).toBe(true);
  });

  it('there is no route that completes a step', async () => {
    const res = await h.request('POST', '/api/v1/roboapply/growth/checklist/steps/tailor', { host: 'localhost:3621' });
    expect(res.status).toBe(404);
    expect((await store.get('u1'))!.tailorAt ?? null).toBeNull();
  });

  it('answers 404 feature_disabled while the checklist table is missing', async () => {
    const res = await h.request<{ code: string }>('GET', '/off/growth/checklist', { host: 'localhost:3621' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });
});
