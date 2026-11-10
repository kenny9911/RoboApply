// @vitest-environment node
//
// Visitor conversion: the visitor record (visitors.ts) and how the events
// ingest feeds it. No database and no network: Prisma is the in-memory fake.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import type { RateLimitResult } from '../../platform/ratelimit/index.js';
import {
  SIGNUP_GRACE_MS,
  accountOutcome,
  classifyChannel,
  createGrowthService,
  createVisitorRecorder,
  deviceFromUserAgent,
  isAuthEntryPath,
  isBotUserAgent,
  normalizeHost,
  summarizeVisit,
  type GrowthDb,
  type IngestContext,
  type VisitEvent,
  type VisitorDb,
} from './index.js';
import { VISITOR_TABLE_RETRY_MS } from './visitors.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const at = (iso: string) => new Date(iso);
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const ANON = 'anon_1234567890';

function fakeDb(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  return createFakePrisma({ seed, defaults: { rAVisitor: { knownUser: false, userId: null, signedUpAt: null } } });
}

const page = (path: string, time: string, props: VisitEvent['props'] = null): VisitEvent => ({ name: 'page_viewed', path, at: at(time), props });

function recorder(fake = fakeDb(), now = () => NOW) {
  return { fake, rec: createVisitorRecorder({ db: fake as unknown as VisitorDb, now }) };
}

const base = { brand: 'roboapply', anonId: ANON, userId: null, country: 'US', userAgent: CHROME, visitId: 'visit_0001' };

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('visitor helpers', () => {
  it('leaves automated clients out and reduces a User-Agent to a device class', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0.0.0 Safari/537.36')).toBe(true);
    expect(isBotUserAgent('curl/8.7.1')).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
    expect(isBotUserAgent(CHROME)).toBe(false);
    expect(isBotUserAgent(IPHONE)).toBe(false);
    // A WeChat in-app browser is a person.
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 MicroMessenger/8.0.50')).toBe(false);

    expect(deviceFromUserAgent(CHROME)).toBe('desktop');
    expect(deviceFromUserAgent(IPHONE)).toBe('mobile');
    expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('mobile');
    expect(deviceFromUserAgent(null)).toBeNull();
  });

  it('normalizes a referring host', () => {
    expect(normalizeHost('WWW.Google.com')).toBe('google.com');
    expect(normalizeHost('news.ycombinator.com:443')).toBe('news.ycombinator.com');
    expect(normalizeHost('localhost')).toBeNull();
    expect(normalizeHost('not a host')).toBeNull();
    expect(normalizeHost(null)).toBeNull();
  });

  it('classifies the first touch: campaign labels win over the referrer', () => {
    expect(classifyChannel({})).toBe('direct');
    expect(classifyChannel({ referrerHost: 'www.google.com' })).toBe('search');
    expect(classifyChannel({ referrerHost: 'www.baidu.com' })).toBe('search');
    expect(classifyChannel({ referrerHost: 'gemini.google.com' })).toBe('ai');
    expect(classifyChannel({ referrerHost: 'chatgpt.com' })).toBe('ai');
    expect(classifyChannel({ referrerHost: 'www.perplexity.ai' })).toBe('ai');
    expect(classifyChannel({ referrerHost: 'www.linkedin.com' })).toBe('social');
    expect(classifyChannel({ referrerHost: 't.co' })).toBe('social');
    expect(classifyChannel({ referrerHost: 'blog.example.org' })).toBe('referral');
    expect(classifyChannel({ referrerHost: 'www.google.com', utmSource: 'google', utmMedium: 'cpc' })).toBe('paid');
    expect(classifyChannel({ utmSource: 'newsletter', utmMedium: 'email' })).toBe('email');
    expect(classifyChannel({ utmSource: 'producthunt' })).toBe('campaign');
    expect(classifyChannel({ utmCampaign: 'launch' })).toBe('campaign');
    expect(classifyChannel({ landingPath: '/r/:code' })).toBe('invite');
    expect(classifyChannel({ landingPath: '/r/:code', utmSource: 'x' })).toBe('campaign');
  });

  it('knows the sign-up and sign-in pages, with or without a locale prefix', () => {
    for (const p of ['/signup', '/login', '/signup/', '/de/signup', '/zh-TW/login']) expect(isAuthEntryPath(p), p).toBe(true);
    for (const p of ['/', '/jobs', '/signup/extra', '/login-help', '/reset-password/:token', null, undefined]) expect(isAuthEntryPath(p), String(p)).toBe(false);
  });

  it('reads a batch oldest first: landing page, referrer, the first campaign, the first sign-up view and start', () => {
    const summary = summarizeVisit([
      { name: 'signup_started', at: at('2026-11-10T11:05:00Z'), props: { method: 'google', mode: 'signup' } },
      page('/signup', '2026-11-10T11:04:00Z', { from: 'pricing' }),
      page('/pricing', '2026-11-10T11:02:00Z', { utmSource: 'later', utmMedium: 'cpc' }),
      page('/', '2026-11-10T11:00:00Z', { referrerHost: 'www.google.com', locale: 'en', utmSource: 'spring', utmCampaign: 'launch' }),
      { name: 'job_opened', at: at('2026-11-10T11:03:00Z'), props: { jobId: 'j1' } },
    ]);
    expect(summary).toEqual({
      firstAt: at('2026-11-10T11:00:00Z'),
      lastAt: at('2026-11-10T11:05:00Z'),
      pageViews: 3,
      landingPath: '/',
      referrerHost: 'google.com',
      utmSource: 'spring',
      utmMedium: null,
      utmCampaign: 'launch',
      locale: 'en',
      signupViewedAt: at('2026-11-10T11:04:00Z'),
      signupFrom: 'pricing',
      signupStartedAt: at('2026-11-10T11:05:00Z'),
      signupMethod: 'google',
    });
    expect(summarizeVisit([])).toBeNull();
    // A method outside the list is not kept.
    expect(summarizeVisit([{ name: 'signup_started', at: NOW, props: { method: 'carrier-pigeon' } }])?.signupMethod).toBeNull();
  });

  it('`visit_entry` (sent after "Allow") stands for the pages counted before it: the real first page, source and time', () => {
    const summary = summarizeVisit([
      page('/signup', '2026-11-10T11:06:00Z', { from: 'pricing' }),
      // Arrives in the same batch, but carries the time the visit began.
      { name: 'visit_entry', path: '/', at: at('2026-11-10T11:00:00Z'), props: { referrerHost: 'www.google.com', locale: 'de', utmSource: 'spring', pages: 3 } },
    ]);
    expect(summary).toMatchObject({
      firstAt: at('2026-11-10T11:00:00Z'),
      pageViews: 4,
      landingPath: '/',
      referrerHost: 'google.com',
      utmSource: 'spring',
      locale: 'de',
      signupViewedAt: at('2026-11-10T11:06:00Z'),
      signupFrom: 'pricing',
    });
    // A visit that began on the sign-up page reached that step when it began.
    expect(summarizeVisit([{ name: 'visit_entry', path: '/signup', at: at('2026-11-10T11:00:00Z'), props: { pages: 1 } }])).toMatchObject({ pageViews: 1, landingPath: '/signup', signupViewedAt: at('2026-11-10T11:00:00Z') });
    // The count is bounded and never negative.
    expect(summarizeVisit([{ name: 'visit_entry', path: '/', at: NOW, props: { pages: 1e9 } }])?.pageViews).toBe(200);
    expect(summarizeVisit([{ name: 'visit_entry', path: '/', at: NOW, props: { pages: -4 } }])?.pageViews).toBe(0);
    expect(summarizeVisit([{ name: 'visit_entry', path: '/', at: NOW, props: {} }])?.pageViews).toBe(0);
  });

  it('an account created after the first visit is a sign-up; an older one means they were already a user', () => {
    const first = at('2026-11-10T10:00:00Z');
    expect(accountOutcome(first, at('2026-11-10T10:20:00Z'))).toEqual({ signedUpAt: at('2026-11-10T10:20:00Z'), knownUser: false });
    // The row can start a little after the account (consent answered right after signing up).
    const justBefore = new Date(first.getTime() - SIGNUP_GRACE_MS + 1000);
    expect(accountOutcome(first, justBefore)).toEqual({ signedUpAt: justBefore, knownUser: false });
    expect(accountOutcome(first, at('2026-10-01T00:00:00Z'))).toEqual({ signedUpAt: null, knownUser: true });
  });
});

// ── Recorder ─────────────────────────────────────────────────────────────

describe('visitor recorder', () => {
  it('creates the row with the first touch, the country and the device class (never the User-Agent)', async () => {
    const { fake, rec } = recorder();
    const result = await rec.record({
      ...base,
      userAgent: IPHONE,
      country: 'TW',
      events: [page('/', '2026-11-10T11:00:00Z', { referrerHost: 'www.google.com', locale: 'zh-TW' }), page('/pricing', '2026-11-10T11:01:00Z')],
    });
    expect(result).toBe('recorded');
    const rows = fake.$rows('rAVisitor');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      brand: 'roboapply',
      anonId: ANON,
      firstSeenAt: at('2026-11-10T11:00:00Z'),
      lastSeenAt: at('2026-11-10T11:01:00Z'),
      landingPath: '/',
      referrerHost: 'google.com',
      channel: 'search',
      country: 'TW',
      device: 'mobile',
      locale: 'zh-TW',
      pageViews: 2,
      visits: 1,
      lastVisitId: 'visit_0001',
      signupViewedAt: null,
      signupStartedAt: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain('iPhone OS');
  });

  it('later batches add up; the first touch and the first stamps are never overwritten', async () => {
    const { fake, rec } = recorder();
    await rec.record({ ...base, events: [page('/', '2026-11-10T11:00:00Z', { referrerHost: 'www.google.com' })] });
    // Same page load: more pages, the sign-up page, then the form.
    await rec.record({
      ...base,
      events: [page('/signup', '2026-11-10T11:03:00Z', { from: 'home' }), { name: 'signup_started', at: at('2026-11-10T11:04:00Z'), props: { method: 'email', mode: 'signup' } }],
    });
    // A new visit a day later, from a campaign, on another device and country.
    await rec.record({
      ...base,
      visitId: 'visit_0002',
      country: 'DE',
      userAgent: IPHONE,
      events: [
        page('/login', '2026-11-11T09:00:00Z', { utmSource: 'newsletter', utmMedium: 'email', referrerHost: 'mail.example.com', from: 'email' }),
        { name: 'signup_started', at: at('2026-11-11T09:01:00Z'), props: { method: 'google', mode: 'login' } },
      ],
    });
    const [row] = fake.$rows('rAVisitor');
    expect(fake.$rows('rAVisitor')).toHaveLength(1);
    expect(row).toMatchObject({
      firstSeenAt: at('2026-11-10T11:00:00Z'),
      lastSeenAt: at('2026-11-11T09:01:00Z'),
      pageViews: 3,
      visits: 2,
      lastVisitId: 'visit_0002',
      // First touch.
      landingPath: '/',
      referrerHost: 'google.com',
      channel: 'search',
      utmSource: null,
      country: 'US',
      device: 'desktop',
      // First stamps.
      signupViewedAt: at('2026-11-10T11:03:00Z'),
      signupFrom: 'home',
      signupStartedAt: at('2026-11-10T11:04:00Z'),
      signupMethod: 'email',
    });
  });

  it('links the account once, from the session: created after the first visit = signed up', async () => {
    const fake = fakeDb({ user: [{ id: 'u_new', createdAt: at('2026-11-10T11:06:00Z') }] });
    const { rec } = recorder(fake);
    await rec.record({ ...base, events: [page('/', '2026-11-10T11:00:00Z')] });
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({ userId: null, signedUpAt: null, knownUser: false });
    await rec.record({ ...base, userId: 'u_new', events: [page('/onboarding', '2026-11-10T11:07:00Z')] });
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({ userId: 'u_new', signedUpAt: at('2026-11-10T11:06:00Z'), knownUser: false });
    // Someone else signing in on the same browser later does not take the row over.
    fake.$rows('user').push({ id: 'u_other', createdAt: at('2026-11-12T00:00:00Z') });
    await rec.record({ ...base, userId: 'u_other', events: [page('/jobs', '2026-11-12T00:01:00Z')] });
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({ userId: 'u_new', signedUpAt: at('2026-11-10T11:06:00Z') });
  });

  it('a visitor who already had an account is marked as such, not as a sign-up', async () => {
    const fake = fakeDb({ user: [{ id: 'u_old', createdAt: at('2026-08-01T00:00:00Z') }] });
    const { rec } = recorder(fake);
    await rec.record({ ...base, userId: 'u_old', events: [page('/jobs', '2026-11-10T11:00:00Z')] });
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({ userId: 'u_old', signedUpAt: null, knownUser: true });
  });

  it('records nothing without an accepted anonymous id, for automated clients, or for an empty batch', async () => {
    const { fake, rec } = recorder();
    const events = [page('/', '2026-11-10T11:00:00Z')];
    expect(await rec.record({ ...base, anonId: null, events })).toBe('skipped');
    expect(await rec.record({ ...base, anonId: 'bad id!', events })).toBe('skipped');
    expect(await rec.record({ ...base, userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0)', events })).toBe('skipped');
    expect(await rec.record({ ...base, userAgent: null, events })).toBe('skipped');
    expect(await rec.record({ ...base, events: [] })).toBe('skipped');
    expect(fake.$rows('rAVisitor')).toHaveLength(0);
  });

  it('never throws: while the table is missing it backs off, then tries again', async () => {
    let clock = NOW.getTime();
    const missing = Object.assign(new Error('The table `public.RAVisitor` does not exist'), { code: 'P2021' });
    const calls = { findFirst: 0 };
    const db = {
      rAVisitor: {
        findFirst: async () => {
          calls.findFirst += 1;
          throw missing;
        },
      },
      user: {},
    } as unknown as VisitorDb;
    const rec = createVisitorRecorder({ db, now: () => new Date(clock) });
    const events = [page('/', '2026-11-10T11:00:00Z')];
    expect(await rec.record({ ...base, events })).toBe('unavailable');
    expect(await rec.record({ ...base, events })).toBe('unavailable');
    expect(calls.findFirst).toBe(1); // the second call did not touch the database
    clock += VISITOR_TABLE_RETRY_MS + 1;
    expect(await rec.record({ ...base, events })).toBe('unavailable');
    expect(calls.findFirst).toBe(2);

    const broken = createVisitorRecorder({ db: { rAVisitor: { findFirst: async () => { throw new Error('connection reset'); } }, user: {} } as unknown as VisitorDb });
    await expect(broken.record({ ...base, events })).resolves.toBe('unavailable');
  });

  it("deletes a person's rows: theirs, and unlinked rows of their anonymous ids (never someone else's)", async () => {
    const fake = fakeDb({
      rAVisitor: [
        { id: 'v1', brand: 'roboapply', anonId: 'anon_mine_0001', userId: 'u1', lastSeenAt: NOW },
        { id: 'v2', brand: 'roboapply', anonId: 'anon_mine_0002', userId: null, lastSeenAt: NOW },
        { id: 'v3', brand: 'roboapply', anonId: 'anon_shared_01', userId: 'u2', lastSeenAt: NOW },
        { id: 'v4', brand: 'roboapply', anonId: 'anon_other_001', userId: null, lastSeenAt: NOW },
      ],
    });
    const { rec } = recorder(fake);
    expect(await rec.deleteForUser('u1', ['anon_mine_0002', 'anon_shared_01'])).toBe(2);
    expect(fake.$rows('rAVisitor').map((r) => r.id)).toEqual(['v3', 'v4']);
  });

  it('prunes rows whose last visit is older than the retention (≈13 months)', async () => {
    const fake = fakeDb({
      rAVisitor: [
        { id: 'old', brand: 'roboapply', anonId: 'anon_old_00001', lastSeenAt: at('2025-09-01T00:00:00Z') },
        { id: 'new', brand: 'roboapply', anonId: 'anon_new_00001', lastSeenAt: at('2026-10-01T00:00:00Z') },
      ],
    });
    const { rec } = recorder(fake);
    expect(await rec.prune()).toBe(1);
    expect(fake.$rows('rAVisitor').map((r) => r.id)).toEqual(['new']);
  });
});

// ── Through the events ingest ────────────────────────────────────────────

describe('ingestEvents keeps the visitor record', () => {
  const allow = async (): Promise<RateLimitResult> => ({ allowed: true, retryAfterSec: 0, remaining: 100, windows: [] });
  const US: IngestContext = { brand: 'roboapply', market: 'intl', userId: null, country: 'US', consent: null, ip: '1.2.3.4', userAgent: CHROME };
  const batch = (extra: Record<string, unknown> = {}) => ({
    anonId: ANON,
    sessionId: 'visit_0001',
    events: [
      { name: 'page_viewed', path: '/?utm_source=x', at: '2026-11-10T11:59:00.000Z', props: { referrerHost: 'www.linkedin.com', locale: 'en', utmSource: 'li', utmMedium: 'paid_social', utmCampaign: 'q4' } },
      { name: 'page_viewed', path: '/signup?from=home', at: '2026-11-10T11:59:20.000Z', props: { from: 'home' } },
      { name: 'signup_started', path: '/signup', at: '2026-11-10T11:59:40.000Z', props: { method: 'google', mode: 'signup', email: 'a@b.co' } },
    ],
    ...extra,
  });

  function setup() {
    const fake = fakeDb();
    const svc = createGrowthService({ db: fake as unknown as GrowthDb, consumeRateLimit: allow, now: () => NOW });
    return { fake, svc };
  }

  it('a visitor outside the consent region gets a row: source, sign-up view and start', async () => {
    const { fake, svc } = setup();
    expect(await svc.ingestEvents(batch(), US)).toEqual({ accepted: 3, rejected: 0 });
    expect(fake.$rows('rAProductEvent')).toHaveLength(3);
    expect(fake.$rows('rAVisitor')).toHaveLength(1);
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({
      anonId: ANON,
      landingPath: '/',
      referrerHost: 'linkedin.com',
      utmSource: 'li',
      utmMedium: 'paid_social',
      utmCampaign: 'q4',
      channel: 'paid',
      country: 'US',
      device: 'desktop',
      pageViews: 2,
      signupFrom: 'home',
      signupMethod: 'google',
    });
    expect(fake.$rows('rAVisitor')[0]!.signupViewedAt).toEqual(at('2026-11-10T11:59:20.000Z'));
    expect(fake.$rows('rAVisitor')[0]!.signupStartedAt).toEqual(at('2026-11-10T11:59:40.000Z'));
    // The contact detail a client slipped into the props never reached either table.
    expect(JSON.stringify([fake.$rows('rAProductEvent'), fake.$rows('rAVisitor')])).not.toContain('a@b.co');
  });

  it('EEA, UK and Swiss visitors who were not asked or said no get no row (their views are only counted)', async () => {
    for (const consent of [null, 'denied'] as const) {
      const { fake, svc } = setup();
      await svc.ingestEvents(batch(), { ...US, country: 'DE', consent, userId: 'u1' });
      expect(fake.$rows('rAProductEvent')).toHaveLength(3);
      expect(fake.$rows('rAProductEvent').every((e) => e.anonId === null && e.userId === null)).toBe(true);
      expect(fake.$rows('rAVisitor')).toHaveLength(0);
    }
    const { fake, svc } = setup();
    await svc.ingestEvents(batch(), { ...US, country: 'DE', consent: 'granted' });
    expect(fake.$rows('rAVisitor')).toHaveLength(1);
  });

  it('a visitor who allows after the first pages were counted: the row starts with the real source and arrival time', async () => {
    const { fake, svc } = setup();
    const DE = { ...US, country: 'DE' };
    // Before the answer: counted, linked to nothing.
    await svc.ingestEvents(
      { sessionId: 'visit_0001', events: [{ name: 'page_viewed', path: '/', at: '2026-11-10T11:50:00.000Z', props: { referrerHost: 'chatgpt.com', locale: 'de' } }, { name: 'page_viewed', path: '/pricing', at: '2026-11-10T11:51:00.000Z' }] },
      DE,
    );
    expect(fake.$rows('rAVisitor')).toHaveLength(0);
    // After "Allow": the next page, and how the visit began.
    await svc.ingestEvents(
      {
        anonId: ANON,
        sessionId: 'visit_0001',
        events: [
          { name: 'visit_entry', path: '/', at: '2026-11-10T11:50:00.000Z', props: { referrerHost: 'chatgpt.com', locale: 'de', pages: 2 } },
          { name: 'page_viewed', path: '/signup', at: '2026-11-10T11:55:00.000Z', props: { from: 'pricing' } },
        ],
      },
      { ...DE, consent: 'granted' },
    );
    expect(fake.$rows('rAVisitor')).toHaveLength(1);
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({ landingPath: '/', referrerHost: 'chatgpt.com', channel: 'ai', locale: 'de', pageViews: 3, country: 'DE', firstSeenAt: at('2026-11-10T11:50:00.000Z'), signupFrom: 'pricing' });
  });

  it('a batch without an anonymous id, or from an automated client, stores events but no visitor', async () => {
    const { fake, svc } = setup();
    await svc.ingestEvents(batch({ anonId: undefined }), US);
    await svc.ingestEvents(batch(), { ...US, userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    expect(fake.$rows('rAProductEvent')).toHaveLength(6);
    expect(fake.$rows('rAVisitor')).toHaveLength(0);
  });

  it('the signed-in session links the account: a new account is a sign-up', async () => {
    const { fake, svc } = setup();
    await svc.ingestEvents(batch(), US);
    fake.$rows('user').push({ id: 'u_new', createdAt: at('2026-11-10T11:59:50.000Z') });
    await svc.ingestEvents({ anonId: ANON, sessionId: 'visit_0002', events: [{ name: 'page_viewed', path: '/onboarding', at: '2026-11-10T11:59:55.000Z' }] }, { ...US, userId: 'u_new' });
    expect(fake.$rows('rAVisitor')[0]).toMatchObject({ userId: 'u_new', signedUpAt: at('2026-11-10T11:59:50.000Z'), knownUser: false, visits: 2, pageViews: 3 });
  });

  it('a failing visitor write never fails the ingest', async () => {
    const fake = createFakePrisma({ failOn: { 'rAVisitor.findFirst': Object.assign(new Error('no table'), { code: 'P2021' }) } });
    const svc = createGrowthService({ db: fake as unknown as GrowthDb, consumeRateLimit: allow, now: () => NOW });
    await expect(svc.ingestEvents(batch(), US)).resolves.toEqual({ accepted: 3, rejected: 0 });
    expect(fake.$rows('rAProductEvent')).toHaveLength(3);
  });

  it('`visitors: null` turns the record off', async () => {
    const fake = fakeDb();
    const svc = createGrowthService({ db: fake as unknown as GrowthDb, consumeRateLimit: allow, now: () => NOW, visitors: null });
    await svc.ingestEvents(batch(), US);
    expect(fake.$rows('rAVisitor')).toHaveLength(0);
  });

  it('the account wipe and the prune take the visitor rows with the events', async () => {
    const fake = fakeDb({
      rAAttribution: [{ userId: 'u1', anonId: 'anon_mine_0002' }],
      rAProductEvent: [{ id: 'e1', userId: 'u1', anonId: null, createdAt: NOW }],
      rAVisitor: [
        { id: 'v1', brand: 'roboapply', anonId: 'anon_mine_0001', userId: 'u1', lastSeenAt: NOW },
        { id: 'v2', brand: 'roboapply', anonId: 'anon_mine_0002', userId: null, lastSeenAt: NOW },
        { id: 'v3', brand: 'roboapply', anonId: 'anon_other_001', userId: 'u2', lastSeenAt: at('2025-01-01T00:00:00Z') },
      ],
    });
    const svc = createGrowthService({ db: fake as unknown as GrowthDb, consumeRateLimit: allow, now: () => NOW });
    await svc.deleteEventsForUser('u1');
    expect(fake.$rows('rAVisitor').map((r) => r.id)).toEqual(['v3']);
    await svc.pruneProductEvents();
    expect(fake.$rows('rAVisitor')).toHaveLength(0);
  });
});
