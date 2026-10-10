// @vitest-environment node
//
// WP-72 service tests: the roster lists only real, listed, reachable coaches
// of the current site; a booking request is emailed to the coach (Reply-To:
// the user) and staff and nothing is stored or charged; no invented ratings;
// staff cannot list a coach nobody can reach.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { getBrand } from '../../platform/brand/registry.js';
import type { SendEmailInput, SendEmailResult } from '../../platform/email/index.js';
import { HttpError } from '../../platform/http.js';
import {
  coachingAdminAddress,
  createCoachingService,
  matchesQuery,
  normalizeRates,
  sessionOptions,
  type CoachingDb,
} from './service.js';
import { CoachBodySchema, CoachRatesSchema, CoachRequestBodySchema, PatchCoachBodySchema } from './contract.js';
import { COACHING_BOOKING_REQUEST_TEMPLATE } from '../../platform/email/templates/coaching/index.js';
import { coachingService } from './index.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');

function coach(extra: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    userId: null,
    brand: 'roboapply',
    displayName: 'Dana Lee',
    headline: 'Former recruiter, tech hiring',
    bio: 'Ran hiring for two startups.',
    photoUrl: null,
    languages: ['en', 'zh-TW'],
    specialties: ['Interview practice', 'Resume review'],
    sessionLengths: [60, 30],
    rates: { currency: 'USD', '30': 4000 },
    bookingUrl: null,
    requestEmail: 'dana@coach.example.test',
    introVideoUrl: null,
    active: true,
    status: 'approved',
    approvedAt: NOW,
    approvedBy: 'admin1',
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

let db: ReturnType<typeof createFakePrisma>;
let sent: SendEmailInput<Record<string, unknown>>[];
let sendResult: (input: SendEmailInput<Record<string, unknown>>) => SendEmailResult;

function svc(env: Record<string, string> = {}) {
  return createCoachingService({
    db: db as unknown as CoachingDb,
    env,
    send: async (input) => {
      sent.push(input);
      return sendResult(input);
    },
  });
}

beforeEach(() => {
  sent = [];
  sendResult = () => ({ status: 'sent', provider: 'fake' });
  db = createFakePrisma({
    seed: {
      rACoach: [
        coach(),
        coach({ id: 'c2', displayName: 'Ana Ruiz', bookingUrl: 'https://cal.example.test/ana', requestEmail: null, languages: ['es'], specialties: ['Career change'] }),
        coach({ id: 'c3', displayName: 'Hidden Coach', active: false }),
        coach({ id: 'c4', displayName: 'Unreachable', requestEmail: null, bookingUrl: null }),
        coach({ id: 'c5', displayName: '王老师', brand: 'goapply', languages: ['zh'] }),
      ],
      user: [
        { id: 'u1', email: 'sam@example.test', emailVerified: true, brand: 'roboapply' },
        { id: 'u2', email: 'pending@example.test', emailVerified: false, brand: 'roboapply' },
        { id: 'gu1', email: '13800000000@phone.invalid', emailVerified: true, brand: 'goapply' },
        { id: 'user_9', email: 'coach9@example.test', emailVerified: true, brand: 'roboapply' },
        { id: 'user_ga', email: 'coachga@example.test', emailVerified: true, brand: 'goapply' },
      ],
    },
    uniqueFields: { rACoach: ['userId'] },
  });
});

describe('pure helpers', () => {
  it('normalizes rates and never turns a missing price into 0', () => {
    expect(normalizeRates({})).toBeNull();
    expect(normalizeRates(null)).toBeNull();
    expect(normalizeRates({ '30': 4000 })).toBeNull(); // no currency → nothing listed
    expect(normalizeRates({ currency: 'USD', '30': 4000, junk: 'x', '60': -1 })).toEqual({ currency: 'USD', '30': 4000 });
    expect(sessionOptions([60, 30, 30], { currency: 'USD', '30': 4000 })).toEqual([
      { minutes: 30, amountMinor: 4000, currency: 'USD' },
      { minutes: 60, amountMinor: null, currency: null },
    ]);
    expect(sessionOptions([45], null)).toEqual([{ minutes: 45, amountMinor: null, currency: null }]);
  });

  it('filters by specialty and language (primary subtag)', () => {
    const v = { specialties: ['Interview practice'], languages: ['zh-TW'] };
    expect(matchesQuery(v, { specialty: 'interview practice' })).toBe(true);
    expect(matchesQuery(v, { specialty: 'Negotiation' })).toBe(false);
    expect(matchesQuery(v, { language: 'zh' })).toBe(true);
    expect(matchesQuery(v, { language: 'ja' })).toBe(false);
    expect(matchesQuery(v, {})).toBe(true);
  });

  it('staff copy goes to COACHING_ADMIN_EMAIL per brand, else the support inbox', () => {
    const ra = getBrand('roboapply');
    const ga = getBrand('goapply');
    expect(coachingAdminAddress(ra, { COACHING_ADMIN_EMAIL: 'Coaches <coaches@ra.example.test>' })).toBe('coaches@ra.example.test');
    expect(coachingAdminAddress(ra, { SUPPORT_EMAIL: 'help@ra.example.test' })).toBe('help@ra.example.test');
    expect(coachingAdminAddress(ra, {})).toBe(ra.email.replyTo);
    // Mailboxes are identity: they never cross brands, whatever else GoApply shares (parity plan P3).
    expect(coachingAdminAddress(ga, { COACHING_ADMIN_EMAIL: 'coaches@ra.example.test' })).toBe(ga.email.replyTo);
    expect(coachingAdminAddress(ga, { SUPPORT_EMAIL: 'help@ra.example.test' })).toBe(ga.email.replyTo);
    expect(coachingAdminAddress(ga, { COACHING_ADMIN_EMAIL: 'coaches@ra.example.test', SUPPORT_EMAIL: 'help@ra.example.test', RESEND_API_KEY: 're_test' })).toBe(ga.email.replyTo);
    // GoApply's own order: CN_COACHING_ADMIN_EMAIL, else CN_SUPPORT_EMAIL, else its registry reply-to.
    expect(coachingAdminAddress(ga, { CN_COACHING_ADMIN_EMAIL: 'coach@ga.example.test', CN_SUPPORT_EMAIL: 'help@ga.example.test' })).toBe('coach@ga.example.test');
    expect(coachingAdminAddress(ga, { CN_SUPPORT_EMAIL: '客服 <help@ga.example.test>', SUPPORT_EMAIL: 'help@ra.example.test' })).toBe('help@ga.example.test');
    expect(coachingAdminAddress(ga, {})).toBe(ga.email.replyTo);
    expect(ga.email.replyTo).not.toBe(ra.email.replyTo);
    // And GoApply's values never reach RoboApply.
    expect(coachingAdminAddress(ra, { CN_COACHING_ADMIN_EMAIL: 'coach@ga.example.test', CN_SUPPORT_EMAIL: 'help@ga.example.test' })).toBe(ra.email.replyTo);
  });

  it('schemas: http(s) links only, rate keys are minutes, request body is strict', () => {
    const base = { brand: 'roboapply', displayName: 'A', headline: 'B', bio: 'C', listingConsent: true };
    // Staff must attest the person agreed to be listed (create only).
    const { listingConsent: _omit, ...noConsent } = base;
    void _omit;
    expect(CoachBodySchema.safeParse(noConsent).success).toBe(false);
    expect(CoachBodySchema.safeParse({ ...base, listingConsent: false }).success).toBe(false);
    expect(PatchCoachBodySchema.safeParse({ listingConsent: true }).success).toBe(false);
    expect(CoachBodySchema.safeParse({ ...base, bookingUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(CoachBodySchema.safeParse({ ...base, photoUrl: 'data:image/png;base64,AA' }).success).toBe(false);
    expect(CoachBodySchema.safeParse({ ...base, bookingUrl: 'https://cal.example.test/a' }).success).toBe(true);
    expect(CoachRatesSchema.safeParse({ currency: 'USD', '30': 4000 }).success).toBe(true);
    expect(CoachRatesSchema.safeParse({ currency: 'USD', thirty: 4000 }).success).toBe(false);
    expect(CoachRatesSchema.safeParse({ currency: 'USD', '30': '40' }).success).toBe(false);
    expect(PatchCoachBodySchema.safeParse({ bookingUrl: null, active: true }).success).toBe(true);
    expect(CoachRequestBodySchema.safeParse({ topic: 'x', contactEmail: 'u@example.test', resumeVariantId: 'r1' }).success).toBe(false);
  });
});

describe('listing', () => {
  it('lists only active, reachable coaches of the requested brand, sorted by name', async () => {
    const { items } = await svc().listActive('roboapply');
    expect(items.map((c) => c.id)).toEqual(['c2', 'c1']);
    const goapply = await svc().listActive('goapply');
    expect(goapply.items.map((c) => c.id)).toEqual(['c5']);
  });

  it('never invents a rating, never exposes the coach email, and names the booking mode', async () => {
    const { items } = await svc().listActive('roboapply');
    for (const c of items) {
      expect(c.rating).toBeNull();
      expect(JSON.stringify(c)).not.toContain('@coach.example.test');
    }
    expect(items.find((c) => c.id === 'c1')!.booking).toBe('request');
    expect(items.find((c) => c.id === 'c2')!.booking).toBe('link');
    expect(items.find((c) => c.id === 'c1')!.sessions).toEqual([
      { minutes: 30, amountMinor: 4000, currency: 'USD' },
      { minutes: 60, amountMinor: null, currency: null },
    ]);
  });

  it('filters by specialty and language', async () => {
    expect((await svc().listActive('roboapply', { language: 'es' })).items.map((c) => c.id)).toEqual(['c2']);
    expect((await svc().listActive('roboapply', { specialty: 'Resume review' })).items.map((c) => c.id)).toEqual(['c1']);
  });

  it('get answers 404 for unlisted, unreachable or other-brand coaches', async () => {
    expect((await svc().get('roboapply', 'c1')).displayName).toBe('Dana Lee');
    for (const [brand, id] of [['roboapply', 'c3'], ['roboapply', 'c4'], ['roboapply', 'c5'], ['goapply', 'c1'], ['roboapply', 'nope']] as const) {
      await expect(svc().get(brand, id)).rejects.toMatchObject({ code: 'not_found', details: { reason: 'coach_not_found' } });
    }
  });

  it('hasActiveCoaches follows the listing rule (empty roster → false)', async () => {
    expect(await svc().hasActiveCoaches('roboapply')).toBe(true);
    expect(await svc().hasActiveCoaches('goapply')).toBe(true);
    db = createFakePrisma({ seed: { rACoach: [coach({ active: false }), coach({ id: 'x', requestEmail: null })] } });
    expect(await svc().hasActiveCoaches('roboapply')).toBe(false);
    db = createFakePrisma();
    expect(await svc().hasActiveCoaches('roboapply')).toBe(false);
  });
});

describe('booking request', () => {
  const body = { name: 'Sam', topic: 'Mock interview for a PM role', message: 'Two interviews next week.', durationMin: 30, preferredTimes: 'Weekday evenings', contactEmail: 'sam@example.test' };

  it('emails the coach (Reply-To the user) and a staff copy; stores nothing', async () => {
    const before = (await db.rACoach.findMany({})).length;
    await expect(svc({ COACHING_ADMIN_EMAIL: 'coaches@ra.example.test' }).request('roboapply', { userId: 'u1' }, 'c1', body)).resolves.toEqual({ received: true });
    expect(sent).toHaveLength(2);
    const [toCoach, toAdmin] = sent;
    expect(toCoach).toMatchObject({ template: COACHING_BOOKING_REQUEST_TEMPLATE, to: 'dana@coach.example.test', replyTo: 'sam@example.test', userId: null });
    expect(toCoach!.params).toMatchObject({ audience: 'coach', coachName: 'Dana Lee', requesterName: 'Sam', topic: body.topic, durationMin: 30 });
    expect(toCoach!.params).not.toHaveProperty('requesterUserId');
    // The reply address is the requester's own verified account email.
    expect(toCoach!.params).toMatchObject({ replyEmailVerified: true });
    expect(toAdmin).toMatchObject({ to: 'coaches@ra.example.test', replyTo: 'sam@example.test' });
    expect(toAdmin!.params).toMatchObject({ audience: 'admin', coachId: 'c1', requesterUserId: 'u1' });
    expect((toCoach!.brand as { id: string }).id).toBe('roboapply');
    expect((await db.rACoach.findMany({})).length).toBe(before);
  });

  it('a reply address that is not the verified account email is marked unverified', async () => {
    await svc().request('roboapply', { userId: 'u1' }, 'c1', { ...body, contactEmail: 'someone-else@example.test' });
    expect(sent[0]!.params).toMatchObject({ replyEmailVerified: false, replyEmail: 'someone-else@example.test' });
    sent = [];
    await svc().request('roboapply', { userId: 'u1' }, 'c1', { ...body, contactEmail: 'SAM@example.test' });
    expect(sent[0]!.params).toMatchObject({ replyEmailVerified: true });
    sent = [];
    // An unverified account email, or no account row, is not vouched for.
    await svc().request('roboapply', { userId: 'u2' }, 'c1', { ...body, contactEmail: 'pending@example.test' });
    await svc().request('roboapply', { userId: 'nobody' }, 'c1', body);
    expect(sent.filter((m) => (m.params as { audience: string }).audience === 'coach').map((m) => (m.params as { replyEmailVerified: boolean }).replyEmailVerified)).toEqual([false, false]);
  });

  it('GoApply needs the separate consent to share with the coach (422 share_consent_required)', async () => {
    const gaBody = { topic: '模拟面试', contactEmail: 'me@example.test' };
    await expect(svc().request('goapply', { userId: 'gu1' }, 'c5', gaBody)).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'share_consent_required' },
    });
    expect(sent).toHaveLength(0);
    await expect(svc().request('goapply', { userId: 'gu1' }, 'c5', { ...gaBody, shareConsent: true })).resolves.toEqual({ received: true });
    // A phone-only account's placeholder address never counts as verified.
    expect(sent[0]!.params).toMatchObject({ replyEmailVerified: false });
    // With only the shared stack configured the staff copy still goes to a GoApply mailbox.
    const staff = sent.find((m) => (m.params as { audience: string }).audience === 'admin')!;
    expect((staff as unknown as { to: string }).to).toBe(getBrand('goapply').email.replyTo);
    sent = [];
    await expect(svc({ CN_SUPPORT_EMAIL: 'help@ga.example.test', SUPPORT_EMAIL: 'help@ra.example.test' }).request('goapply', { userId: 'gu1' }, 'c5', { ...gaBody, shareConsent: true })).resolves.toEqual({ received: true });
    expect((sent.find((m) => (m.params as { audience: string }).audience === 'admin') as unknown as { to: string }).to).toBe('help@ga.example.test');
    // RoboApply does not ask for it.
    sent = [];
    await expect(svc().request('roboapply', { userId: 'u1' }, 'c1', body)).resolves.toEqual({ received: true });
  });

  it('a coach with a booking page is booked there (409 use_booking_link, no email)', async () => {
    await expect(svc().request('roboapply', { userId: 'u1' }, 'c2', body)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'use_booking_link', bookingUrl: 'https://cal.example.test/ana' },
    });
    expect(sent).toHaveLength(0);
  });

  it('unlisted, other-brand and unknown coaches → 404; no email', async () => {
    for (const id of ['c3', 'c4', 'c5', 'zz']) {
      await expect(svc().request('roboapply', { userId: 'u1' }, id, body)).rejects.toBeInstanceOf(HttpError);
    }
    expect(sent).toHaveLength(0);
  });

  it('a session length the coach does not offer → 422 duration_not_offered', async () => {
    await expect(svc().request('roboapply', { userId: 'u1' }, 'c1', { ...body, durationMin: 45 })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'duration_not_offered' },
    });
    expect(sent).toHaveLength(0);
  });

  it('no email transport → 501 provider_not_configured (never claims it was sent)', async () => {
    sendResult = () => ({ status: 'suppressed', reason: 'transport_not_configured' });
    await expect(svc().request('roboapply', { userId: 'u1' }, 'c1', body)).rejects.toMatchObject({ code: 'provider_not_configured' });
    expect(sent).toHaveLength(1);
  });

  it('a failed coach email → 500; a failed staff copy alone still counts as received', async () => {
    sendResult = () => ({ status: 'failed', reason: 'boom' });
    await expect(svc().request('roboapply', { userId: 'u1' }, 'c1', body)).rejects.toMatchObject({ code: 'internal_error' });
    sent = [];
    sendResult = (input) => (input.to === 'dana@coach.example.test' ? { status: 'sent' } : { status: 'failed', reason: 'boom' });
    await expect(svc().request('roboapply', { userId: 'u1' }, 'c1', body)).resolves.toEqual({ received: true });
  });
});

describe('admin roster', () => {
  const base = CoachBodySchema.parse({ brand: 'roboapply', displayName: 'New Coach', headline: 'Coach', bio: 'Real bio.', listingConsent: true });

  it('lists every row with listing state and the private request address', async () => {
    const { items } = await svc().adminList();
    expect(items).toHaveLength(5);
    expect(items.find((c) => c.id === 'c3')).toMatchObject({ active: false, requestEmail: 'dana@coach.example.test', brand: 'roboapply' });
    expect((await svc().adminList({ brand: 'goapply' })).items.map((c) => c.id)).toEqual(['c5']);
    expect((await svc().adminList({ active: 'false' })).items.map((c) => c.id)).toEqual(['c3']);
  });

  it('creates approved rows; listing needs a booking path', async () => {
    await expect(svc().adminCreate('admin1', { ...base, active: true })).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'no_booking_path' } });
    const draft = await svc().adminCreate('admin1', base);
    expect(draft).toMatchObject({ active: false, status: 'approved', rating: null });
    const listed = await svc().adminCreate('admin1', { ...base, active: true, bookingUrl: 'https://cal.example.test/new', sessionLengths: [60, 30, 60] });
    expect(listed).toMatchObject({ active: true, booking: 'link', sessionLengths: [30, 60] });
  });

  it('updates with null clearing fields; refuses to leave a listed coach unreachable', async () => {
    await expect(svc().adminUpdate('admin1', 'c1', { requestEmail: null })).rejects.toMatchObject({ details: { reason: 'no_booking_path' } });
    const paused = await svc().adminUpdate('admin1', 'c1', { active: false, requestEmail: null });
    expect(paused).toMatchObject({ active: false, requestEmail: null });
    const relisted = await svc().adminUpdate('admin1', 'c1', { active: true, bookingUrl: 'https://cal.example.test/dana', rates: null });
    expect(relisted).toMatchObject({ active: true, booking: 'link', rates: null });
    await expect(svc().adminUpdate('admin1', 'missing', { headline: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a linked account can belong to one coach only (409)', async () => {
    await svc().adminCreate('admin1', { ...base, userId: 'user_9' });
    await expect(svc().adminCreate('admin1', { ...base, userId: 'user_9' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'coach_user_taken' } });
  });

  it('an unknown linked account → 422 coach_user_not_found; another site\'s account → 422 coach_user_wrong_brand', async () => {
    await expect(svc().adminCreate('admin1', { ...base, userId: 'ghost' })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'coach_user_not_found' },
    });
    await expect(svc().adminCreate('admin1', { ...base, userId: 'user_ga' })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'coach_user_wrong_brand' },
    });
    await expect(svc().adminUpdate('admin1', 'c1', { userId: 'ghost' })).rejects.toMatchObject({ details: { reason: 'coach_user_not_found' } });
    const linked = await svc().adminUpdate('admin1', 'c1', { userId: 'user_9' });
    expect(linked.userId).toBe('user_9');
    // Moving a linked coach to the other site is refused too.
    await expect(svc().adminUpdate('admin1', 'c1', { brand: 'goapply' })).rejects.toMatchObject({ details: { reason: 'coach_user_wrong_brand' } });
  });

  it('a foreign-key failure from the database (P2003) is a 422, not a 500', async () => {
    const fkDb = {
      rACoach: { ...db.rACoach, create: () => Promise.reject(Object.assign(new Error('fk'), { code: 'P2003' })) },
      user: { findUnique: async () => ({ id: 'raced', brand: 'roboapply' }) },
    };
    const s = createCoachingService({ db: fkDb as unknown as CoachingDb, send: async () => ({ status: 'sent' }) });
    await expect(s.adminCreate('admin1', { ...base, userId: 'raced' })).rejects.toMatchObject({
      code: 'invalid_request',
      details: { reason: 'coach_user_not_found' },
    });
  });

  it('deletes a roster row; 404 when missing', async () => {
    await svc().adminDelete('admin1', 'c3');
    expect((await svc().adminList()).items.map((c) => c.id)).not.toContain('c3');
    await expect(svc().adminDelete('admin1', 'c3')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('payments', () => {
  it('coaching never has a CN-rail payment purpose (no 二清)', async () => {
    const { CN_PURPOSES } = await import('../billing-cn/contract.js');
    expect(CN_PURPOSES).not.toContain('coaching');
    expect([...CN_PURPOSES].sort()).toEqual(['interview_pack', 'subscription']);
  });

  it('the cross-area surface delegates to the service', () => {
    expect(typeof coachingService.hasActiveCoaches).toBe('function');
  });
});
