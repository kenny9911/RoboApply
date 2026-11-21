// @vitest-environment node
//
// Visitors and sign-ups (admin/visitors.ts): the range, the report built from
// a store, the list, and what happens while the visitor table is missing.
// In-memory stores: no database, no network.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({
  default: new Proxy({}, { get: () => { throw new Error('tests must not reach Prisma'); } }),
}));

import {
  VISITORS_PAGE_SIZE,
  VISITOR_DIMENSIONS,
  daysOfRange,
  getVisitorsReport,
  isMissingVisitorTable,
  listVisitors,
  resolveVisitorRange,
  statusWhere,
  toVisitorView,
  visitorStatus,
  type VisitorListRow,
  type VisitorReportStore,
} from '../visitors.js';
import { VISITOR_CHANNEL_IDS, VISITOR_STATUSES } from '../contract.js';
import { VISITOR_CHANNELS } from '../../growth/visitors.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');

const row = (over: Partial<VisitorListRow> = {}): VisitorListRow => ({
  id: 'v1',
  brand: 'roboapply',
  firstSeenAt: new Date('2026-11-09T08:00:00Z'),
  lastSeenAt: new Date('2026-11-09T09:00:00Z'),
  channel: 'direct',
  landingPath: '/',
  referrerHost: null,
  utmSource: null,
  utmCampaign: null,
  country: 'US',
  device: 'desktop',
  locale: 'en',
  pageViews: 1,
  visits: 1,
  signupViewedAt: null,
  signupFrom: null,
  signupStartedAt: null,
  signupMethod: null,
  signedUpAt: null,
  knownUser: false,
  user: null,
  onboarded: false,
  ...over,
});

function store(over: Partial<VisitorReportStore> = {}): VisitorReportStore {
  return {
    totals: async () => ({ visitors: 0, signupViewed: 0, signupStarted: 0, signedUp: 0, onboarded: 0, knownUsers: 0, pageViews: 0, medianSecondsToSignup: null }),
    daily: async () => [],
    breakdown: async () => [],
    untrackedVisits: async () => 0,
    newAccounts: async () => 0,
    list: async () => [],
    ...over,
  };
}

describe('contract', () => {
  it('lists the same channels as the visitor recorder (the contract stays import-free for the web mirror)', () => {
    expect([...VISITOR_CHANNEL_IDS]).toEqual([...VISITOR_CHANNELS]);
  });
});

describe('resolveVisitorRange', () => {
  it('defaults to the last 30 days, ending now, in the given zone', () => {
    const r = resolveVisitorRange({ tz: 'America/New_York' }, NOW);
    expect(r.to).toEqual(NOW);
    // 30 calendar days including today: Oct 12 00:00 in New York (EDT, UTC-4).
    expect(r.from.toISOString()).toBe('2026-10-12T04:00:00.000Z');
    expect(daysOfRange(r)).toHaveLength(30);
    expect(daysOfRange(r)[0]).toBe('2026-10-12');
    expect(daysOfRange(r)[29]).toBe('2026-11-10');
  });

  it('reads days in the zone (both inclusive) and ISO instants as they are', () => {
    const days = resolveVisitorRange({ from: '2026-11-01', to: '2026-11-03', tz: 'Asia/Taipei' }, NOW);
    expect(days.from.toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(days.to.toISOString()).toBe('2026-11-03T16:00:00.000Z');
    expect(daysOfRange(days)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);

    const instants = resolveVisitorRange({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' }, NOW);
    expect(instants).toMatchObject({ tz: 'UTC' });
    expect(daysOfRange(instants)).toEqual(['2026-11-01']);
    // An unusable zone falls back to UTC.
    expect(resolveVisitorRange({ tz: 'Mars/Olympus' }, NOW).tz).toBe('UTC');
  });

  it('crosses a daylight-saving change without losing or doubling a day', () => {
    const r = resolveVisitorRange({ from: '2026-10-31', to: '2026-11-02', tz: 'America/New_York' }, NOW);
    expect(r.from.toISOString()).toBe('2026-10-31T04:00:00.000Z'); // EDT
    expect(r.to.toISOString()).toBe('2026-11-03T05:00:00.000Z'); // EST after Nov 1
    expect(daysOfRange(r)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('rejects junk, a reversed range and more than a year', () => {
    expect(() => resolveVisitorRange({ from: 'yesterday' }, NOW)).toThrow();
    expect(() => resolveVisitorRange({ from: '2026-02-30', to: '2026-03-01' }, NOW)).toThrow();
    expect(() => resolveVisitorRange({ from: '2026-11-05', to: '2026-11-01' }, NOW)).toThrow();
    expect(() => resolveVisitorRange({ from: '2025-01-01', to: '2026-11-01' }, NOW)).toThrow();
  });
});

describe('getVisitorsReport', () => {
  it('assembles the cohort: steps, every day of the range, one breakdown per dimension, and the context counts', async () => {
    const asked: string[] = [];
    const out = await getVisitorsReport(
      store({
        totals: async () => ({ visitors: 200, signupViewed: 60, signupStarted: 40, signedUp: 25, onboarded: 10, knownUsers: 30, pageViews: 900, medianSecondsToSignup: 754.6 }),
        daily: async () => [{ day: '2026-11-02', visitors: 200, signupViewed: 60, signupStarted: 40, signedUp: 25, onboarded: 10 }],
        breakdown: async (_s, dimension, take) => {
          asked.push(`${dimension}:${take}`);
          return [{ key: dimension === 'source' ? null : 'x', visitors: 200, signedUp: 25 }];
        },
        untrackedVisits: async () => 44,
        newAccounts: async () => 31,
      }),
      { from: '2026-11-01', to: '2026-11-03', tz: 'UTC', brand: 'roboapply' },
      NOW,
    );
    expect(out).toMatchObject({
      ready: true,
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-04T00:00:00.000Z',
      tz: 'UTC',
      funnel: { visitors: 200, signupViewed: 60, signupStarted: 40, signedUp: 25, onboarded: 10 },
      knownUsers: 30,
      pageViews: 900,
      medianSecondsToSignup: 755,
      untrackedVisits: 44,
      newAccounts: 31,
    });
    expect(out.daily).toEqual([
      { day: '2026-11-01', visitors: 0, signupViewed: 0, signupStarted: 0, signedUp: 0, onboarded: 0 },
      { day: '2026-11-02', visitors: 200, signupViewed: 60, signupStarted: 40, signedUp: 25, onboarded: 10 },
      { day: '2026-11-03', visitors: 0, signupViewed: 0, signupStarted: 0, signedUp: 0, onboarded: 0 },
    ]);
    expect(asked).toEqual(VISITOR_DIMENSIONS.map((d) => `${d}:12`));
    expect(out.sources).toEqual([{ key: null, visitors: 200, signedUp: 25 }]);
    expect(out.methods).toEqual([{ key: 'x', visitors: 200, signedUp: 25 }]);
    // The funnel object carries only the five steps.
    expect(Object.keys(out.funnel)).toEqual(['visitors', 'signupViewed', 'signupStarted', 'signedUp', 'onboarded']);
  });

  it('nobody signed up: the median is null, not zero', async () => {
    const out = await getVisitorsReport(store(), {}, NOW);
    expect(out.medianSecondsToSignup).toBeNull();
    expect(out.daily).toHaveLength(30);
  });

  it('while the visitor table is missing: ready false, zeros, and the counts that read other tables still answer', async () => {
    for (const err of [
      Object.assign(new Error('The table `public.RAVisitor` does not exist in the current database.'), { code: 'P2021' }),
      Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '42P01', message: 'relation "RAVisitor" does not exist' } }),
    ]) {
      const out = await getVisitorsReport(
        store({ totals: async () => { throw err; }, untrackedVisits: async () => 12, newAccounts: async () => 3 }),
        { from: '2026-11-01', to: '2026-11-02' },
        NOW,
      );
      expect(out).toMatchObject({ ready: false, funnel: { visitors: 0, signedUp: 0 }, untrackedVisits: 12, newAccounts: 3, channels: [] });
      expect(out.daily.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-02']);
    }
    expect(isMissingVisitorTable(new Error('connection reset'))).toBe(false);
    await expect(getVisitorsReport(store({ totals: async () => { throw new Error('connection reset'); } }), {}, NOW)).rejects.toThrow('connection reset');
  });
});

describe('listVisitors', () => {
  it('pages by offset and says when another page follows', async () => {
    const seen: Array<{ skip: number; take: number }> = [];
    const many = Array.from({ length: VISITORS_PAGE_SIZE + 1 }, (_, i) => row({ id: `v${i}` }));
    const s = store({
      list: async (_scope, _filter, page) => {
        seen.push(page);
        return page.skip === 0 ? many : [row({ id: 'last' })];
      },
    });
    const first = await listVisitors(s, {}, NOW);
    expect(first.items).toHaveLength(VISITORS_PAGE_SIZE);
    expect(first.cursor).toBe(`o:${VISITORS_PAGE_SIZE}`);
    const second = await listVisitors(s, { cursor: first.cursor! }, NOW);
    expect(second.items.map((v) => v.id)).toEqual(['last']);
    expect(second.cursor).toBeNull();
    expect(seen).toEqual([{ skip: 0, take: VISITORS_PAGE_SIZE + 1 }, { skip: VISITORS_PAGE_SIZE, take: VISITORS_PAGE_SIZE + 1 }]);
    // A cursor that is not ours starts from the top.
    await listVisitors(s, { cursor: 'o:-5' }, NOW);
    await listVisitors(s, { cursor: 'junk' }, NOW);
    expect(seen.slice(2).map((p) => p.skip)).toEqual([0, 0]);
  });

  it('answers ready false while the table is missing', async () => {
    const missing = Object.assign(new Error('no table'), { code: 'P2021' });
    expect(await listVisitors(store({ list: async () => { throw missing; } }), {}, NOW)).toEqual({ ready: false, items: [], cursor: null });
  });
});

describe('visitor status', () => {
  const t = (iso: string) => new Date(iso);

  it('is the furthest stage reached', () => {
    expect(visitorStatus(row())).toBe('browsing');
    expect(visitorStatus(row({ signupViewedAt: t('2026-11-09T08:01:00Z') }))).toBe('signup_viewed');
    expect(visitorStatus(row({ signupViewedAt: t('2026-11-09T08:01:00Z'), signupStartedAt: t('2026-11-09T08:02:00Z') }))).toBe('signup_started');
    expect(visitorStatus(row({ signedUpAt: t('2026-11-09T08:03:00Z') }))).toBe('signed_up');
    expect(visitorStatus(row({ signedUpAt: t('2026-11-09T08:03:00Z'), onboarded: true }))).toBe('onboarded');
    // Already a user: never a conversion, whatever else is stamped.
    expect(visitorStatus(row({ knownUser: true, signupViewedAt: t('2026-11-09T08:01:00Z'), onboarded: true }))).toBe('known_user');
  });

  it('every status has a list filter, and the filters do not overlap', () => {
    for (const status of VISITOR_STATUSES) expect(Object.keys(statusWhere(status)).length, status).toBeGreaterThan(0);
    expect(statusWhere(undefined)).toEqual({});
    expect(statusWhere('browsing')).toEqual({ knownUser: false, signedUpAt: null, signupStartedAt: null, signupViewedAt: null });
    expect(statusWhere('signup_viewed')).toMatchObject({ knownUser: false, signedUpAt: null, signupStartedAt: null, signupViewedAt: { not: null } });
    expect(statusWhere('signup_started')).toMatchObject({ knownUser: false, signedUpAt: null, signupStartedAt: { not: null } });
    expect(statusWhere('signed_up')).toMatchObject({ knownUser: false, signedUpAt: { not: null }, NOT: expect.anything() });
    expect(statusWhere('onboarded')).toMatchObject({ knownUser: false, signedUpAt: { not: null }, user: expect.anything() });
    expect(statusWhere('known_user')).toEqual({ knownUser: true });
  });

  it('the view names the source (campaign first, then the referring site) and carries the account', () => {
    const view = toVisitorView(
      row({ utmSource: 'newsletter', utmCampaign: 'q4', referrerHost: 'mail.example.com', signedUpAt: t('2026-11-09T08:03:00Z'), user: { id: 'u1', email: 'a@example.com', name: null } }),
    );
    expect(view).toMatchObject({ status: 'signed_up', source: 'newsletter', campaign: 'q4', signedUpAt: '2026-11-09T08:03:00.000Z', user: { id: 'u1', email: 'a@example.com', name: null } });
    expect(toVisitorView(row({ referrerHost: 'google.com' })).source).toBe('google.com');
    expect(toVisitorView(row()).source).toBeNull();
  });
});
