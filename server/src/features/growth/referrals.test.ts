// @vitest-environment node
//
// WP-60: invite friends. No database and no network: Prisma is the in-memory
// fake; the credit grant, the queue, email and the flag check are injected.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import type { PracticeGrantResult } from '../../platform/credits/index.js';
import { getBrand } from '../../platform/brand/registry.js';
import { createEmailTranslator } from '../../platform/email/i18n.js';
import { referralRewardEmail } from '../../platform/email/templates/growth/index.js';
import { DeferWorkError, type LeasedWorkItem } from '../../platform/queue/index.js';
import type { RateLimitDb } from '../../platform/ratelimit/index.js';
import {
  INVITE_REWARD_CAP_PER_YEAR,
  REFERRAL_CODE_RE,
  createGrowthService,
  createInvitesAdminRouter,
  createInvitesRouter,
  createReferralService,
  createReferralWorker,
  createSignalPruneWorker,
  createDelegateSignalStore,
  inviteOrigin,
  INVITE_SIGNUP_WIRED_BRANDS,
  MAX_ROWS_PER_USER_PER_DAY,
  generateReferralCode,
  hashSignals,
  nextCheckDelayMs,
  normalizeEmailForReferral,
  normalizeIp,
  normalizeReferralCode,
  resolvePrismaSignalStore,
  scoreReferralRisk,
  type ReferralDb,
  type ReferralService,
  type ReferralSignalStore,
  type SignalRow,
} from './index.js';
import type { ReferralSignalDelegate } from './referralSignalStore.js';
import type { GrowthDb } from './service.js';
import { loadLegalDoc } from '../compliance/legalDocs.js';
import { sanitizeTouch } from './attribution.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ENV = { NODE_ENV: 'test', REFERRAL_SIGNAL_SECRET: 'test-secret' };
const DAY = 24 * HOUR;
/** Two different people's browsers and networks. */
const INVITER_BROWSER = { ip: '198.51.100.20', userAgent: 'UA-inviter', deviceId: 'anon_inviter01' };
const FRIEND_BROWSER = { ip: '203.0.113.50', userAgent: 'UA-friend', deviceId: 'anon_friend001' };

type Row = Record<string, unknown>;

function user(id: string, extra: Row = {}): Row {
  return {
    id,
    email: `${id}@example.test`,
    brand: 'roboapply',
    emailVerified: true,
    emailIsPlaceholder: false,
    phoneVerifiedAt: null,
    createdAt: new Date(NOW.getTime() - HOUR),
    ...extra,
  };
}

function profile(userId: string, onboardingStep = 'done'): Row {
  return { id: `p_${userId}`, userId, onboardingStep, locale: 'en' };
}

function fakeDb(seed: Record<string, Row[]> = {}) {
  return createFakePrisma({
    seed,
    uniqueFields: { rAReferralCode: ['userId', 'code'], rAReferral: ['inviteeUserId'], rAReferralSignal: [] },
    defaults: { rAReferral: { status: 'pending', riskScore: 0, riskReasons: [], qualifiedAt: null, rewardedAt: null } },
    timestampFields: ['createdAt'],
  });
}

function memorySignalStore(fake: ReturnType<typeof fakeDb>): ReferralSignalStore {
  return createDelegateSignalStore(fake.rAReferralSignal as unknown as ReferralSignalDelegate);
}

interface Harness {
  fake: ReturnType<typeof fakeDb>;
  service: ReferralService;
  grants: Array<{ userId: string; key: string }>;
  enqueued: Array<{ kind: string; payload: unknown; options: unknown }>;
  emails: Array<{ to: string; params: unknown }>;
  setNow: (d: Date) => void;
}

function setup(seed: Record<string, Row[]> = {}, opts: { signals?: 'memory' | 'none'; grant?: (userId: string, key: string) => PracticeGrantResult; enabled?: boolean } = {}): Harness {
  const fake = fakeDb(seed);
  const grants: Harness['grants'] = [];
  const keys = new Set<string>();
  const enqueued: Harness['enqueued'] = [];
  const emails: Harness['emails'] = [];
  let now = NOW;
  let seq = 0;
  const service = createReferralService({
    db: fake as unknown as ReferralDb,
    signalStore: opts.signals === 'none' ? null : memorySignalStore(fake),
    grantPracticeCredit: async (userId, _reason, key) => {
      if (opts.grant) return opts.grant(userId, key);
      if (keys.has(key)) return { status: 'already_granted', ledgerId: key, balanceAfter: null };
      keys.add(key);
      grants.push({ userId, key });
      return { status: 'granted', ledgerId: key, balanceAfter: 1 };
    },
    enqueue: async (kind, payload, options) => {
      enqueued.push({ kind, payload, options });
      return { id: 'w1' };
    },
    sendEmail: async (input) => {
      emails.push({ to: input.to, params: input.params });
      return { status: 'sent' };
    },
    invitesEnabled: async () => opts.enabled ?? true,
    randomBytes: (n) => {
      seq += 1;
      return Uint8Array.from({ length: n }, (_, i) => (i * 7 + seq * 13) % 256);
    },
    env: ENV,
    now: () => now,
  });
  return { fake, service, grants, enqueued, emails, setNow: (d) => (now = d) };
}

/** Inviter `a` (verified, code ABCDEFGH) and a fresh invitee `b`. */
function inviteSeed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    user: [user('a'), user('b'), ...(extra.user ?? [])],
    seekerProfile: [profile('a'), profile('b'), ...(extra.seekerProfile ?? [])],
    rAReferralCode: [{ userId: 'a', brand: 'roboapply', code: 'ABCDEFGH', createdAt: new Date(NOW.getTime() - 48 * HOUR) }],
    rAReferral: extra.rAReferral ?? [],
    rAAuthIdentity: extra.rAAuthIdentity ?? [],
    rAReferralSignal: extra.rAReferralSignal ?? [],
  };
}

async function referralOf(h: Harness, inviteeUserId = 'b'): Promise<Row> {
  return (await h.fake.rAReferral.findFirst({ where: { inviteeUserId } })) as Row;
}

// ── Codes ────────────────────────────────────────────────────────────────

describe('invite codes', () => {
  it('generates 8 Crockford base32 characters', () => {
    for (let i = 0; i < 50; i += 1) expect(generateReferralCode()).toMatch(REFERRAL_CODE_RE);
  });

  it('reads codes forgivingly and rejects anything else', () => {
    expect(normalizeReferralCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeReferralCode('ABCDEFGO')).toBe('ABCDEFG0');
    expect(normalizeReferralCode('ABCDEFGI')).toBe('ABCDEFG1');
    expect(normalizeReferralCode('abcdefgl')).toBe('ABCDEFG1');
    expect(normalizeReferralCode('ABCDEFGU')).toBeNull();
    expect(normalizeReferralCode('ABC')).toBeNull();
    expect(normalizeReferralCode(42)).toBeNull();
  });
});

// ── Risk ─────────────────────────────────────────────────────────────────

describe('risk signals and scoring', () => {
  it('hashes signals with a key and never stores raw values', () => {
    const h = hashSignals({ ip: '203.0.113.9', userAgent: 'Mozilla/5.0', deviceId: 'anon_12345678' }, ENV)!;
    expect(h.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(h)).not.toContain('203.0.113.9');
    expect(hashSignals({ ip: '203.0.113.9' }, { ...ENV, REFERRAL_SIGNAL_SECRET: 'other' })!.ipHash).not.toBe(h.ipHash);
    expect(hashSignals({ ip: '203.0.113.9' }, { NODE_ENV: 'production' })).toBeNull();
    expect(hashSignals({ ip: '203.0.113.9' }, { NODE_ENV: 'production', JWT_SECRET: 'j' })).not.toBeNull();
    expect(hashSignals({ ip: 'unknown', deviceId: 'x' }, ENV)).toBeNull();
  });

  it('reduces IPv6 to its /64 and unwraps mapped IPv4', () => {
    expect(normalizeIp('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(normalizeIp('not an ip')).toBeNull();
  });

  it('normalizes emails so the same person is recognised', () => {
    expect(normalizeEmailForReferral('J.Doe+jobs@Gmail.com')).toBe('jdoe@gmail.com');
    expect(normalizeEmailForReferral('jdoe@googlemail.com')).toBe('jdoe@gmail.com');
    expect(normalizeEmailForReferral('a.b+x@example.com')).toBe('a.b@example.com');
    expect(normalizeEmailForReferral('wx_1@users.goapply.invalid')).toBeNull();
  });

  const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
  const sig = (userId: string, h: number, s: Partial<SignalRow>): SignalRow => ({ userId, createdAt: at(h), ipHash: null, uaHash: null, deviceHash: null, ...s });
  const base = { inviterSignals: [] as SignalRow[], inviteeSignals: [] as SignalRow[], signalsAvailable: true, inviteeEmailDisposable: false, signupsOnLinkWithin24h: 1 };

  it('holds the same device at any time in the 30 days kept, the same network only within 24 hours', () => {
    // The same first-party browser id 3 days apart is still the same browser.
    expect(scoreReferralRisk({ ...base, inviterSignals: [sig('a', 0, { deviceHash: 'd' })], inviteeSignals: [sig('b', 72, { deviceHash: 'd' })] })).toMatchObject({
      hold: true,
      reasons: ['same_device'],
    });
    expect(scoreReferralRisk({ ...base, inviterSignals: [sig('a', 0, { deviceHash: 'd' })], inviteeSignals: [sig('b', 2, { deviceHash: 'd' })] })).toMatchObject({
      hold: true,
      reasons: ['same_device'],
    });
    expect(scoreReferralRisk({ ...base, inviterSignals: [sig('a', 0, { ipHash: 'i' })], inviteeSignals: [sig('b', 23, { ipHash: 'i' })] }).hold).toBe(true);
    // More than 24 hours apart: a shared office network a week later is not a signal.
    expect(scoreReferralRisk({ ...base, inviterSignals: [sig('a', 0, { ipHash: 'i' })], inviteeSignals: [sig('b', 30, { ipHash: 'i' })] }).hold).toBe(false);
  });

  it('a common browser build alone does not hold; a throwaway inbox or a burst does; missing signals fail closed', () => {
    expect(scoreReferralRisk({ ...base, inviterSignals: [sig('a', 0, { uaHash: 'u' })], inviteeSignals: [sig('b', 1, { uaHash: 'u' })] })).toMatchObject({
      hold: false,
      reasons: ['same_browser'],
    });
    const both = { inviterSignals: [sig('a', 0, { ipHash: 'x' })], inviteeSignals: [sig('b', 1, { ipHash: 'y' })] };
    expect(scoreReferralRisk({ ...base, ...both, inviteeEmailDisposable: true }).hold).toBe(true);
    expect(scoreReferralRisk({ ...base, ...both, signupsOnLinkWithin24h: 5 }).reasons).toEqual(['burst']);
    expect(scoreReferralRisk({ ...base, signalsAvailable: false })).toMatchObject({ hold: true, reasons: ['signals_unavailable'] });
    expect(scoreReferralRisk({ ...base, ...both })).toEqual({ score: 0, reasons: [], hold: false });
  });

  it('fails closed when either side has no stored rows (nothing to compare)', () => {
    expect(scoreReferralRisk(base)).toMatchObject({ hold: true, reasons: ['signals_missing'] });
    expect(scoreReferralRisk({ ...base, inviterSignals: [sig('a', 0, { ipHash: 'x' })] })).toMatchObject({ hold: true, reasons: ['signals_missing'] });
    expect(scoreReferralRisk({ ...base, inviteeSignals: [sig('b', 0, { ipHash: 'x' })] })).toMatchObject({ hold: true, reasons: ['signals_missing'] });
  });
});

// ── Signal store ─────────────────────────────────────────────────────────

describe('signal store', () => {
  it('stores the same hashes from one user once an hour and prunes by age', async () => {
    const fake = fakeDb();
    const store = memorySignalStore(fake);
    const signals = { ipHash: 'i', uaHash: 'u', deviceHash: null };
    expect(await store.record({ userId: 'a', brand: 'roboapply', signals, at: NOW })).toBe(true);
    expect(await store.record({ userId: 'a', brand: 'roboapply', signals, at: new Date(NOW.getTime() + 10 * 60 * 1000) })).toBe(false);
    expect(await store.record({ userId: 'a', brand: 'roboapply', signals, at: new Date(NOW.getTime() + 2 * HOUR) })).toBe(true);
    expect(await store.forUsers(['a'], new Date(0))).toHaveLength(2);
    expect(await store.oldestAt()).toEqual(NOW);
    expect(await store.prune(new Date(NOW.getTime() + HOUR))).toBe(1);
  });

  it('caps rows per user per day, and one user\'s rows never push another user\'s out', async () => {
    const fake = fakeDb({
      rAReferralSignal: Array.from({ length: 1600 }, (_, i) => ({
        id: `x${i}`,
        userId: 'a',
        brand: 'roboapply',
        ipHash: `i${i}`,
        uaHash: null,
        deviceHash: null,
        createdAt: new Date(NOW.getTime() - (i % 20) * HOUR),
      })),
    });
    const store = memorySignalStore(fake);
    expect(await store.record({ userId: 'a', brand: 'roboapply', signals: { ipHash: 'new', uaHash: null, deviceHash: null }, at: NOW })).toBe(false);
    await fake.rAReferralSignal.create({ data: { id: 'b1', userId: 'b', brand: 'roboapply', ipHash: 'old', uaHash: null, deviceHash: 'd', createdAt: new Date(NOW.getTime() - 2 * DAY) } });
    const rows = await store.forUsers(['a', 'b'], new Date(NOW.getTime() - 30 * DAY));
    expect(rows.filter((r) => r.userId === 'b')).toHaveLength(1);

    const fresh = memorySignalStore(fakeDb());
    for (let i = 0; i < MAX_ROWS_PER_USER_PER_DAY + 10; i += 1) {
      await fresh.record({ userId: 'u', brand: 'roboapply', signals: { ipHash: null, uaHash: `ua${i}`, deviceHash: null }, at: new Date(NOW.getTime() + i * 1000) });
    }
    expect(await fresh.forUsers(['u'], new Date(0))).toHaveLength(MAX_ROWS_PER_USER_PER_DAY);
  });

  it('is unavailable until the model is generated (SR-60-1)', () => {
    expect(resolvePrismaSignalStore({})).toBeNull();
    expect(resolvePrismaSignalStore(null)).toBeNull();
    expect(resolvePrismaSignalStore({ rAReferralSignal: fakeDb().rAReferralSignal })).not.toBeNull();
  });

  it.todo('SR-60-1: record/forUsers/prune against the real RAReferralSignal table (after SCHEMA-5 generates the model)');
});

// ── The inviter's page ───────────────────────────────────────────────────

describe('getInvites', () => {
  it('shows no link until the inviter is verified, and creates no code', async () => {
    const h = setup({ user: [user('u', { emailVerified: false })] });
    const res = await h.service.getInvites('u', { brand: 'roboapply' });
    expect(res).toMatchObject({ eligibility: 'verify_account', code: null, link: null, reward: { bucket: 'practice', credits: 1 } });
    expect(await h.fake.rAReferralCode.count({})).toBe(0);
  });

  it('a Google sign-in or a verified phone counts as verified', async () => {
    const h = setup({
      user: [user('g', { emailVerified: false }), user('p', { emailVerified: false, phoneVerifiedAt: NOW })],
      rAAuthIdentity: [{ id: 'i1', userId: 'g', brand: 'roboapply', provider: 'google', subject: 's' }],
    });
    expect((await h.service.getInvites('g', { brand: 'roboapply' })).eligibility).toBe('ok');
    expect((await h.service.getInvites('p', { brand: 'roboapply' })).eligibility).toBe('ok');
  });

  it('retries when a new code collides with an existing one', async () => {
    const h = setup({ user: [user('u')], rAReferralCode: [] });
    const fixed = createReferralService({
      db: h.fake as unknown as ReferralDb,
      signalStore: null,
      randomBytes: (n) => new Uint8Array(n),
      env: ENV,
      now: () => NOW,
    });
    await h.fake.rAReferralCode.create({ data: { userId: 'other', brand: 'roboapply', code: '00000000' } });
    await expect(fixed.getInvites('u', { brand: 'roboapply' })).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('creates one code per person and returns the same link afterwards', async () => {
    const h = setup({ user: [user('u')] });
    const first = await h.service.getInvites('u', { brand: 'roboapply', signals: { ip: '203.0.113.1' } });
    expect(first.eligibility).toBe('ok');
    expect(first.code).toMatch(REFERRAL_CODE_RE);
    expect(first.path).toBe(`/r/${first.code}`);
    expect(first.link).toBe(`https://www.roboapply.io/r/${first.code}`);
    const again = await h.service.getInvites('u', { brand: 'roboapply' });
    expect(again.code).toBe(first.code);
    expect(await h.fake.rAReferralCode.count({})).toBe(1);
    expect(await h.fake.rAReferralSignal.count({ where: { userId: 'u' } })).toBe(1);
  });

  it('uses the GoApply origin and lists friends without naming them', async () => {
    const h = setup(
      inviteSeed({
        rAReferral: [
          { id: 'r1', brand: 'roboapply', inviterUserId: 'a', inviteeUserId: 'x1', status: 'rewarded', rewardedAt: NOW, createdAt: new Date(NOW.getTime() - 3 * HOUR) },
          { id: 'r2', brand: 'roboapply', inviterUserId: 'a', inviteeUserId: 'x2', status: 'held', createdAt: new Date(NOW.getTime() - 2 * HOUR) },
          { id: 'r3', brand: 'roboapply', inviterUserId: 'a', inviteeUserId: 'x3', status: 'rejected', createdAt: new Date(NOW.getTime() - HOUR) },
        ],
      }),
    );
    const res = await h.service.getInvites('a', { brand: 'roboapply' });
    expect(res.invites.map((i) => i.status)).toEqual(['not_counted', 'checking', 'rewarded']);
    expect(JSON.stringify(res.invites)).not.toMatch(/x1|x2|x3|example\.test/);
    expect(res.rewards).toEqual({ granted: 1, capPerYear: INVITE_REWARD_CAP_PER_YEAR, year: 2026 });

    expect(inviteOrigin('goapply', {})).toBe('https://www.goapply.top');
  });

  it('GoApply answers not_available until every GoApply sign-up path attaches invites (R-60-3)', async () => {
    expect(INVITE_SIGNUP_WIRED_BRANDS).toEqual(['roboapply']);
    const go = setup({ user: [user('g', { brand: 'goapply' })] });
    expect(await go.service.getInvites('g', { brand: 'goapply' })).toMatchObject({ eligibility: 'not_available', code: null, link: null });
    expect(await go.fake.rAReferralCode.count({})).toBe(0);
    // A GoApply code made earlier attaches nothing.
    const h = setup({
      user: [user('ga', { brand: 'goapply' }), user('gb', { brand: 'goapply' })],
      rAReferralCode: [{ userId: 'ga', brand: 'goapply', code: 'GGGGGGGG', createdAt: NOW }],
    });
    expect(await h.service.attachFromSignup('gb', 'GGGGGGGG')).toEqual({ status: 'skipped', reason: 'disabled' });
  });

  it.todo('R-60-3: a GoApply phone OTP / WeChat sign-up carrying ref creates an RAReferral (auth-cn seam, after INT wires it)');
});

// ── Signup ───────────────────────────────────────────────────────────────

describe('attachFromSignup', () => {
  it('creates a pending referral and queues one check', async () => {
    const h = setup(inviteSeed());
    const res = await h.service.attachFromSignup('b', 'abcd-efgh', { signals: { ip: '198.51.100.7', userAgent: 'UA' } });
    expect(res.status).toBe('created');
    expect(await referralOf(h)).toMatchObject({ inviterUserId: 'a', status: 'pending', brand: 'roboapply' });
    expect(h.enqueued).toEqual([
      // the first stored signal row schedules the 30-day deletion
      { kind: 'growth.referralSignalPrune', payload: {}, options: expect.objectContaining({ dedupeKey: 'growth.referralSignalPrune:roboapply', delayMs: 30 * DAY + HOUR, onConflict: 'requeue' }) },
      { kind: 'growth.referralRisk', payload: { referralId: (res as { referralId: string }).referralId }, options: expect.objectContaining({ dedupeKey: expect.stringMatching(/^growth\.referral:/), brand: 'roboapply', userId: 'b' }) },
    ]);
    expect(await h.fake.rAReferralSignal.count({ where: { userId: 'b' } })).toBe(1);
  });

  it('blocks self-invites and the same person under another address', async () => {
    const h = setup(inviteSeed({ user: [user('c', { email: 'A+second@example.test' })] }));
    expect(await h.service.attachFromSignup('a', 'ABCDEFGH')).toEqual({ status: 'skipped', reason: 'self' });
    // inviter a@example.test vs A+second@example.test → same mailbox
    const same = await h.service.attachFromSignup('c', 'ABCDEFGH');
    expect(same).toMatchObject({ status: 'rejected', reason: 'same_person' });
    expect(await referralOf(h, 'c')).toMatchObject({ status: 'rejected', riskReasons: ['same_person'] });
    expect(h.enqueued).toEqual([]);
  });

  it('ignores bad codes, the other brand, old accounts, a second code and a switched-off programme', async () => {
    const h = setup(
      inviteSeed({
        user: [user('old', { createdAt: new Date(NOW.getTime() - 3 * 24 * HOUR) }), user('cn', { brand: 'goapply' })],
      }),
    );
    expect(await h.service.attachFromSignup('b', 'nope')).toEqual({ status: 'skipped', reason: 'invalid_code' });
    expect(await h.service.attachFromSignup('b', 'ZZZZZZZZ')).toEqual({ status: 'skipped', reason: 'unknown_code' });
    expect(await h.service.attachFromSignup('cn', 'ABCDEFGH')).toEqual({ status: 'skipped', reason: 'other_brand' });
    expect(await h.service.attachFromSignup('old', 'ABCDEFGH')).toEqual({ status: 'skipped', reason: 'not_new' });
    expect((await h.service.attachFromSignup('b', 'ABCDEFGH')).status).toBe('created');
    expect(await h.service.attachFromSignup('b', 'ABCDEFGH')).toEqual({ status: 'skipped', reason: 'exists' });
    const off = setup(inviteSeed(), { enabled: false });
    expect(await off.service.attachFromSignup('b', 'ABCDEFGH')).toEqual({ status: 'skipped', reason: 'disabled' });
  });

  it('signup attribution (recordAttribution) attaches the invite code, even without analytics consent', async () => {
    const attach = vi.fn(async () => ({ status: 'created' as const, referralId: 'r' }));
    const fake = createFakePrisma({ uniqueFields: { rAAttribution: ['userId'] } });
    const growth = createGrowthService({ db: fake as unknown as GrowthDb, attachReferral: attach, now: () => NOW });
    await growth.recordAttribution('b', { ref: 'ABCDEFGH', utmSource: 'x', at: NOW.toISOString() }, { signals: { ip: '1.2.3.4' } });
    expect(attach).toHaveBeenCalledWith('b', 'ABCDEFGH', { signals: { ip: '1.2.3.4' } });
    // a later visit (lastTouch) never attaches
    await growth.recordAttribution('b', { inviteCode: 'ABCDEFGH', at: NOW.toISOString() }, { lastTouchOnly: true });
    expect(attach).toHaveBeenCalledTimes(1);
    // an attach failure never breaks the signup
    const failing = createGrowthService({ db: createFakePrisma() as unknown as GrowthDb, attachReferral: async () => Promise.reject(new Error('boom')), now: () => NOW });
    await expect(failing.recordAttribution('z', { ref: 'ABCDEFGH', at: NOW.toISOString() })).resolves.toBeUndefined();
  });

  it('a marketing `ref` never hides a real invite code', async () => {
    const attach = vi.fn(async () => ({ status: 'created' as const, referralId: 'r' }));
    const growth = createGrowthService({ db: createFakePrisma({ uniqueFields: { rAAttribution: ['userId'] } }) as unknown as GrowthDb, attachReferral: attach, now: () => NOW });
    await growth.recordAttribution('b', { ref: 'newsletter', inviteCode: 'abcd-efgh', at: NOW.toISOString() });
    expect(attach).toHaveBeenCalledWith('b', 'abcd-efgh', { signals: undefined });
    await growth.recordAttribution('c', { ref: 'newsletter', at: NOW.toISOString() });
    expect(attach).toHaveBeenCalledTimes(1);
  });
});

// ── Qualification and rewards ────────────────────────────────────────────

describe('evaluateReferral', () => {
  /** The inviter opened /invite and the friend signed up, each from their own browser. */
  async function attached(h: Harness): Promise<string> {
    await h.service.getInvites('a', { brand: 'roboapply', signals: INVITER_BROWSER });
    const res = await h.service.attachFromSignup('b', 'ABCDEFGH', { signals: FRIEND_BROWSER });
    return (res as { referralId: string }).referralId;
  }

  it('waits until the friend is verified and has finished setup', async () => {
    const h = setup({
      ...inviteSeed(),
      user: [user('a'), user('b', { emailVerified: false })],
      seekerProfile: [profile('a'), profile('b', 'resume')],
    });
    const id = await attached(h);
    expect(await h.service.evaluateReferral(id)).toBe('waiting');
    await h.fake.user.update({ where: { id: 'b' }, data: { emailVerified: true } });
    expect(await h.service.evaluateReferral(id)).toBe('waiting');
    await h.fake.seekerProfile.updateMany({ where: { userId: 'b' }, data: { onboardingStep: 'done' } });
    expect(await h.service.evaluateReferral(id)).toBe('rewarded');
  });

  it('grants one practice credit to each side, once, and emails both', async () => {
    const h = setup(inviteSeed());
    const id = await attached(h);
    expect(await h.service.evaluateReferral(id)).toBe('rewarded');
    expect(h.grants).toEqual([
      { userId: 'b', key: 'referral_invitee:b' },
      { userId: 'a', key: `referral_inviter:${id}` },
    ]);
    expect(await referralOf(h)).toMatchObject({ status: 'rewarded', rewardedAt: NOW, qualifiedAt: NOW });
    expect(h.emails.map((e) => [e.to, (e.params as { role: string }).role])).toEqual([
      ['b@example.test', 'invitee'],
      ['a@example.test', 'inviter'],
    ]);
    // Idempotent: a retry, the worker and the friend's activity all land on 'done'.
    expect(await h.service.evaluateReferral(id)).toBe('done');
    expect(await h.service.checkReferralFor('b')).toBe('done');
    expect(h.grants).toHaveLength(2);
    expect(h.emails).toHaveLength(2);
  });

  it('holds same-device signups for review and grants nothing', async () => {
    const h = setup(inviteSeed());
    const device = { ip: '198.51.100.20', userAgent: 'UA-1', deviceId: 'anon_samebrowser' };
    await h.service.getInvites('a', { brand: 'roboapply', signals: device });
    await h.service.attachFromSignup('b', 'ABCDEFGH', { signals: { ...device, ip: '203.0.113.50' } });
    const id = String((await referralOf(h)).id);
    expect(await h.service.evaluateReferral(id)).toBe('held');
    expect(await referralOf(h)).toMatchObject({ status: 'held', riskReasons: ['same_device', 'same_browser'], riskScore: 120 });
    expect(h.grants).toEqual([]);
    expect(await h.service.evaluateReferral(id)).toBe('done');
    expect((await h.service.getInvites('a', { brand: 'roboapply' })).invites[0]!.status).toBe('checking');
  });

  it('holds the same device even when the friend signs up days after the inviter copied the link', async () => {
    const h = setup(inviteSeed());
    await h.service.getInvites('a', { brand: 'roboapply', signals: { ...INVITER_BROWSER, deviceId: 'anon_samebrowser' } });
    h.setNow(new Date(NOW.getTime() + 3 * DAY));
    await h.fake.user.update({ where: { id: 'b' }, data: { createdAt: new Date(NOW.getTime() + 3 * DAY - HOUR) } });
    await h.service.attachFromSignup('b', 'ABCDEFGH', { signals: { ...FRIEND_BROWSER, deviceId: 'anon_samebrowser' } });
    expect(await h.service.evaluateReferral(String((await referralOf(h)).id))).toBe('held');
    expect(await referralOf(h)).toMatchObject({ status: 'held', riskReasons: ['same_device'] });
    expect(h.grants).toEqual([]);
  });

  it('a friend with no stored signals waits for them, then is held after 7 days (never rewarded blind)', async () => {
    const h = setup(inviteSeed());
    await h.service.getInvites('a', { brand: 'roboapply', signals: INVITER_BROWSER });
    const id = ((await h.service.attachFromSignup('b', 'ABCDEFGH')) as { referralId: string }).referralId; // signup passed no signals
    expect(await h.service.evaluateReferral(id)).toBe('waiting');
    expect(h.grants).toEqual([]);
    h.setNow(new Date(NOW.getTime() + 8 * DAY));
    expect(await h.service.evaluateReferral(id)).toBe('held');
    expect(await referralOf(h)).toMatchObject({ status: 'held', riskReasons: ['signals_missing'], riskScore: 50 });
    expect(h.grants).toEqual([]);
  });

  it("an inviter with no stored signals is noted on their next visit, then the check passes", async () => {
    const h = setup(inviteSeed());
    const id = ((await h.service.attachFromSignup('b', 'ABCDEFGH', { signals: FRIEND_BROWSER })) as { referralId: string }).referralId;
    expect(await h.service.evaluateReferral(id)).toBe('waiting');
    await h.service.noteActivity('a', { brand: 'roboapply', signals: INVITER_BROWSER });
    expect(await h.fake.rAReferralSignal.count({ where: { userId: 'a' } })).toBe(1);
    expect(await h.service.evaluateReferral(id)).toBe('rewarded');
  });

  it('a hold that lands while a reward is being decided wins; no credit is granted', async () => {
    const h = setup(inviteSeed());
    await h.service.getInvites('a', { brand: 'roboapply', signals: INVITER_BROWSER });
    await h.service.attachFromSignup('b', 'ABCDEFGH', { signals: FRIEND_BROWSER });
    const id = String((await referralOf(h)).id);
    const store = memorySignalStore(h.fake);
    // The worker reads the signals (risk passes); meanwhile the friend's own request holds the row.
    const racing = createReferralService({
      db: h.fake as unknown as ReferralDb,
      signalStore: {
        ...store,
        forUsers: async (ids, since) => {
          const rows = await store.forUsers(ids, since);
          await h.fake.rAReferral.updateMany({ where: { id, status: 'pending', qualifiedAt: null }, data: { status: 'held', riskReasons: ['same_device'], qualifiedAt: NOW } });
          return rows;
        },
      },
      grantPracticeCredit: async (userId, _r, key) => {
        h.grants.push({ userId, key });
        return { status: 'granted', ledgerId: key, balanceAfter: 1 };
      },
      enqueue: async () => ({ id: 'w' }),
      sendEmail: async () => ({ status: 'sent' }),
      invitesEnabled: async () => true,
      env: ENV,
      now: () => NOW,
    });
    expect(await racing.evaluateReferral(id)).toBe('done');
    expect(h.grants).toEqual([]);
    expect(await referralOf(h)).toMatchObject({ status: 'held', riskReasons: ['same_device'] });
  });

  it('a claimed reward is finished by a later call, never re-decided', async () => {
    const h = setup(inviteSeed());
    const id = await attached(h);
    // An earlier call claimed it (qualifiedAt set, still pending) and stopped before granting.
    await h.fake.rAReferral.updateMany({ where: { id }, data: { qualifiedAt: NOW } });
    // Same-device rows arriving afterwards do not undo the decision; the keys keep grants single.
    await h.fake.rAReferralSignal.create({ data: { id: 'late', userId: 'b', brand: 'roboapply', ipHash: null, uaHash: null, deviceHash: 'dev', createdAt: NOW } });
    expect(await h.service.evaluateReferral(id)).toBe('rewarded');
    expect(await h.service.evaluateReferral(id)).toBe('done');
    expect(h.grants).toHaveLength(2);
  });

  it('holds everything while the signal store is unavailable (fail closed)', async () => {
    const h = setup(inviteSeed(), { signals: 'none' });
    const id = await attached(h);
    expect(await h.service.evaluateReferral(id)).toBe('held');
    expect(await referralOf(h)).toMatchObject({ riskReasons: ['signals_unavailable'] });
  });

  it('caps the inviter at 10 rewards a calendar year; the friend still gets theirs', async () => {
    const earlier = Array.from({ length: INVITE_REWARD_CAP_PER_YEAR }, (_, i) => ({
      id: `old${i}`,
      brand: 'roboapply',
      inviterUserId: 'a',
      inviteeUserId: `f${i}`,
      status: 'rewarded',
      rewardedAt: new Date(Date.UTC(2026, 0, 2 + i)),
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
    }));
    const h = setup(inviteSeed({ rAReferral: earlier }));
    const id = await attached(h);
    expect(await h.service.evaluateReferral(id)).toBe('qualified');
    expect(h.grants).toEqual([{ userId: 'b', key: 'referral_invitee:b' }]);
    const view = await h.service.getInvites('a', { brand: 'roboapply' });
    expect(view.invites[0]!.status).toBe('over_limit');
    expect(view.rewards.granted).toBe(10);

    // A new calendar year starts a new allowance.
    const pending = { id: 'rN', brand: 'roboapply', inviterUserId: 'a', inviteeUserId: 'b', status: 'pending', createdAt: NOW };
    const sig = (id: string, userId: string, ipHash: string) => ({ id, userId, brand: 'roboapply', ipHash, uaHash: null, deviceHash: null, createdAt: new Date('2027-01-01T00:00:00.000Z') });
    const next = setup(inviteSeed({ rAReferral: [...earlier, pending], rAReferralSignal: [sig('s1', 'a', 'ia'), sig('s2', 'b', 'ib')] }));
    next.setNow(new Date('2027-01-05T00:00:00.000Z'));
    expect(await next.service.evaluateReferral('rN')).toBe('rewarded');
  });

  it('a grant still being written is retried, not doubled', async () => {
    let calls = 0;
    const h = setup(inviteSeed(), {
      grant: () => {
        calls += 1;
        return calls === 1 ? { status: 'in_progress', ledgerId: 'l', balanceAfter: null } : { status: 'granted', ledgerId: 'l', balanceAfter: 1 };
      },
    });
    const id = await attached(h);
    expect(await h.service.evaluateReferral(id)).toBe('retry');
    expect((await referralOf(h)).status).toBe('pending');
    expect(h.enqueued.at(-1)).toMatchObject({ kind: 'growth.referralRisk', options: { delayMs: 5 * 60 * 1000, onConflict: 'requeue' } });
    expect(await h.service.evaluateReferral(id)).toBe('rewarded');
  });

  it("a friend whose profile is gone is not counted; an inviter's missing profile still finishes the friend's reward", async () => {
    const gone = setup(inviteSeed(), { grant: () => ({ status: 'no_profile', ledgerId: null, balanceAfter: null }) });
    const id1 = await attached(gone);
    expect(await gone.service.evaluateReferral(id1)).toBe('rejected');
    expect(await referralOf(gone)).toMatchObject({ status: 'rejected', riskReasons: ['invitee_no_profile'] });

    const granted: string[] = [];
    const inviterGone = setup(inviteSeed(), {
      grant: (userId, key) => {
        if (userId === 'a') return { status: 'no_profile', ledgerId: null, balanceAfter: null };
        granted.push(key);
        return { status: 'granted', ledgerId: key, balanceAfter: 1 };
      },
    });
    const id2 = await attached(inviterGone);
    expect(await inviterGone.service.evaluateReferral(id2)).toBe('qualified');
    expect(granted).toEqual(['referral_invitee:b']);
    expect(inviterGone.emails.map((e) => e.to)).toEqual(['b@example.test']);
  });

  it('a failed grant throws so the worker retries', async () => {
    const h = setup(inviteSeed(), { grant: () => ({ status: 'failed', ledgerId: null, balanceAfter: null }) });
    const id = await attached(h);
    await expect(h.service.evaluateReferral(id)).rejects.toThrow(/not granted/);
    expect((await referralOf(h)).status).toBe('pending');
  });

  it("the friend's activity records signals and checks the invite", async () => {
    const h = setup(inviteSeed());
    await h.service.getInvites('a', { brand: 'roboapply', signals: INVITER_BROWSER });
    await h.service.attachFromSignup('b', 'ABCDEFGH'); // today's signup passes no signals
    await h.service.noteActivity('b', { brand: 'roboapply', signals: { ip: '192.0.2.1' } });
    expect((await referralOf(h)).status).toBe('rewarded');
    expect(await h.fake.rAReferralSignal.count({ where: { userId: 'b' } })).toBe(1);
    await expect(h.service.noteActivity('nobody', { brand: 'roboapply' })).resolves.toBeUndefined();
    expect(await h.service.checkReferralFor('nobody')).toBeNull();
  });
});

// ── Review ───────────────────────────────────────────────────────────────

describe('reviewReferral', () => {
  async function held(): Promise<{ h: Harness; id: string }> {
    const h = setup(inviteSeed(), { signals: 'none' });
    const id = ((await h.service.attachFromSignup('b', 'ABCDEFGH')) as { referralId: string }).referralId;
    await h.service.evaluateReferral(id);
    return { h, id };
  }

  it('lists held rewards for the brand and approves one', async () => {
    const { h, id } = await held();
    expect(await h.service.listHeld('goapply')).toEqual([]);
    expect(await h.service.listHeld('roboapply')).toEqual([expect.objectContaining({ id, riskReasons: ['signals_unavailable'], inviterUserId: 'a' })]);
    expect(await h.service.reviewReferral(id, 'approve', 'roboapply')).toEqual({ id, status: 'rewarded' });
    expect(h.grants).toHaveLength(2);
    await expect(h.service.reviewReferral(id, 'approve', 'roboapply')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('an approval claims the row first, so a reject that lands meanwhile is refused', async () => {
    const { h, id } = await held();
    let rejectDuringGrant: Promise<unknown> | null = null;
    const svc: ReferralService = createReferralService({
      db: h.fake as unknown as ReferralDb,
      signalStore: null,
      grantPracticeCredit: async (userId, _r, key) => {
        rejectDuringGrant ??= svc.reviewReferral(id, 'reject', 'roboapply').catch((e: unknown) => e);
        h.grants.push({ userId, key });
        return { status: 'granted', ledgerId: key, balanceAfter: 1 };
      },
      enqueue: async () => ({ id: 'w' }),
      sendEmail: async () => ({ status: 'sent' }),
      env: ENV,
      now: () => NOW,
    });
    expect(await svc.reviewReferral(id, 'approve', 'roboapply')).toEqual({ id, status: 'rewarded' });
    expect(await rejectDuringGrant).toMatchObject({ code: 'conflict' });
    expect(h.grants).toHaveLength(2);
  });

  it('an approval whose credit cannot be written yet answers 409 and queues the finish', async () => {
    const { h, id } = await held();
    const enqueued: unknown[] = [];
    const svc = createReferralService({
      db: h.fake as unknown as ReferralDb,
      signalStore: null,
      grantPracticeCredit: async () => ({ status: 'failed', ledgerId: null, balanceAfter: null }),
      enqueue: async (kind, payload) => {
        enqueued.push({ kind, payload });
        return { id: 'w' };
      },
      env: ENV,
      now: () => NOW,
    });
    await expect(svc.reviewReferral(id, 'approve', 'roboapply')).rejects.toMatchObject({ code: 'conflict' });
    expect(enqueued).toEqual([{ kind: 'growth.referralRisk', payload: { referralId: id } }]);
    expect(await referralOf(h)).toMatchObject({ status: 'pending', qualifiedAt: NOW });
    // The worker finishes it with the original service once the grant works.
    expect(await h.service.evaluateReferral(id)).toBe('rewarded');
  });

  it('rejects one (nothing granted) and refuses the other brand', async () => {
    const { h, id } = await held();
    await expect(h.service.reviewReferral(id, 'reject', 'goapply')).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.service.reviewReferral(id, 'reject', 'roboapply')).toEqual({ id, status: 'rejected' });
    expect(h.grants).toEqual([]);
    expect((await h.service.getInvites('a', { brand: 'roboapply' })).invites[0]!.status).toBe('not_counted');
  });

  it('prunes signals older than 30 days', async () => {
    const h = setup({
      rAReferralSignal: [
        { id: 's1', userId: 'a', brand: 'roboapply', ipHash: 'i', uaHash: null, deviceHash: null, createdAt: new Date(NOW.getTime() - 31 * 24 * HOUR) },
        { id: 's2', userId: 'a', brand: 'roboapply', ipHash: 'i', uaHash: null, deviceHash: null, createdAt: new Date(NOW.getTime() - 24 * HOUR) },
      ],
    });
    expect(await h.service.pruneSignals()).toEqual({ deleted: 1, nextAt: new Date(NOW.getTime() + 29 * 24 * HOUR) });
  });
});

// ── Worker ───────────────────────────────────────────────────────────────

describe('growth.referralRisk worker', () => {
  const item = (referralId: unknown): LeasedWorkItem<{ referralId?: unknown }> => ({
    id: 'w',
    kind: 'growth.referralRisk',
    brand: 'roboapply',
    userId: 'b',
    payload: { referralId },
    attempts: 1,
    maxAttempts: 5,
    dedupeKey: null,
    priority: 0,
  });
  const ctx = { budget: { remainingMs: () => 1000 } as never, leaseOwner: 'test' };

  it('polls on a slowing schedule and stops after 30 days', () => {
    expect(nextCheckDelayMs(HOUR)).toBe(30 * 60 * 1000);
    expect(nextCheckDelayMs(2 * 24 * HOUR)).toBe(6 * HOUR);
    expect(nextCheckDelayMs(10 * 24 * HOUR)).toBe(24 * HOUR);
    expect(nextCheckDelayMs(31 * 24 * HOUR)).toBeNull();
  });

  it('defers while waiting, retries an in-progress grant, finishes otherwise', async () => {
    const outcomes = ['waiting', 'retry', 'rewarded', 'waiting'] as const;
    let i = 0;
    const evaluate = vi.fn(async () => outcomes[i++]!);
    const created = [new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - 40 * 24 * HOUR)];
    let c = 0;
    const worker = createReferralWorker({ service: { evaluateReferral: evaluate }, createdAt: async () => created[c++]!, now: () => NOW });
    expect(worker.kind).toBe('growth.referralRisk');
    await expect(worker.handler(item('r1'), ctx)).rejects.toBeInstanceOf(DeferWorkError);
    await expect(worker.handler(item('r1'), ctx)).rejects.toMatchObject({ delayMs: 5 * 60 * 1000 });
    await expect(worker.handler(item('r1'), ctx)).resolves.toBeUndefined();
    await expect(worker.handler(item('r1'), ctx)).resolves.toBeUndefined(); // 40 days old: stop polling
    await expect(worker.handler(item(42), ctx)).resolves.toBeUndefined();
  });

  it('growth.referralSignalPrune deletes old signals with no referral work at all, and comes back at the next expiry', async () => {
    // Inviter rows only (GET /invites), no referral and no referral queue item.
    const h = setup({
      user: [user('u')],
      rAReferralSignal: [
        { id: 's1', userId: 'u', brand: 'roboapply', ipHash: 'i', uaHash: null, deviceHash: null, createdAt: new Date(NOW.getTime() - 31 * DAY) },
        { id: 's2', userId: 'u', brand: 'roboapply', ipHash: 'j', uaHash: null, deviceHash: null, createdAt: new Date(NOW.getTime() - 25 * DAY) },
      ],
    });
    const worker = createSignalPruneWorker({ service: h.service, now: () => NOW });
    expect(worker.kind).toBe('growth.referralSignalPrune');
    const pruneItem = { ...item(null), kind: 'growth.referralSignalPrune', payload: {} } as never;
    await expect(worker.handler(pruneItem, ctx)).rejects.toMatchObject({ delayMs: 5 * DAY });
    expect(await h.fake.rAReferralSignal.count({})).toBe(1);
    const after = new Date(NOW.getTime() + 5 * DAY + HOUR);
    h.setNow(after);
    const later = createSignalPruneWorker({ service: h.service, now: () => after });
    await expect(later.handler(pruneItem, ctx)).resolves.toBeUndefined(); // nothing left: done until the next row is stored
    expect(await h.fake.rAReferralSignal.count({})).toBe(0);
    // Storing a row (any visit to /invites) queues the prune again.
    await h.service.getInvites('u', { brand: 'roboapply', signals: INVITER_BROWSER });
    expect(h.enqueued.map((e) => e.kind)).toEqual(['growth.referralSignalPrune']);
  });
});

// ── Email ────────────────────────────────────────────────────────────────

describe('growth.referral_reward email', () => {
  it('renders both roles without naming anyone or promising cash', () => {
    for (const brandId of ['roboapply', 'goapply'] as const) {
      const brand = getBrand(brandId);
      const t = createEmailTranslator(brand, 'en');
      for (const role of ['inviter', 'invitee'] as const) {
        const out = referralRewardEmail.render({ brand, t, params: { role, credits: 1 }, origin: 'https://example.test' });
        expect(out.subject.length).toBeGreaterThan(5);
        expect(out.bodyText).toContain('1 practice interview credit');
        expect(out.bodyText).toContain('https://example.test/practice');
        expect(out.bodyText).toContain(brand.name);
        expect(out.bodyText).toMatch(/no cash value/);
        expect(out.bodyText).not.toMatch(/%BRAND%/);
      }
    }
    expect(referralRewardEmail.category).toBe('transactional');
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

describe('invites routes', () => {
  let h: RouteHarness;
  const calls: Array<[string, unknown]> = [];
  const fakeService = {
    getInvites: vi.fn(async (userId: string, c: { brand: string; signals?: unknown }) => {
      calls.push(['get', { userId, ...c }]);
      return { eligibility: 'ok', code: 'ABCDEFGH', path: '/r/ABCDEFGH', link: 'https://x/r/ABCDEFGH', reward: { bucket: 'practice', credits: 1 }, invites: [], rewards: { granted: 0, capPerYear: 10, year: 2026 } };
    }),
    noteShared: vi.fn(async () => undefined),
    noteActivity: vi.fn(async () => undefined),
    listHeld: vi.fn(async (brand: string) => [{ id: 'r1', brand }]),
    reviewReferral: vi.fn(async (id: string, decision: string) => ({ id, status: decision === 'approve' ? 'rewarded' : 'rejected' })),
  } as unknown as ReferralService;
  const env = { NODE_ENV: 'development' };
  const offEnv = { NODE_ENV: 'development', FLAG_ROBOAPPLY_INVITES: 'false', FLAG_GOAPPLY_INVITES: 'false' };
  const rateDb = memoryRateLimitDb();

  beforeAll(async () => {
    h = await startRouteHarness({
      env,
      mounts: [
        ['/api/v1/roboapply/invites', createInvitesRouter({ seekerAuth: [fakeAuth({ id: 'u1' })], referrals: fakeService, env, rateLimitDb: memoryRateLimitDb() })],
        ['/limited/invites', createInvitesRouter({ seekerAuth: [fakeAuth({ id: 'u2' })], referrals: fakeService, env, rateLimitDb: rateDb })],
        ['/off/invites', createInvitesRouter({ seekerAuth: [fakeAuth({ id: 'u1' })], referrals: fakeService, env: offEnv })],
        ['/anon/invites', createInvitesRouter({ seekerAuth: [fakeAuth(null)], referrals: fakeService, env })],
        ['/api/v1/roboapply/admin/growth/referrals', createInvitesAdminRouter({ adminAuth: [fakeAuth({ id: 'adm', role: 'admin' })], referrals: fakeService })],
      ],
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('GET / returns the invite view for the brand of the host and notes the browser', async () => {
    const res = await h.request<{ data: { code: string } }>('GET', '/api/v1/roboapply/invites', {
      host: 'goapply.localhost:3621',
      headers: { 'user-agent': 'UA-test' },
      cookies: { ra_anon: 'anon_12345678' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe('ABCDEFGH');
    expect(calls.at(-1)).toEqual(['get', expect.objectContaining({ userId: 'u1', brand: 'goapply', signals: expect.objectContaining({ userAgent: 'UA-test', deviceId: 'anon_12345678' }) })]);
  });

  it('POST /shared validates the channel', async () => {
    const ok = await h.request<{ data: unknown }>('POST', '/api/v1/roboapply/invites/shared', { host: 'localhost:3621', body: { channel: 'wechat' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ ok: true });
    const bad = await h.request<{ code: string }>('POST', '/api/v1/roboapply/invites/shared', { host: 'localhost:3621', body: { channel: 'sms' } });
    expect(bad.status).toBe(422);
  });

  it('POST /shared is rate limited per user (10 a minute)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await h.request('POST', '/limited/invites/shared', { host: 'localhost:3621', headers: { 'user-agent': `UA-${i}` }, body: { channel: 'copy' } })).status);
    }
    expect(statuses.slice(0, 10).every((st) => st === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('has no route that sends messages to friends', async () => {
    const res = await h.request('POST', '/api/v1/roboapply/invites/email', { host: 'localhost:3621', body: { emails: ['f@example.test'] } });
    expect(res.status).toBe(404);
  });

  it('needs a session and the `invites` capability', async () => {
    expect((await h.request('GET', '/anon/invites', { host: 'localhost:3621' })).status).toBe(401);
    const off = await h.request<{ code: string }>('GET', '/off/invites', { host: 'localhost:3621' });
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('feature_disabled');
    expect((await h.request<{ code: string }>('POST', '/off/invites/shared', { host: 'localhost:3621', body: { channel: 'copy' } })).status).toBe(404);
  });

  it('admin: lists held rewards and reviews one (staff-only default chain: referralsAdminAuth.test.ts)', async () => {
    const list = await h.request<{ data: { items: unknown[] } }>('GET', '/api/v1/roboapply/admin/growth/referrals/held', { host: 'localhost:3621' });
    expect(list.body.data.items).toEqual([{ id: 'r1', brand: 'roboapply' }]);
    const review = await h.request<{ data: unknown }>('POST', '/api/v1/roboapply/admin/growth/referrals/r1/review', { host: 'localhost:3621', body: { decision: 'reject' } });
    expect(review.body.data).toEqual({ id: 'r1', status: 'rejected' });
    expect((await h.request('POST', '/api/v1/roboapply/admin/growth/referrals/r1/review', { host: 'localhost:3621', body: { decision: 'maybe' } })).status).toBe(422);
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

// ── Terms and paths ──────────────────────────────────────────────────────

describe('invite terms and stored paths', () => {
  it('GET /public/legal/referral-terms serves the DRAFT skeleton on both brands', () => {
    for (const brandId of ['roboapply', 'goapply'] as const) {
      const out = loadLegalDoc(getBrand(brandId), 'referral-terms', { env: { NODE_ENV: 'test' } });
      expect(out.draft).toBe(true);
      expect(out.markdown).toMatch(/DRAFT/);
      expect(out.markdown).not.toMatch(/\{\{|%BRAND%/);
    }
  });

  it('never stores an invite code as a landing path', () => {
    expect(sanitizeTouch({ landingPath: '/r/ABCD2345', ref: 'ABCD2345' }, NOW)).toMatchObject({ landingPath: '/r/:code', ref: 'ABCD2345' });
  });
});
