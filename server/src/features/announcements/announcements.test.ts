// @vitest-environment node
// WP-61: "What's new" announcements — publish rule (every brand locale
// translated), cohort/locale/window selection, at most one shown, the
// server-side popup budget, seen-once with an inbox copy, and the admin CRUD
// routes. Prisma is the in-memory fake; nothing touches a database.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { getBrand } from '../../platform/brand/registry.js';
import {
  ANNOUNCEMENT_DEFAULT_DAYS,
  AnnouncementsService,
  createAnnouncementsAdminRouter,
  createAnnouncementsRouter,
  createPrismaAnnouncementsRepo,
  AnnouncementLocaleContentSchema,
  fromRow,
  isInternalHref,
  LIST_IN_WINDOW_LIMIT,
  PUBLISHED_WHERE,
  matchesCohort,
  missingLocales,
  pickAnnouncement,
  readActive,
  statusOf,
  validateDraft,
  type AdminAnnouncementView,
  type AnnouncementRecord,
  type AudienceFacts,
  type NextAnnouncementResponse,
} from './index.js';

const T0 = new Date('2026-10-10T08:00:00.000Z');
const HOUR = 3600_000;
const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');

const text = (title: string) => ({ title, body: `${title} — details.` });
const allLocales = (brand = ROBO, prefix = 'New') => Object.fromEntries(brand.locales.map((l) => [l, text(`${prefix} (${l})`)]));

function record(over: Partial<AnnouncementRecord> = {}): AnnouncementRecord {
  return {
    id: 'a1',
    key: 'launch.assistant',
    brand: 'roboapply',
    locales: [...ROBO.locales],
    content: allLocales(),
    cohort: {},
    active: true,
    priority: 100,
    startsAt: new Date(T0.getTime() - HOUR),
    endsAt: new Date(T0.getTime() + 10 * 24 * HOUR),
    createdAt: new Date(T0.getTime() - 2 * HOUR),
    ...over,
  };
}

function facts(over: Partial<AudienceFacts> = {}): AudienceFacts {
  return { planKey: 'free', planProfile: 'free', signedUpAt: new Date('2026-01-01T00:00:00Z'), flagOn: async () => true, ...over };
}

/**
 * The fake Prisma has no JSON-path filters; evaluate `PUBLISHED_WHERE` (the
 * column is true, or the column is null and `cohort.active === true`) the way
 * Postgres would, so the query's own filter (not the in-memory guard) decides
 * what `take` counts.
 */
function withJsonPathFilter(db: ReturnType<typeof createFakePrisma>) {
  const model = (db as unknown as { rAAnnouncement: { findMany: (a: Record<string, unknown>) => Promise<Record<string, unknown>[]> } }).rAAnnouncement;
  const findMany = model.findMany.bind(model);
  const calls: Array<Record<string, unknown>> = [];
  const wrapped = {
    ...db,
    rAAnnouncement: {
      ...model,
      findMany: async (args: Record<string, unknown> = {}) => {
        calls.push(args);
        const where = { ...((args.where as Record<string, unknown>) ?? {}) };
        if (JSON.stringify(where.OR) !== JSON.stringify(PUBLISHED_WHERE.OR)) return findMany(args);
        delete where.OR;
        const take = args.take as number | undefined;
        const rows = await findMany({ ...args, where, take: undefined });
        const kept = rows.filter((r) => {
          if (r.active === true) return true;
          const c = r.cohort as Record<string, unknown> | null;
          return (r.active === null || r.active === undefined) && c !== null && typeof c === 'object' && c.active === true;
        });
        return take === undefined ? kept : kept.slice(0, take);
      },
    },
  };
  return { db: wrapped, calls };
}

// ── Pure rules ───────────────────────────────────────────────────────────

describe('publish rule and status', () => {
  it('lists brand locales without content', () => {
    expect(missingLocales(ROBO, { en: text('A'), ja: text('B') })).toEqual(['zh', 'zh-TW', 'ko', 'es', 'fr', 'pt', 'de']);
    expect(missingLocales(GO, allLocales(GO))).toEqual([]);
  });

  it('a draft may be partial; publishing needs every brand locale', () => {
    const draft = { locales: ['en'], content: { en: text('A') }, cohort: {}, active: false, startsAt: T0, endsAt: new Date(T0.getTime() + HOUR) };
    expect(() => validateDraft(ROBO, draft)).not.toThrow();
    expect(() => validateDraft(ROBO, { ...draft, active: true })).toThrow(
      expect.objectContaining({ code: 'invalid_request', details: expect.objectContaining({ reason: 'translations_missing', missing: expect.arrayContaining(['zh', 'de']) }) }),
    );
    expect(() => validateDraft(ROBO, { ...draft, active: true, content: allLocales() })).not.toThrow();
    expect(() => validateDraft(GO, { ...draft, content: { ja: text('x') } })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'locale_not_served' }) }));
    expect(() => validateDraft(GO, { ...draft, locales: ['ko'] })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'locale_not_served' }) }));
    expect(() => validateDraft(ROBO, { ...draft, endsAt: T0 })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'invalid_window' }) }));
    expect(() => validateDraft(ROBO, { ...draft, cohort: { flags: ['nope'] } })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'unknown_flag' }) }));
  });

  it('links are a same-site path or https; backslash tricks are refused', () => {
    const ok = (ctaHref: string) => AnnouncementLocaleContentSchema.safeParse({ title: 'T', body: 'B', ctaHref }).success;
    expect(ok('/jobs')).toBe(true);
    expect(ok('/jobs?x=1#y')).toBe(true);
    expect(ok('https://example.com/a')).toBe(true);
    expect(ok('//evil.example')).toBe(false);
    expect(ok('/\\evil.example')).toBe(false);
    expect(ok('/a\\b')).toBe(false);
    expect(ok('https://evil.example\\@x')).toBe(false);
    expect(ok('http://example.com')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(isInternalHref('/jobs')).toBe(true);
    expect(isInternalHref('/\\evil.example')).toBe(false);
    expect(isInternalHref('//evil.example')).toBe(false);
    expect(isInternalHref('https://example.com')).toBe(false);
    expect(isInternalHref(null)).toBe(false);
  });

  it('derives draft / scheduled / live / ended', () => {
    expect(statusOf(record({ active: false }), T0)).toBe('draft');
    expect(statusOf(record({ startsAt: new Date(T0.getTime() + HOUR) }), T0)).toBe('scheduled');
    expect(statusOf(record(), T0)).toBe('live');
    expect(statusOf(record({ endsAt: T0 }), T0)).toBe('ended');
  });
});

describe('cohort and selection', () => {
  it('matches plans (key or profile), sign-up date and feature switches', async () => {
    expect(await matchesCohort({}, facts())).toBe(true);
    expect(await matchesCohort({ plans: ['pro'] }, facts())).toBe(false);
    expect(await matchesCohort({ plans: ['pro'] }, facts({ planKey: 'pro_monthly', planProfile: 'pro' }))).toBe(true);
    expect(await matchesCohort({ plans: ['pro_weekly'] }, facts({ planKey: 'pro_weekly', planProfile: 'pro' }))).toBe(true);
    expect(await matchesCohort({ signedUpBefore: '2026-06-01T00:00:00.000Z' }, facts())).toBe(true);
    expect(await matchesCohort({ signedUpBefore: '2025-06-01T00:00:00.000Z' }, facts())).toBe(false);
    expect(await matchesCohort({ signedUpBefore: '2026-06-01T00:00:00.000Z' }, facts({ signedUpAt: null }))).toBe(false);
    expect(await matchesCohort({ flags: ['copilot'] }, facts({ flagOn: async (k) => k !== 'copilot' }))).toBe(false);
    expect(await matchesCohort({ flags: ['made.up'] }, facts())).toBe(false);
  });

  it('shows at most one: published, in window, unseen, in the person’s language and cohort; lower priority first', async () => {
    const recs = [
      record({ id: 'draft', active: false, priority: 1 }),
      record({ id: 'future', startsAt: new Date(T0.getTime() + HOUR), priority: 1 }),
      record({ id: 'over', endsAt: T0, priority: 1 }),
      record({ id: 'seen', priority: 1 }),
      record({ id: 'jaOnly', locales: ['ja'], priority: 1 }),
      record({ id: 'proOnly', cohort: { plans: ['pro'] }, priority: 2 }),
      record({ id: 'other', brand: 'goapply', priority: 0 }),
      record({ id: 'low', priority: 50, startsAt: new Date(T0.getTime() - 3 * HOUR) }),
      record({ id: 'lowNewer', priority: 50, startsAt: new Date(T0.getTime() - 2 * HOUR) }),
      record({ id: 'later', priority: 100 }),
    ];
    const factsFn = vi.fn(async () => facts());
    const view = await pickAnnouncement(recs, { brand: ROBO, locale: 'en', seen: new Set(['seen']), now: T0, facts: factsFn });
    expect(view).toEqual({ id: 'lowNewer', key: 'launch.assistant', title: 'New (en)', body: 'New (en) — details.', ctaLabel: null, ctaHref: null });
    expect(factsFn).toHaveBeenCalledTimes(1);
    expect((await pickAnnouncement(recs, { brand: ROBO, locale: 'ja', seen: new Set(['seen']), now: T0, facts: factsFn }))?.id).toBe('jaOnly');
    expect(await pickAnnouncement([], { brand: ROBO, locale: 'en', seen: new Set(), now: T0, facts: factsFn })).toBeNull();
  });
});

describe('stored row adapter (SR-61-1: the publish switch)', () => {
  it('reads the publish switch from the cohort JSON and drops malformed parts', () => {
    const rec = fromRow({
      id: 'a',
      key: 'k',
      brand: 'roboapply',
      locales: ['en'],
      content: { en: text('Hi'), fr: { title: '' }, de: 'junk' },
      cohort: { plans: ['pro'], active: true, unknown: 1 },
      priority: 100,
      startsAt: T0,
      endsAt: T0,
      createdAt: T0,
    });
    expect(rec.active).toBe(true);
    expect(rec.cohort).toEqual({});
    expect(Object.keys(rec.content)).toEqual(['en']);
    expect(readActive({ plans: ['pro'] })).toBe(false);
    expect(fromRow({ ...rec, content: {}, cohort: { plans: ['pro'], active: false } }).cohort).toEqual({ plans: ['pro'] });
    // The column wins when it is set; null or absent falls back to the JSON key.
    expect(readActive({ active: true }, false)).toBe(false);
    expect(readActive({ active: false }, true)).toBe(true);
    expect(readActive({ active: true }, null)).toBe(true);
    expect(readActive({}, null)).toBe(false);
  });

  it('listInWindow filters drafts in the query, so drafts never crowd out a published one', async () => {
    const fake = createFakePrisma({ defaults: { rAAnnouncement: { priority: 100, cohort: {} } } });
    const rows = fake.$rows('rAAnnouncement');
    const base = { brand: 'roboapply', locales: ['en'], content: { en: text('Hi') }, startsAt: new Date(T0.getTime() - HOUR), endsAt: new Date(T0.getTime() + HOUR), createdAt: T0 };
    for (let i = 0; i < LIST_IN_WINDOW_LIMIT + 5; i++) rows.push({ id: `d${i}`, key: `draft.${i}`, priority: 1, cohort: { active: false }, ...base });
    rows.push({ id: 'live', key: 'live.one', priority: 500, cohort: { active: true }, ...base });
    const { db: wrapped, calls } = withJsonPathFilter(fake);
    const repo = createPrismaAnnouncementsRepo(async () => wrapped as never);
    const listed = await repo.listInWindow('roboapply', T0);
    expect(listed.map((r) => r.id)).toEqual(['live']);
    expect(calls[0]!.where).toMatchObject({ brand: 'roboapply', ...PUBLISHED_WHERE });
    expect(calls[0]!.take).toBe(LIST_IN_WINDOW_LIMIT);
  });

  it('listInWindow excludes seen ids in the query, so many seen announcements never hide a later unseen one', async () => {
    const fake = createFakePrisma({ defaults: { rAAnnouncement: { priority: 100, cohort: {} } } });
    const rows = fake.$rows('rAAnnouncement');
    const base = { brand: 'roboapply', locales: ['en'], content: { en: text('Hi') }, startsAt: new Date(T0.getTime() - HOUR), endsAt: new Date(T0.getTime() + HOUR), createdAt: T0 };
    const seen: string[] = [];
    for (let i = 0; i < LIST_IN_WINDOW_LIMIT + 5; i++) {
      rows.push({ id: `s${i}`, key: `seen.${i}`, priority: 1, cohort: { active: true }, ...base });
      seen.push(`s${i}`);
    }
    rows.push({ id: 'fresh', key: 'fresh.one', priority: 500, cohort: { active: true }, ...base });
    const { db: wrapped, calls } = withJsonPathFilter(fake);
    const repo = createPrismaAnnouncementsRepo(async () => wrapped as never);
    const listed = await repo.listInWindow('roboapply', T0, seen);
    expect(listed.map((r) => r.id)).toEqual(['fresh']);
    expect(calls[0]!.where).toMatchObject({ id: { notIn: seen } });
    // Through the service: the person who saw the first 55 still gets the next one.
    const service = new AnnouncementsService({
      repo,
      uiState: async () => ({ announcementsSeen: seen, popupLastShownAt: null }),
      recordSeen: async () => undefined,
      facts: async () => facts(),
      inbox: async () => undefined,
      now: () => T0,
    });
    const next = await service.next('u1', ROBO, 'en');
    expect(next.announcement?.id).toBe('fresh');
  });

  it('SR-61-1: reads and writes RAAnnouncement.active (column), falling back to cohort.active for older rows', async () => {
    const fake = createFakePrisma({ defaults: { rAAnnouncement: { priority: 100, cohort: {} } } });
    const rows = fake.$rows('rAAnnouncement');
    const base = { brand: 'roboapply', locales: ['en'], content: { en: text('Hi') }, startsAt: new Date(T0.getTime() - HOUR), endsAt: new Date(T0.getTime() + HOUR), createdAt: T0 };
    // Rows from before the column (active is null): the JSON key is the switch.
    rows.push({ id: 'oldLive', key: 'old.live', priority: 10, cohort: { active: true }, active: null, ...base });
    rows.push({ id: 'oldDraft', key: 'old.draft', priority: 11, cohort: { active: false }, active: null, ...base });
    rows.push({ id: 'oldBare', key: 'old.bare', priority: 12, cohort: {}, active: null, ...base });
    // Rows where the column is set: it wins over whatever the JSON says.
    rows.push({ id: 'colLive', key: 'col.live', priority: 20, cohort: { active: false }, active: true, ...base });
    rows.push({ id: 'colDraft', key: 'col.draft', priority: 21, cohort: { active: true }, active: false, ...base });
    const { db: wrapped, calls } = withJsonPathFilter(fake);
    const repo = createPrismaAnnouncementsRepo(async () => wrapped as never);

    // Read: the published filter is the OR of both forms, never the column alone.
    expect(PUBLISHED_WHERE).toEqual({ OR: [{ active: true }, { active: null, cohort: { path: ['active'], equals: true } }] });
    const listed = await repo.listInWindow('roboapply', T0);
    expect(listed.map((r) => r.id)).toEqual(['oldLive', 'colLive']);
    expect(calls[0]!.where).toMatchObject(PUBLISHED_WHERE);
    expect((calls[0]!.select as Record<string, unknown>).active).toBe(true);
    expect(Object.fromEntries((await repo.list({ brand: 'roboapply' })).map((r) => [r.id, r.active]))).toEqual({
      oldLive: true,
      oldDraft: false,
      oldBare: false,
      colLive: true,
      colDraft: false,
    });

    // Write: create sets the column (and mirrors it in the cohort JSON for code that only knows the key).
    const created = await repo.create({
      key: 'new.one',
      brand: 'roboapply',
      locales: ['en'],
      content: { en: text('New') },
      cohort: { plans: ['pro'] },
      active: true,
      priority: 5,
      startsAt: base.startsAt,
      endsAt: base.endsAt,
    });
    expect(created).toMatchObject({ active: true, cohort: { plans: ['pro'] } });
    const stored = () => Object.fromEntries(rows.map((r) => [r.key as string, { active: r.active, cohort: r.cohort }]));
    expect(stored()['new.one']).toEqual({ active: true, cohort: { plans: ['pro'], active: true } });

    // Update: unpublishing writes the column; an older row moves onto the column the first time its switch or cohort is saved.
    expect((await repo.update(created.id, { active: false })).active).toBe(false);
    expect(stored()['new.one']).toEqual({ active: false, cohort: { plans: ['pro'], active: false } });
    expect((await repo.update('oldLive', { cohort: { plans: ['free'] } })).active).toBe(true);
    expect(stored()['old.live']).toEqual({ active: true, cohort: { plans: ['free'], active: true } });
    expect((await repo.update('oldDraft', { active: true })).active).toBe(true);
    expect(stored()['old.draft']).toEqual({ active: true, cohort: { active: true } });
    // A change that touches neither leaves an older row as it was (still read through the fallback).
    await repo.update('oldBare', { priority: 99 });
    expect(stored()['old.bare']).toEqual({ active: null, cohort: {} });

    expect((await repo.listInWindow('roboapply', T0)).map((r) => r.id).sort()).toEqual(['colLive', 'oldDraft', 'oldLive'].sort());
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

describe('announcement routes', () => {
  let h: RouteHarness;
  let db: ReturnType<typeof createFakePrisma>;
  let uiState: Map<string, { announcementsSeen: string[]; popupLastShownAt: string | null }>;
  const inbox: Array<{ userId: string; title: string; id: string }> = [];
  let clock = T0;
  const seekerAuth = [fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']) } : null))];
  const adminAuth = [
    fakeAuth((req) => (req.headers['x-test-user'] ? { id: String(req.headers['x-test-user']), role: String(req.headers['x-test-role'] ?? 'seeker') } : null)),
    ((req, res, next) => {
      if ((req as unknown as { user: { role: string } }).user.role !== 'admin') {
        res.status(403).json({ success: false, code: 'forbidden' });
        return;
      }
      next();
    }) as import('express').RequestHandler,
  ];
  const as = (user: string, host = 'localhost:3621') => ({ host, headers: { 'x-test-user': user } });
  const asAdmin = { headers: { 'x-test-user': 'admin1', 'x-test-role': 'admin' } };
  const A = '/api/v1/roboapply/announcements';
  const ADM = '/api/v1/roboapply/admin/announcements';

  beforeAll(async () => {
    db = createFakePrisma({ uniqueFields: { rAAnnouncement: ['key'] }, defaults: { rAAnnouncement: { priority: 100, cohort: {} } } });
    uiState = new Map();
    const service = new AnnouncementsService({
      repo: createPrismaAnnouncementsRepo(async () => withJsonPathFilter(db).db as never),
      uiState: async (userId) => uiState.get(userId) ?? { announcementsSeen: [], popupLastShownAt: null },
      recordSeen: async (userId, id) => {
        const s = uiState.get(userId) ?? { announcementsSeen: [], popupLastShownAt: null };
        uiState.set(userId, { ...s, announcementsSeen: [...s.announcementsSeen, id] });
      },
      facts: async (userId) => facts({ planKey: userId === 'pro1' ? 'pro_monthly' : 'free', planProfile: userId === 'pro1' ? 'pro' : 'free' }),
      inbox: async ({ userId, view, record: rec }) => {
        inbox.push({ userId, title: view.title, id: rec.id });
      },
      now: () => clock,
    });
    h = await startRouteHarness({
      mounts: [
        [A, createAnnouncementsRouter({ seekerAuth, service })],
        [ADM, createAnnouncementsAdminRouter({ adminAuth, service })],
      ],
    });
  });
  afterAll(() => h.close());
  beforeEach(() => {
    db.$rows('rAAnnouncement').length = 0;
    uiState.clear();
    inbox.length = 0;
    clock = T0;
  });

  async function publish(body: Record<string, unknown> = {}) {
    const res = await h.request<{ data: AdminAnnouncementView }>('POST', ADM, {
      ...asAdmin,
      body: { key: 'launch.assistant', brand: 'roboapply', locales: [...ROBO.locales], content: allLocales(), active: true, ...body },
    });
    expect(res.status, res.text).toBe(201);
    return res.body.data;
  }

  it('requires a session (seeker) and an admin (admin routes)', async () => {
    expect((await h.request('GET', `${A}/next`)).status).toBe(401);
    expect((await h.request('POST', `${A}/x/seen`)).status).toBe(401);
    expect((await h.request('GET', ADM)).status).toBe(401);
    expect((await h.request('GET', ADM, as('u1'))).status).toBe(403);
  });

  it('admin: a partial draft saves; publishing it needs every brand locale', async () => {
    const draft = await h.request<{ data: AdminAnnouncementView }>('POST', ADM, {
      ...asAdmin,
      body: { key: 'tw.note', brand: 'roboapply', locales: ['zh-TW'], content: { en: text('Note'), 'zh-TW': text('通知') } },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ active: false, status: 'draft', priority: 100, missingLocales: ['zh', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] });
    expect(new Date(draft.body.data.endsAt).getTime() - new Date(draft.body.data.startsAt).getTime()).toBe(ANNOUNCEMENT_DEFAULT_DAYS * 24 * HOUR);

    const refused = await h.request<{ code: string; details: { reason: string; missing: string[] } }>('PATCH', `${ADM}/${draft.body.data.id}`, {
      ...asAdmin,
      body: { active: true },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.details).toMatchObject({ reason: 'translations_missing', missing: ['zh', 'ja', 'ko', 'es', 'fr', 'pt', 'de'] });

    const ok = await h.request<{ data: AdminAnnouncementView }>('PATCH', `${ADM}/${draft.body.data.id}`, {
      ...asAdmin,
      body: { active: true, content: allLocales(), priority: 10 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ active: true, status: 'live', missingLocales: [], priority: 10, locales: ['zh-TW'] });
    // Stored: the column (SR-61-1), mirrored in the cohort JSON for readers that only know the key.
    expect(db.$rows('rAAnnouncement')[0]).toMatchObject({ active: true, cohort: { active: true } });
  });

  it('admin: create refuses unpublishable or duplicate records; list filters; delete', async () => {
    const missing = await h.request<{ details: { reason: string } }>('POST', ADM, {
      ...asAdmin,
      body: { key: 'x.one', brand: 'roboapply', locales: ['en'], content: { en: text('A') }, active: true },
    });
    expect(missing.status).toBe(422);
    expect(missing.body.details.reason).toBe('translations_missing');
    const cnLocale = await h.request<{ details: { reason: string } }>('POST', ADM, {
      ...asAdmin,
      body: { key: 'x.two', brand: 'goapply', locales: ['ja'], content: { ja: text('A') } },
    });
    expect(cnLocale.body.details.reason).toBe('locale_not_served');
    const bad = await h.request('POST', ADM, { ...asAdmin, body: { key: 'BAD KEY', brand: 'roboapply', locales: ['en'], content: {} } });
    expect(bad.status).toBe(422);

    const first = await publish();
    const dup = await h.request<{ details: { reason: string } }>('POST', ADM, {
      ...asAdmin,
      body: { key: 'launch.assistant', brand: 'roboapply', locales: ['en'], content: { en: text('A') } },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.details.reason).toBe('key_taken');

    await h.request('POST', ADM, { ...asAdmin, body: { key: 'cn.note', brand: 'goapply', locales: ['zh'], content: { zh: text('通知') } } });
    const all = await h.request<{ data: { items: AdminAnnouncementView[] } }>('GET', ADM, asAdmin);
    expect(all.body.data.items).toHaveLength(2);
    const cn = await h.request<{ data: { items: AdminAnnouncementView[] } }>('GET', `${ADM}?brand=goapply`, asAdmin);
    expect(cn.body.data.items.map((i) => i.key)).toEqual(['cn.note']);
    const live = await h.request<{ data: { items: AdminAnnouncementView[] } }>('GET', `${ADM}?active=true`, asAdmin);
    expect(live.body.data.items.map((i) => i.key)).toEqual(['launch.assistant']);

    expect((await h.request('DELETE', `${ADM}/${first.id}`, asAdmin)).status).toBe(200);
    expect((await h.request('DELETE', `${ADM}/${first.id}`, asAdmin)).status).toBe(404);
    expect((await h.request('PATCH', `${ADM}/nope`, { ...asAdmin, body: { active: false } })).status).toBe(404);
  });

  it('seeker: one announcement in the person’s language, shown once, copied to the inbox the first time', async () => {
    const a = await publish();
    const first = await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next?locale=ja`, as('u1'));
    expect(first.body.data.announcement).toMatchObject({ id: a.id, title: 'New (ja)' });

    expect((await h.request('POST', `${A}/${a.id}/seen?locale=ja`, as('u1'))).status).toBe(200);
    expect((await h.request('POST', `${A}/${a.id}/seen?locale=ja`, as('u1'))).status).toBe(200);
    expect(inbox).toEqual([{ userId: 'u1', title: 'New (ja)', id: a.id }]);
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('u1'))).body.data.announcement).toBeNull();
    // Another person still sees it; the locale falls back to the brand default.
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next?locale=xx`, as('u2'))).body.data.announcement?.title).toBe('New (en)');
    // Unknown id, or another brand's announcement → 404.
    expect((await h.request('POST', `${A}/nope/seen`, as('u1'))).status).toBe(404);
    expect((await h.request('POST', `${A}/${a.id}/seen`, as('u1', 'goapply.localhost:3621'))).status).toBe(404);
  });

  it('seeker: per brand and cohort, and nothing while the 24 h popup budget is spent', async () => {
    await publish({ cohort: { plans: ['pro'] } });
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('u1'))).body.data.announcement).toBeNull();
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('pro1'))).body.data.announcement).not.toBeNull();
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('pro1', 'goapply.localhost:3621'))).body.data.announcement).toBeNull();

    uiState.set('pro1', { announcementsSeen: [], popupLastShownAt: new Date(T0.getTime() - 2 * HOUR).toISOString() });
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('pro1'))).body.data.announcement).toBeNull();
    uiState.set('pro1', { announcementsSeen: [], popupLastShownAt: new Date(T0.getTime() - 25 * HOUR).toISOString() });
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('pro1'))).body.data.announcement).not.toBeNull();
  });

  it('seeker: drafts and ended announcements never show', async () => {
    await publish({ active: false, key: 'draft.one' });
    await publish({ key: 'ended.one', startsAt: new Date(T0.getTime() - 48 * HOUR).toISOString(), endsAt: new Date(T0.getTime() - HOUR).toISOString() });
    expect((await h.request<{ data: NextAnnouncementResponse }>('GET', `${A}/next`, as('u1'))).body.data.announcement).toBeNull();
  });

  it('seeker: marking a draft, scheduled, ended or other-language announcement seen is 404 and writes nothing', async () => {
    const draft = await publish({ active: false, key: 'draft.two', locales: ['en'], content: { en: text('Secret') } });
    const scheduled = await publish({ key: 'sched.one', startsAt: new Date(T0.getTime() + 2 * HOUR).toISOString() });
    const ended = await publish({ key: 'ended.two', startsAt: new Date(T0.getTime() - 48 * HOUR).toISOString(), endsAt: new Date(T0.getTime() - HOUR).toISOString() });
    const jaOnly = await publish({ key: 'ja.only', locales: ['ja'] });
    for (const id of [draft.id, scheduled.id, ended.id]) {
      expect((await h.request('POST', `${A}/${id}/seen`, as('u1'))).status).toBe(404);
    }
    expect((await h.request('POST', `${A}/${jaOnly.id}/seen?locale=en`, as('u1'))).status).toBe(404);
    expect(inbox).toEqual([]);
    expect(uiState.get('u1')).toBeUndefined();
    // The same ja-only one, in Japanese, is live for this person.
    expect((await h.request('POST', `${A}/${jaOnly.id}/seen?locale=ja`, as('u1'))).status).toBe(200);
    expect(inbox).toEqual([{ userId: 'u1', title: 'New (ja)', id: jaOnly.id }]);
  });
});
