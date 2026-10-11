// @vitest-environment node
//
// Credits area routes (WP-21a): /credits, /credits/history, /credits/cancel,
// /credits/cancel/survey, /billing/plans, public /cancel, and the admin caps /
// overrides (audited) / FX / TW revenue / refund-quote routes. Fake Prisma,
// fake Stripe, fake email.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { setCreditCatalogConfigLoader, invalidateCreditCatalog } from '../../platform/credits/index.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { getBrand } from '../../platform/brand/registry.js';
import { registerRail, unregisterRail } from '../../platform/billing/index.js';
import {
  CANCEL_SURVEY_LIMIT,
  CancelSurveyStoreUnavailableError,
  CreditsAreaService,
  createBillingPlansRouter,
  createCreditsAdminRouter,
  createCreditsRouter,
  createPrismaCancelSurveyStore,
  createPublicCancelRouter,
  hashToken,
  overrideProblem,
  type CancelSurveyAnswer,
  type CreditsAreaDeps,
  type CreditsDb,
  type OverrideAuditEntry,
} from './index.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const LATER = new Date('2026-10-30T08:00:00.000Z');
const ENV = {
  NODE_ENV: 'test',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
  STRIPE_PRICE_PRO_WEEK_PASS: 'price_p',
  STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  NEXT_PUBLIC_ROBOAPPLY_URL: 'https://www.roboapply.io',
};

let db: ReturnType<typeof createFakePrisma>;
const sendEmail = vi.fn(async () => ({ status: 'sent' }));
const cancel = vi.fn();
const offered = new Set<string>();
let limited = false;
const stripe = {
  charges: { list: vi.fn(async () => ({ data: [{ id: 'ch_1', amount: 100_000, amount_refunded: 0, currency: 'usd', status: 'succeeded', paid: true, created: 1, payment_method_details: { card: { country: 'TW' } } }], has_more: false })) },
  invoices: { list: vi.fn(async () => ({ data: [] as unknown[] })) },
};
const invalidated: string[] = [];
let stripeOn = true;
/** The cancel-survey table: 'ok' stores, 'no_delegate' = not in the client, 'no_table' = Prisma P2021 on write. */
let surveyTable: 'ok' | 'no_delegate' | 'no_table' = 'ok';
const surveyRows: CancelSurveyAnswer[] = [];
const auditRows: OverrideAuditEntry[] = [];
let auditFails = false;
const auditOverride = vi.fn(async (entry: OverrideAuditEntry) => {
  if (auditFails) throw new Error('audit store down');
  auditRows.push(entry);
});

/** Users holding a live school-email verification. */
const verifiedStudents = new Set<string>();

function service(): CreditsAreaService {
  const deps: Partial<CreditsAreaDeps> = {
    db: async () => db as unknown as CreditsDb,
    env: () => ENV,
    now: () => NOW,
    summarize: async () => ({ planKey: 'free' }) as never,
    practiceBalance: async () => ({ credits: 2, periodAllotment: 1, creditMinutes: 20 }),
    cancel,
    alternative: { wasOffered: async (u) => offered.has(u), markOffered: async (u) => void offered.add(u) },
    sendEmail,
    rateLimit: async () => !limited,
    getStripe: () => (stripeOn ? (stripe as never) : null),
    invalidateEntitlements: (u) => void invalidated.push(u),
    allocatePacks: (packs, balance) => new Map(packs.map((p) => [p.id, Math.min(p.remaining, balance)])),
    surveys: {
      available: async () => surveyTable !== 'no_delegate',
      record: async (answer) => {
        if (surveyTable !== 'ok') throw new CancelSurveyStoreUnavailableError();
        surveyRows.push(answer);
      },
    },
    auditOverride,
    isStudentVerified: async (u) => verifiedStudents.has(u),
  };
  return new CreditsAreaService(deps);
}

let h: RouteHarness;
const seeker = { id: 'u_1', email: 'u@example.test', role: 'seeker' };
const admin = { id: 'admin_1', email: 'a@example.test', role: 'admin' };

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  setCreditCatalogConfigLoader(async () => {
    const row = await db.appConfig.findUnique({ where: { key: 'credits.catalog.v1' } });
    return (row?.value as string | undefined) ?? null;
  });
  const svc = service();
  const deps = { service: svc, seekerAuth: [fakeAuth(seeker)], adminAuth: [fakeAuth(admin)], optionalAuth: [fakeAuth(seeker)], env: ENV };
  h = await startRouteHarness({
    env: ENV,
    mounts: [
      ['/api/v1/roboapply/credits', createCreditsRouter(deps)],
      ['/api/v1/roboapply/billing/plans', createBillingPlansRouter(deps)],
      ['/api/v1/public/cancel', createPublicCancelRouter(deps)],
      ['/api/v1/roboapply/admin/credits', createCreditsAdminRouter(deps)],
      ['/anon/plans', createBillingPlansRouter({ ...deps, optionalAuth: [(_q, _s, n) => n()] })],
    ],
  });
});

afterAll(async () => {
  setFlagOverrideLoader(null);
  setCreditCatalogConfigLoader(null);
  await h.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  offered.clear();
  invalidated.length = 0;
  limited = false;
  stripeOn = true;
  surveyTable = 'ok';
  surveyRows.length = 0;
  auditRows.length = 0;
  auditFails = false;
  invalidateCreditCatalog();
  db = createFakePrisma({
    uniqueFields: { appConfig: ['key'], rAAuthToken: ['tokenHash'] },
    seed: {
      user: [
        { id: 'u_1', email: 'u@example.test', name: 'U', brand: 'roboapply' },
        { id: 'u_go', email: 'go@example.test', name: 'G', brand: 'goapply' },
      ],
      seekerProfile: [
        { id: 'sp_1', userId: 'u_1', locale: 'en', market: 'us' },
        { id: 'sp_go', userId: 'u_go', locale: 'zh', market: 'cn' },
      ],
      seekerSubscription: [
        { id: 'row_1', seekerProfileId: 'sp_1', tier: 'pro', status: 'active', planKey: 'pro_monthly', interval: 'month', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', currentPeriodEnd: LATER, cancelAtPeriodEnd: false, billingCountry: 'DE' },
      ],
    },
  });
  cancel.mockImplementation(async () => ({ status: 'cancelled', accessUntil: LATER, planKey: 'pro_monthly', changed: true, account: {} }));
});

const RA = { host: 'localhost:3621' };
/** A cuid-length (25 char) id, like the ones Prisma generates. */
const cuid = (i: number) => `cmg1k2abc0000xyz12345abc${i}`;
const GO = { host: 'goapply.localhost:3621' };

describe('GET /credits and /credits/history', () => {
  it('returns the entitlement summary and the practice balance', async () => {
    const res = await h.request<any>('GET', '/api/v1/roboapply/credits', RA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ summary: { planKey: 'free' }, practice: { balance: 2, periodAllotment: 1, creditMinutes: 20 } });
  });

  it('pages committed ledger rows newest first and hides internal billing claims', async () => {
    for (let i = 0; i < 3; i++) {
      await db.rACreditLedger.create({
        data: { id: cuid(i), userId: 'u_1', bucket: 'tailor', amount: 1, status: 'committed', fromSource: 'window', sku: 'ra_tailor_v2', idempotencyKey: `k${i}`, createdAt: new Date(NOW.getTime() - i * 1000), settledAt: null },
      });
    }
    await db.rACreditLedger.create({ data: { id: 'l_r', userId: 'u_1', bucket: 'tailor', amount: 1, status: 'reserved', fromSource: 'window', idempotencyKey: 'kr', createdAt: NOW } });
    await db.rACreditLedger.create({ data: { id: 'l_b', userId: 'u_1', bucket: 'billing_event', amount: 0, status: 'committed', fromSource: 'stripe', idempotencyKey: 'kb', createdAt: NOW } });
    const p1 = await h.request<any>('GET', '/api/v1/roboapply/credits/history?limit=2', RA);
    expect(p1.body.data.items.map((i: any) => i.id)).toEqual([cuid(0), cuid(1)]);
    // Real Prisma cuids are 25 chars, so the cursor is longer than 64 chars.
    expect(p1.body.data.cursor.length).toBeGreaterThan(64);
    const p2 = await h.request<any>('GET', `/api/v1/roboapply/credits/history?limit=2&cursor=${p1.body.data.cursor}`, RA);
    expect(p2.status).toBe(200);
    expect(p2.body.data).toEqual({ items: [expect.objectContaining({ id: cuid(2), bucket: 'tailor' })], cursor: null });
  });

  it('never lists a grant as use: practice-credit grants (sign-up, verification, referral, pack) stay out', async () => {
    // What platform/credits/practice.ts writes when it GRANTS a practice credit
    // (an idempotency claim, committed once the credit was added).
    await db.rACreditLedger.create({
      data: { id: 'l_grant', userId: 'u_1', bucket: 'practice', amount: 1, status: 'committed', fromSource: 'mock_credit', refType: 'practice_grant', refId: 'email_verified', idempotencyKey: 'u_1:practice:email-verify', createdAt: NOW, settledAt: NOW },
    });
    await db.rACreditLedger.create({
      data: { id: 'l_pack', userId: 'u_1', bucket: 'practice', amount: 5, status: 'committed', fromSource: 'mock_credit', refType: 'practice_grant', refId: 'pack_purchase', idempotencyKey: 'u_1:practice:order_1', createdAt: NOW, settledAt: NOW },
    });
    const fresh = await h.request<any>('GET', '/api/v1/roboapply/credits/history', RA);
    expect(fresh.status).toBe(200);
    // A new account has used nothing yet.
    expect(fresh.body.data).toEqual({ items: [], cursor: null });

    // A use paid from bonus credits is still a use.
    await db.rACreditLedger.create({
      data: { id: 'l_use', userId: 'u_1', bucket: 'tailor', amount: 1, status: 'committed', fromSource: 'grant:g_1', sku: 'ra_tailor_v2', idempotencyKey: 'u_1:tailor:k9', createdAt: NOW, settledAt: NOW },
    });
    const after = await h.request<any>('GET', '/api/v1/roboapply/credits/history', RA);
    expect(after.body.data.items.map((i: any) => i.id)).toEqual(['l_use']);
  });

  /** A MockInterviewCreditLedger row (the practice-credit balance ledger). */
  const practiceRow = (id: string, over: Record<string, unknown>) => ({
    id,
    seekerProfileId: 'sp_1',
    userId: 'u_1',
    delta: -1,
    balanceAfter: 0,
    reason: 'debit_interview',
    tier: 'free',
    relatedSessionId: `sess_${id}`,
    source: 'system',
    createdAt: NOW,
    ...over,
  });

  it('lists a practice interview as use, with the credits it really took', async () => {
    // An account whose only use so far is one practice interview (15 of the
    // 20 minutes a credit covers). Its sign-up credit and a pack that expired
    // are balance changes, not uses.
    await db.mockInterviewCreditLedger.create({ data: practiceRow('m_signup', { delta: 1, balanceAfter: 1, reason: 'signup_bonus', relatedSessionId: null, createdAt: new Date(NOW.getTime() - 60_000) }) });
    await db.mockInterviewCreditLedger.create({ data: practiceRow('m_use', { delta: -0.75, balanceAfter: 0.25, createdAt: new Date(NOW.getTime() - 30_000) }) });
    await db.mockInterviewCreditLedger.create({ data: practiceRow('m_expire', { delta: -0.25, balanceAfter: 0, reason: 'expire', relatedSessionId: null }) });
    await db.mockInterviewCreditLedger.create({ data: practiceRow('m_adjust', { delta: 2, balanceAfter: 2, reason: 'admin_adjust', relatedSessionId: null }) });
    // A session that ended with nothing left to take wrote a zero debit.
    await db.mockInterviewCreditLedger.create({ data: practiceRow('m_zero', { delta: 0, balanceAfter: 0 }) });
    await db.mockInterviewCreditLedger.create({ data: practiceRow('m_other', { userId: 'u_go', seekerProfileId: 'sp_go' }) });

    const res = await h.request<any>('GET', '/api/v1/roboapply/credits/history', RA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [{ id: 'm_use', bucket: 'practice', amount: 0.75, sku: null, fromSource: 'mock_credit', at: new Date(NOW.getTime() - 30_000).toISOString() }],
      cursor: null,
    });
  });

  it('pages practice interviews and metered actions together, newest first, with no row twice or missing', async () => {
    const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000);
    const ledger = (id: string, secondsAgo: number) =>
      db.rACreditLedger.create({
        data: { id, userId: 'u_1', bucket: 'tailor', amount: 1, status: 'committed', fromSource: 'window', sku: 'ra_tailor_v2', idempotencyKey: `k_${id}`, createdAt: at(secondsAgo), settledAt: at(secondsAgo) },
      });
    const practice = (id: string, secondsAgo: number) => db.mockInterviewCreditLedger.create({ data: practiceRow(id, { createdAt: at(secondsAgo) }) });
    await ledger('l_a', 0);
    await practice('m_b', 10);
    // The same instant in both tables, on either side of a page break. The
    // ids are chosen so that an order by id alone would put them the other way round.
    await ledger('a_tie', 20);
    await practice('z_tie', 20);
    await practice('m_e', 30);
    await ledger('l_f', 40);
    await ledger('l_g', 50);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res: any = await h.request<any>('GET', `/api/v1/roboapply/credits/history?limit=3${cursor ? `&cursor=${cursor}` : ''}`, RA);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items.map((i: any) => i.id));
      cursor = res.body.data.cursor;
      if (!cursor) break;
      expect(res.body.data.items).toHaveLength(3);
    }
    expect(seen).toEqual(['l_a', 'm_b', 'a_tie', 'z_tie', 'm_e', 'l_f', 'l_g']);

    // A page that ends on the practice row of a tie does not show its ledger twin again.
    const four = await h.request<any>('GET', '/api/v1/roboapply/credits/history?limit=4', RA);
    expect(four.body.data.items.map((i: any) => i.id)).toEqual(['l_a', 'm_b', 'a_tie', 'z_tie']);
    const rest = await h.request<any>('GET', `/api/v1/roboapply/credits/history?limit=4&cursor=${four.body.data.cursor}`, RA);
    expect(rest.body.data).toEqual({ items: [expect.objectContaining({ id: 'm_e' }), expect.objectContaining({ id: 'l_f' }), expect.objectContaining({ id: 'l_g' })], cursor: null });
  });
});

describe('POST /credits/cancel (one click)', () => {
  it('cancels and offers the 7-day pass once, never blocking', async () => {
    const first = await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ status: 'cancelled', accessUntil: LATER.toISOString(), alternative: { planKey: 'pro_week_pass' } });
    expect(cancel).toHaveBeenCalledWith('u_1', { source: 'in_app' });
    const second = await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: { reason: 'too_expensive', note: 'Found a job' } });
    expect(second.body.data.alternative).toBeNull();
    expect(cancel).toHaveBeenLastCalledWith('u_1', { reason: 'too_expensive', note: 'Found a job', source: 'in_app' });
  });

  it('answers no_subscription when nothing renews', async () => {
    cancel.mockRejectedValueOnce(Object.assign(new Error('There is no paid plan to cancel'), { code: 'no_subscription', status: 409 }));
    const res = await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'no_subscription' });
  });

  it('rejects unknown body fields', async () => {
    expect((await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: { force: true } })).status).toBe(422);
  });

  it('the 7-day pass is offered once per user, ever: a later cancellation of a new subscription offers nothing', async () => {
    expect((await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} })).body.data.alternative).toEqual({ planKey: 'pro_week_pass' });
    // Months later: the user subscribed again and cancels again (`changed: true` again).
    for (let i = 0; i < 2; i += 1) {
      expect((await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} })).body.data).toMatchObject({ status: 'cancelled', alternative: null });
    }
    expect([...offered]).toEqual(['u_1']);
  });

  it('offers nothing when the cancel changed nothing (already cancelled)', async () => {
    cancel.mockResolvedValueOnce({ status: 'already_cancelled', accessUntil: LATER, planKey: 'pro_monthly', changed: false, account: {} });
    const res = await h.request<any>('POST', '/api/v1/roboapply/credits/cancel', { ...RA, body: {} });
    expect(res.body.data).toEqual({ status: 'already_cancelled', accessUntil: LATER.toISOString(), alternative: null });
    expect(offered.size).toBe(0);
  });
});

describe('POST /credits/cancel/survey (records the answer, nothing else)', () => {
  const SURVEY = '/api/v1/roboapply/credits/cancel/survey';

  it('stores the reason and the note with the subscription it is about; no cancel, no email', async () => {
    const res = await h.request<any>('POST', SURVEY, { ...RA, body: { reason: 'found_job', note: '  Got an offer.  ' } });
    expect(res.status).toBe(204);
    expect(surveyRows).toEqual([{ userId: 'u_1', brand: 'roboapply', reason: 'found_job', note: 'Got an offer.', subscriptionId: 'row_1' }]);
    expect(cancel).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('takes a reason alone or a note alone, and stores the brand of the request', async () => {
    expect((await h.request<any>('POST', SURVEY, { ...RA, body: { reason: 'price' } })).status).toBe(204);
    expect((await h.request<any>('POST', SURVEY, { ...GO, body: { note: 'Too many emails' } })).status).toBe(204);
    expect(surveyRows.map((r) => [r.brand, r.reason, r.note])).toEqual([
      ['roboapply', 'price', null],
      ['goapply', null, 'Too many emails'],
    ]);
  });

  it('refuses an empty answer, an unknown reason, an over-long note and unknown fields with 422', async () => {
    for (const body of [{}, { note: '   ' }, { reason: 'because' }, { note: 'x'.repeat(1001) }, { reason: 'price', confirm: true }]) {
      expect((await h.request<any>('POST', SURVEY, { ...RA, body })).status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect(surveyRows).toEqual([]);
  });

  it('answers 503 storage_unavailable while the table is not in the client or not in the database', async () => {
    for (const state of ['no_delegate', 'no_table'] as const) {
      surveyTable = state;
      const res = await h.request<any>('POST', SURVEY, { ...RA, body: { reason: 'pause' } });
      expect(res.status, state).toBe(503);
      expect(res.body).toMatchObject({ success: false, code: 'storage_unavailable', details: { reason: 'storage_unavailable' } });
    }
    expect(surveyRows).toEqual([]);
  });

  it('is limited per user (429)', async () => {
    limited = true;
    const res = await h.request<any>('POST', SURVEY, { ...RA, body: { reason: 'other' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(CANCEL_SURVEY_LIMIT[0].windowSec));
    expect(surveyRows).toEqual([]);
  });

  describe('the Prisma adapter (no ScalarFieldEnum shim: it looks for the delegate)', () => {
    const answer: CancelSurveyAnswer = { userId: 'u_1', brand: 'roboapply', reason: 'price', note: null, subscriptionId: 'row_1' };

    it('is unavailable while the client has no rACancelSurvey delegate', async () => {
      const store = createPrismaCancelSurveyStore(async () => ({}));
      expect(await store.available()).toBe(false);
      await expect(store.record(answer)).rejects.toBeInstanceOf(CancelSurveyStoreUnavailableError);
    });

    it('writes exactly the model fields through the delegate', async () => {
      const create = vi.fn(async () => ({ id: 'cs_1' }));
      const store = createPrismaCancelSurveyStore(async () => ({ rACancelSurvey: { create } }));
      expect(await store.available()).toBe(true);
      await store.record({ ...answer, note: 'n' });
      expect(create).toHaveBeenCalledWith({ data: { userId: 'u_1', brand: 'roboapply', reason: 'price', note: 'n', subscriptionId: 'row_1' } });
    });

    it('maps a missing table or column (P2021 / P2022) to unavailable and passes other errors through', async () => {
      for (const code of ['P2021', 'P2022']) {
        const store = createPrismaCancelSurveyStore(async () => ({ rACancelSurvey: { create: async () => Promise.reject(Object.assign(new Error('missing'), { code })) } }));
        await expect(store.record(answer)).rejects.toBeInstanceOf(CancelSurveyStoreUnavailableError);
      }
      const boom = createPrismaCancelSurveyStore(async () => ({ rACancelSurvey: { create: async () => Promise.reject(Object.assign(new Error('connection lost'), { code: 'P1001' })) } }));
      await expect(boom.record(answer)).rejects.toThrow('connection lost');
    });

    // Needs a real database with the SCHEMA-6 diff applied (join J9 flips this).
    it.todo('SR-INT-1 — Prisma round-trip: a posted answer is one RACancelSurvey row (userId, brand, reason, note, subscriptionId) and deleting the user removes it');
  });
});

describe('GET /billing/plans', () => {
  it('lists the brand catalog with Monthly preselected and weekly never preselected', async () => {
    const res = await h.request<any>('GET', '/anon/plans', { ...RA, headers: { 'cf-ipcountry': 'FR' } });
    const data = res.body.data;
    expect(data.defaultSelection).toBe('pro_monthly');
    expect(data.plans.find((p: any) => p.key === 'pro_weekly')).toMatchObject({ isDefaultSelection: false, neverPreselected: true, monthlyEquivalentMinor: 4329, current: false });
    expect(data.plans.find((p: any) => p.key === 'pro_quarterly').savingsPercent).toBe(19);
    expect(data).toMatchObject({ currency: 'USD', paymentsOpen: true, offers: [], fxReference: null });
    expect(data.checkout).toMatchObject({ rails: ['stripe'], showWithdrawalWaiver: true, country: 'FR' });
  });

  it('marks the signed-in user\'s plan as current', async () => {
    const res = await h.request<any>('GET', '/api/v1/roboapply/billing/plans', RA);
    expect(res.body.data.plans.find((p: any) => p.current)?.key).toBe('pro_monthly');
  });

  it('shows the TWD reference only while the admin rate is ≤45 days old', async () => {
    await db.appConfig.create({ data: { key: 'fx.reference', value: JSON.stringify({ TWD: { ratePerUsd: 32, source: 'Central Bank of the ROC', asOf: '2026-10-01' } }) } });
    const fresh = await h.request<any>('GET', '/anon/plans', RA);
    expect(fresh.body.data.fxReference).toMatchObject({ currency: 'TWD', ratePerUsd: 32, source: 'Central Bank of the ROC', asOf: '2026-10-01', amounts: { pro_monthly: 800, pro_weekly: 320 } });
    await db.appConfig.update({ where: { key: 'fx.reference' }, data: { value: JSON.stringify({ TWD: { ratePerUsd: 32, source: 'CBC', asOf: '2026-08-01' } }) } });
    expect((await h.request<any>('GET', '/anon/plans', RA)).body.data.fxReference).toBeNull();
  });

  it('a Taiwan visitor sees TWD prices only for plans whose STRIPE_PRICE_<PLANKEY>_TWD pair is set', async () => {
    const TW = { ...RA, headers: { 'cf-ipcountry': 'TW' } };
    // No Taiwan price configured: USD only (the reference line, when fresh, is the only NT$ shown).
    const usd = await h.request<any>('GET', '/anon/plans', TW);
    expect(usd.body.data.checkout.country).toBe('TW');
    expect(usd.body.data.plans.every((p: any) => p.localPrice === null)).toBe(true);
    // The sheet reads the country the way checkout does: the edge's own header wins over one a client can send.
    const spoofed = await h.request<any>('GET', '/anon/plans', { ...RA, headers: { 'cf-ipcountry': 'TW', 'x-vercel-ip-country': 'US' } });
    expect(spoofed.body.data.checkout.country).toBe('US');

    const twEnv = { ...ENV, STRIPE_PRICE_PRO_MONTHLY_TWD: 'price_m_twd', STRIPE_PRICE_PRO_MONTHLY_TWD_CENTS: '74900' };
    const svc = new CreditsAreaService({ db: async () => db as unknown as CreditsDb, env: () => twEnv, now: () => NOW });
    const tw = await svc.plans(getBrand('roboapply'), { userId: null, country: 'TW' });
    expect(tw.plans.find((p) => p.key === 'pro_monthly')?.localPrice).toMatchObject({ currency: 'TWD', amountMinor: 74900 });
    // Only the configured plan; the others keep their USD price.
    expect(tw.plans.filter((p) => p.localPrice !== null).map((p) => p.key)).toEqual(['pro_monthly']);
    // The same deployment, a visitor elsewhere: no TWD.
    const fr = await svc.plans(getBrand('roboapply'), { userId: null, country: 'FR' });
    expect(fr.plans.every((p) => p.localPrice === null)).toBe(true);
  });

  describe('GoApply (D5, D6): CNY passes on sale by default through Alipay', () => {
    const go = getBrand('goapply');
    const plansFor = (env: Record<string, string>, userId: string | null = null) =>
      new CreditsAreaService({ db: async () => db as unknown as CreditsDb, env: () => env, now: () => NOW }).plans(go, { userId, country: null });
    const WECHAT = {
      WECHATPAY_MCH_ID: 'm',
      WECHATPAY_APP_ID: 'a',
      WECHATPAY_API_V3_KEY: '0123456789abcdef0123456789abcdef',
      WECHATPAY_MCH_CERT_SERIAL: 's',
      WECHATPAY_MCH_PRIVATE_KEY: 'p',
      WECHATPAY_PUBLIC_KEY: 'pub',
      WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
      WECHATPAY_MERCHANT_ENTITY: 'Example Collecting Co.',
      CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.',
    };
    const PAID = [
      ['pro_week_pass', 1200],
      ['pro_monthly', 3900],
      ['pro_quarterly', 9900],
      ['practice_pack_5', 2900],
      ['practice_pack_15', 7900],
    ];
    const amounts = (plans: Array<{ key: string; kind: string; amountMinor: number | null; requiresFlag?: string }>) =>
      plans.filter((p) => p.kind !== 'free' && !p.requiresFlag).map((p) => [p.key, p.amountMinor]);

    afterEach(() => {
      unregisterRail('wechatpay');
    });

    it('no rail credential: the plans list with their CNY prices and are on sale, but payments are not open and no rail is offered', async () => {
      // The harness env carries no ALIPAY_CALLBACK_SECRET and no CN_PAYMENTS_ENABLED.
      const res = await h.request<any>('GET', '/anon/plans', GO);
      const data = res.body.data;
      expect(data).toMatchObject({ currency: 'CNY', paymentsOpen: false, fxReference: null, defaultSelection: 'pro_monthly' });
      expect(data.checkout.rails).toEqual([]);
      expect(amounts(data.plans)).toEqual(PAID);
      expect(data.plans.every((p: any) => !p.autoRenews && p.unsellableReason !== 'price_unset')).toBe(true);
      expect(data.plans.filter((p: any) => p.kind !== 'free').every((p: any) => p.sellable && p.amountMinor > 0)).toBe(true);
    });

    it('with ALIPAY_CALLBACK_SECRET (pay.alipay on): paymentsOpen true and checkout.rails is [alipay]', async () => {
      const data = await plansFor({ ALIPAY_CALLBACK_SECRET: 's3cret' });
      expect(data.paymentsOpen).toBe(true);
      expect(data.checkout.rails).toEqual(['alipay']);
      expect(data.currency).toBe('CNY');
      expect(amounts(data.plans)).toEqual(PAID);
      expect(data.plans.find((p) => p.key === 'pro_quarterly')?.savingsPercent).toBe(15);
      // A whole-yuan override reaches the response; a ¥39.90 one does not.
      expect((await plansFor({ ALIPAY_CALLBACK_SECRET: 's', CN_PRICE_PRO_MONTHLY_FEN: '4900' })).plans.find((p) => p.key === 'pro_monthly')?.amountMinor).toBe(4900);
      expect((await plansFor({ ALIPAY_CALLBACK_SECRET: 's', CN_PRICE_PRO_MONTHLY_FEN: '3990' })).plans.find((p) => p.key === 'pro_monthly')?.amountMinor).toBe(3900);
    });

    it('with WeChat Pay configured and its entity matching, both rails are offered, Alipay first; WeChat Pay alone also opens payments', async () => {
      registerRail('wechatpay', { id: 'wechatpay', isConfigured: () => true, createCheckout: vi.fn() });
      const both = await plansFor({ ALIPAY_CALLBACK_SECRET: 's3cret', ...WECHAT });
      expect(both.checkout.rails).toEqual(['alipay', 'wechatpay']);
      expect(both.paymentsOpen).toBe(true);
      const wechatOnly = await plansFor({ ...WECHAT });
      expect(wechatOnly.checkout.rails).toEqual(['wechatpay']);
      expect(wechatOnly.paymentsOpen).toBe(true);
      // The entity does not match the merchant: WeChat Pay stays out, Alipay still sells.
      const mismatch = await plansFor({ ALIPAY_CALLBACK_SECRET: 's3cret', ...WECHAT, WECHATPAY_MERCHANT_ENTITY: 'Another Co.' });
      expect(mismatch.checkout.rails).toEqual(['alipay']);
      expect(mismatch.paymentsOpen).toBe(true);
    });

    it('the kill switch (CN_PAYMENTS_ENABLED=false): prices stay, nothing is sellable, no rail, payments not open', async () => {
      registerRail('wechatpay', { id: 'wechatpay', isConfigured: () => true, createCheckout: vi.fn() });
      const data = await plansFor({ ALIPAY_CALLBACK_SECRET: 's3cret', ...WECHAT, CN_PAYMENTS_ENABLED: 'false' });
      expect(data.paymentsOpen).toBe(false);
      expect(data.checkout.rails).toEqual([]);
      expect(amounts(data.plans)).toEqual(PAID);
      expect(data.plans.filter((p) => p.kind !== 'free').every((p) => !p.sellable && p.unsellableReason === 'payments_disabled')).toBe(true);
      expect(data.defaultSelection).toBeNull();
    });

    it('Stripe credentials never open a rail on GoApply, and Alipay credentials never open one on RoboApply', async () => {
      const data = await plansFor({ STRIPE_SECRET_KEY: 'sk_test_x' });
      expect(data.checkout.rails).toEqual([]);
      expect(data.paymentsOpen).toBe(false);
      const robo = await new CreditsAreaService({ db: async () => db as unknown as CreditsDb, env: () => ({ ...ENV, ALIPAY_CALLBACK_SECRET: 's3cret' }), now: () => NOW }).plans(getBrand('roboapply'), { userId: null, country: null });
      expect(robo.checkout.rails).toEqual(['stripe']);
    });

    describe('student passes are listed only for a verified student (plan §7 step 6)', () => {
      const SECRET = { ALIPAY_CALLBACK_SECRET: 's3cret' };
      const lookups: string[] = [];
      const studentPlansFor = (env: Record<string, string>, userId: string | null, verified: boolean | 'lookup_fails', brand = go) =>
        new CreditsAreaService({
          db: async () => db as unknown as CreditsDb,
          env: () => env,
          now: () => NOW,
          isStudentVerified: async (u) => {
            lookups.push(u);
            if (verified === 'lookup_fails') throw new Error('student table down');
            return verified;
          },
        }).plans(brand, { userId, country: null });
      const students = (data: { plans: Array<{ key: string; requiresFlag?: string }> }) => data.plans.filter((p) => p.requiresFlag === 'student').map((p) => p.key);

      beforeEach(() => {
        lookups.length = 0;
      });

      it('a visitor with no session gets the five paid plans and no verification lookup is made', async () => {
        const data = await studentPlansFor(SECRET, null, true);
        expect(students(data)).toEqual([]);
        expect(data.plans.filter((p) => p.kind !== 'free').map((p) => [p.key, p.amountMinor])).toEqual(PAID);
        expect(lookups).toEqual([]);
        // The public route, signed out, on the GoApply host.
        const res = await h.request<any>('GET', '/anon/plans', GO);
        expect(res.body.data.plans.filter((p: any) => p.kind !== 'free')).toHaveLength(5);
        expect(students(res.body.data)).toEqual([]);
      });

      it('a signed-in user who is not verified gets the five paid plans', async () => {
        const data = await studentPlansFor(SECRET, 'u_1', false);
        expect(students(data)).toEqual([]);
        expect(data.plans.filter((p) => p.kind !== 'free')).toHaveLength(5);
        expect(lookups).toEqual(['u_1']);
        expect(data.defaultSelection).toBe('pro_monthly');
      });

      it('a verified student gets seven: 学生月卡 ¥29 (25% below) and 学生季卡 ¥69 (30% below), on sale, never preselected', async () => {
        const data = await studentPlansFor(SECRET, 'u_1', true);
        expect(data.plans.filter((p) => p.kind !== 'free')).toHaveLength(7);
        expect(amounts(data.plans)).toEqual(PAID);
        expect(data.plans.filter((p) => p.requiresFlag === 'student').map((p) => [p.key, p.defaultLabel, p.amountMinor, p.passDays, p.studentDiscountPercent, p.sellable, p.kind])).toEqual([
          ['student_monthly', '学生月卡', 2900, 30, 25, true, 'pass'],
          ['student_quarterly', '学生季卡', 6900, 90, 30, true, 'pass'],
        ]);
        expect(data.defaultSelection).toBe('pro_monthly');
      });

      it('fails closed: a verification lookup that throws lists no student plan', async () => {
        expect(students(await studentPlansFor(SECRET, 'u_1', 'lookup_fails'))).toEqual([]);
      });

      it('the capability switched off: no student plan even for a verified student, and verification is not looked up', async () => {
        const off = await studentPlansFor({ ...SECRET, FLAG_GOAPPLY_STUDENT: 'false' }, 'u_1', true);
        expect(students(off)).toEqual([]);
        expect(amounts(off.plans)).toEqual(PAID);
        expect(lookups).toEqual([]);
      });

      it('RoboApply is unchanged by the GoApply rule (P7): its student plans are listed while the capability is on, to a visitor and an unverified user too', async () => {
        const robo = getBrand('roboapply');
        const both = ['student_monthly', 'student_quarterly'];
        expect(students(await studentPlansFor(ENV, null, true, robo))).toEqual(both);
        expect(students(await studentPlansFor(ENV, 'u_1', false, robo))).toEqual(both);
        expect(students(await studentPlansFor(ENV, 'u_1', true, robo))).toEqual(both);
        expect(students(await studentPlansFor(ENV, 'u_1', 'lookup_fails', robo))).toEqual(both);
        // Listing asks for no verification on RoboApply; buying does (the checkout's own check).
        expect(lookups).toEqual([]);
        // The capability switch still removes them.
        expect(students(await studentPlansFor({ ...ENV, FLAG_ROBOAPPLY_STUDENT: 'false' }, 'u_1', true, robo))).toEqual([]);
        // The public route, signed out, on the RoboApply host.
        const res = await h.request<any>('GET', '/anon/plans', RA);
        expect(students(res.body.data)).toEqual(both);
      });
    });
  });
});

describe('public /cancel (no sign-in)', () => {
  async function requestLink(email = 'u@example.test', opts = RA) {
    const res = await h.request<any>('POST', '/api/v1/public/cancel', { ...opts, body: { email } });
    expect(res.status).toBe(204);
    const call = sendEmail.mock.calls.find((c: any[]) => c[0].template === 'billing.cancel_link') as any[] | undefined;
    return call ? new URL(call[0].params.url).searchParams.get('token')! : null;
  }

  it('always answers 204 and emails nothing for unknown addresses or the other brand', async () => {
    expect(await requestLink('nobody@example.test')).toBeNull();
    expect(await requestLink('u@example.test', GO)).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('emails a single-use link that expires after 30 minutes; the token is stored only as a hash', async () => {
    const token = await requestLink();
    expect(token).toBeTruthy();
    const link = sendEmail.mock.calls[0]![0] as any;
    expect(link).toMatchObject({ template: 'billing.cancel_link', to: 'u@example.test', brand: 'roboapply', params: { expiresMinutes: 30 } });
    expect(link.params.url).toMatch(/^https:\/\/www\.roboapply\.io\/cancel\?token=/);
    const stored = await db.rAAuthToken.findMany({});
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'billing_cancel', brand: 'roboapply', tokenHash: hashToken(token!), userId: 'u_1' });
    expect((stored[0]!.expiresAt as Date).getTime() - NOW.getTime()).toBe(30 * 60_000);

    const ok = await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ status: 'cancelled', accessUntil: LATER.toISOString(), alternative: null });
    expect(cancel).toHaveBeenCalledWith('u_1', { source: 'public_link' });

    const reuse = await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } });
    expect(reuse.status).toBe(410);
    expect(reuse.body.code).toBe('cancel_token_invalid');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a payment-provider failure does not burn the link: the same link works on retry, then is spent', async () => {
    const token = await requestLink();
    cancel.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The cancellation could not be sent to the payment provider. Try again.'), { code: 'payment_provider_error' });
    });
    const failed = await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('payment_provider_error');
    expect((await db.rAAuthToken.findMany({}))[0]).toMatchObject({ consumedAt: null });
    const retry = await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } });
    expect(retry.status).toBe(200);
    expect(retry.body.data.status).toBe('cancelled');
    expect((await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } })).status).toBe(410);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('an unusable link answers 410 with the code cancel_token_invalid at the top of the envelope', async () => {
    const res = await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token: 'x'.repeat(40) } });
    expect(res.status).toBe(410);
    // `code`, not `details.reason`: the web reads it with apiErrorCode().
    expect(res.body).toMatchObject({ success: false, code: 'cancel_token_invalid' });
    expect(res.body.details).toBeUndefined();
    const token = await requestLink();
    await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } });
    const used = await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } });
    expect(used.body).toMatchObject({ code: 'cancel_token_invalid' });
  });

  it('refuses an expired link and a link used on the other brand', async () => {
    const token = await requestLink();
    await db.rAAuthToken.updateMany({ where: {}, data: { expiresAt: new Date(NOW.getTime() - 1) } });
    expect((await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...RA, body: { token } })).status).toBe(410);
    sendEmail.mockClear();
    const token2 = await requestLink();
    expect((await h.request<any>('POST', '/api/v1/public/cancel/confirm', { ...GO, body: { token: token2 } })).status).toBe(410);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('tells the owner when there is nothing to cancel', async () => {
    await db.seekerSubscription.update({ where: { id: 'row_1' }, data: { cancelAtPeriodEnd: true } });
    expect(await requestLink()).toBeNull();
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ template: 'billing.cancel_none', to: 'u@example.test' }));
  });

  it('rate-limits by IP with 429', async () => {
    limited = true;
    const res = await h.request<any>('POST', '/api/v1/public/cancel', { ...RA, body: { email: 'u@example.test' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
  });
});

describe('admin: caps editor', () => {
  it('validates and saves an override that changes the effective caps', async () => {
    const bad = await h.request<any>('PUT', '/api/v1/roboapply/admin/credits/catalog', { ...RA, body: { override: { brands: { roboapply: { buckets: { tailor: { free: { cap: -1 } } } } } } } });
    expect(bad.status).toBe(422);
    const ok = await h.request<any>('PUT', '/api/v1/roboapply/admin/credits/catalog', { ...RA, body: { override: { brands: { roboapply: { buckets: { tailor: { free: { cap: 4 } } } } } } } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.effective.roboapply.buckets.tailor.caps.free.cap).toBe(4);
    expect(ok.body.data.defaults.roboapply.buckets.tailor.caps.free.cap).toBe(2);
    expect(ok.body.data.updatedBy).toBe('admin_1');
    const get = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/catalog', RA);
    expect(get.body.data.override).toEqual({ brands: { roboapply: { buckets: { tailor: { free: { cap: 4 } } } } } });
  });
});

describe('admin: entitlement overrides', () => {
  it('creates, lists and deletes; invalidates the user\'s entitlements', async () => {
    const created = await h.request<any>('POST', '/api/v1/roboapply/admin/credits/overrides', { ...RA, body: { userId: 'u_1', key: 'bucket:tailor', value: 9, reason: 'Support case' } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ userId: 'u_1', key: 'bucket:tailor', value: 9, adminId: 'admin_1' });
    expect(invalidated).toEqual(['u_1']);
    const list = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/overrides?userId=u_1', RA);
    expect(list.body.data.items).toHaveLength(1);
    const del = await h.request<any>('DELETE', `/api/v1/roboapply/admin/credits/overrides/${created.body.data.id}`, RA);
    expect(del.status).toBe(204);
    expect((await h.request<any>('DELETE', `/api/v1/roboapply/admin/credits/overrides/${created.body.data.id}`, RA)).status).toBe(404);
  });

  it('writes one audit row per create and per delete, naming the admin and the person it is about', async () => {
    const created = await h.request<any>('POST', '/api/v1/roboapply/admin/credits/overrides', {
      ...RA,
      body: { userId: 'u_go', key: 'bucket:tailor', value: 9, reason: 'Support case', expiresAt: '2026-11-01T00:00:00.000Z' },
    });
    expect(auditRows).toEqual([
      {
        action: 'created',
        adminId: 'admin_1',
        subjectUserId: 'u_go',
        overrideId: created.body.data.id,
        key: 'bucket:tailor',
        value: 9,
        expiresAt: '2026-11-01T00:00:00.000Z',
        reason: 'Support case',
      },
    ]);
    await h.request<any>('DELETE', `/api/v1/roboapply/admin/credits/overrides/${created.body.data.id}`, RA);
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1]).toEqual({ action: 'deleted', adminId: 'admin_1', subjectUserId: 'u_go', overrideId: created.body.data.id, key: 'bucket:tailor', value: 9 });
    // Refused writes change nothing, so they leave no row.
    await h.request<any>('POST', '/api/v1/roboapply/admin/credits/overrides', { ...RA, body: { userId: 'ghost', key: 'flag:coaching', value: true, reason: 'x' } });
    await h.request<any>('DELETE', '/api/v1/roboapply/admin/credits/overrides/missing', RA);
    expect(auditOverride).toHaveBeenCalledTimes(2);
  });

  it('an audit failure never fails or undoes the override', async () => {
    auditFails = true;
    const created = await h.request<any>('POST', '/api/v1/roboapply/admin/credits/overrides', { ...RA, body: { userId: 'u_1', key: 'flag:coaching', value: true, reason: 'Beta' } });
    expect(created.status).toBe(201);
    expect(await db.rAEntitlementOverride.findMany({})).toHaveLength(1);
    const del = await h.request<any>('DELETE', `/api/v1/roboapply/admin/credits/overrides/${created.body.data.id}`, RA);
    expect(del.status).toBe(204);
    expect(await db.rAEntitlementOverride.findMany({})).toHaveLength(0);
    expect(auditOverride).toHaveBeenCalledTimes(2);
    expect(auditRows).toEqual([]);
  });

  it('the console\'s own entry points stay unaudited here, so its /admin/overrides routes do not write the row twice', async () => {
    const svc = service();
    const row = await svc.createOverride({ userId: 'u_1', key: 'bucket:tailor', value: 4, reason: 'Console' }, 'admin_1');
    await svc.deleteOverride(row.id, 'admin_1');
    expect(auditOverride).not.toHaveBeenCalled();
  });

  it('pages overrides with a cursor built from a cuid-length id', async () => {
    for (let i = 0; i < 51; i++) {
      await db.rAEntitlementOverride.create({
        data: { id: cuid(i).slice(0, 23) + String(i).padStart(2, '0'), userId: 'u_1', key: 'bucket:tailor', value: 1, reason: 'r', adminId: 'admin_1', createdAt: new Date(NOW.getTime() - i * 1000), expiresAt: null },
      });
    }
    const p1 = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/overrides?userId=u_1', RA);
    expect(p1.body.data.items).toHaveLength(50);
    expect(p1.body.data.cursor.length).toBeGreaterThan(64);
    const p2 = await h.request<any>('GET', `/api/v1/roboapply/admin/credits/overrides?userId=u_1&cursor=${p1.body.data.cursor}`, RA);
    expect(p2.status).toBe(200);
    expect(p2.body.data.items).toHaveLength(1);
    expect(p2.body.data.cursor).toBeNull();
  });

  it('refuses meaningless overrides and unknown users', async () => {
    for (const body of [
      { userId: 'u_1', key: 'bucket:contact_lookup', value: 5, reason: 'x' },
      { userId: 'u_1', key: 'bucket:tailor', value: true, reason: 'x' },
      { userId: 'u_1', key: 'entitlement:competitivenessFull', value: 3, reason: 'x' },
      { userId: 'u_1', key: 'flag:notAFlag', value: true, reason: 'x' },
    ]) {
      expect((await h.request<any>('POST', '/api/v1/roboapply/admin/credits/overrides', { ...RA, body })).status).toBe(422);
    }
    expect((await h.request<any>('POST', '/api/v1/roboapply/admin/credits/overrides', { ...RA, body: { userId: 'ghost', key: 'flag:coaching', value: true, reason: 'x' } })).status).toBe(404);
    expect(overrideProblem('flag:hiringContacts', 'on')).toBeNull();
    expect(overrideProblem('entitlement:saved_searches', 4)).toBeNull();
  });
});

describe('admin: FX reference and TW revenue monitor', () => {
  it('stores the TWD rate with source and as-of, reports age and freshness, refuses future dates', async () => {
    expect((await h.request<any>('GET', '/api/v1/roboapply/admin/credits/fx-reference', RA)).body.data).toBeNull();
    const put = await h.request<any>('PUT', '/api/v1/roboapply/admin/credits/fx-reference', { ...RA, body: { currency: 'TWD', ratePerUsd: 32.1, source: 'Central Bank of the ROC', asOf: '2026-10-01' } });
    expect(put.body.data).toMatchObject({ ratePerUsd: 32.1, ageDays: 9, fresh: true, updatedBy: 'admin_1' });
    const future = await h.request<any>('PUT', '/api/v1/roboapply/admin/credits/fx-reference', { ...RA, body: { currency: 'TWD', ratePerUsd: 32.1, source: 'x', asOf: '2026-12-01' } });
    expect(future.status).toBe(422);
  });

  it('sums TW-card revenue against NT$600k with the 70 % warning', async () => {
    await db.appConfig.create({ data: { key: 'fx.reference', value: JSON.stringify({ TWD: { ratePerUsd: 32, source: 'CBC', asOf: '2026-10-01' } }) } });
    const res = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/tw-revenue', RA);
    expect(res.body.data).toMatchObject({ revenueUsdMinor: 100_000, revenueTwd: 32_000, thresholdTwd: 600000, warnAt: 420000, warning: false, source: 'stripe' });
    // One unit: `warnAt` is whole NT$ like `revenueTwd` and `thresholdTwd`, never the 0.7 ratio.
    expect(Number.isInteger(res.body.data.warnAt)).toBe(true);
    expect(res.body.data.warnAt).toBeGreaterThan(1);
    expect(res.body.data.warnAt / res.body.data.thresholdTwd).toBeCloseTo(0.7);
    stripeOn = false;
    expect((await h.request<any>('GET', '/api/v1/roboapply/admin/credits/tw-revenue', RA)).status).toBe(501);
  });
});

describe('admin: refund quote', () => {
  it('EU first purchase without the waiver → full refund within 14 days', async () => {
    stripe.invoices.list.mockResolvedValueOnce({
      data: [{ id: 'in_1', amount_paid: 2499, currency: 'usd', created: Math.floor(NOW.getTime() / 1000) - 5 * 86400, status_transitions: { paid_at: Math.floor(NOW.getTime() / 1000) - 5 * 86400 }, billing_reason: 'subscription_create', metadata: {} }],
    });
    const res = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/refund-quote?userId=u_1', RA);
    expect(res.status).toBe(200);
    expect(res.body.data.charge).toMatchObject({ source: 'stripe', planKey: 'pro_monthly', chargeKind: 'first_purchase', amountMinor: 2499 });
    expect(res.body.data.facts).toMatchObject({ billingCountry: 'DE', withdrawalWaiver: false });
    expect(res.body.data.decision).toMatchObject({ eligible: true, rule: 'withdrawal_14d', amountMinor: 2499 });
  });

  it('with a recorded waiver the standard 7-day window applies', async () => {
    const paidAt = NOW.getTime() - 9 * 86_400_000;
    stripe.invoices.list.mockResolvedValueOnce({
      data: [{ id: 'in_1', amount_paid: 2499, currency: 'usd', created: paidAt / 1000, status_transitions: { paid_at: paidAt / 1000 }, billing_reason: 'subscription_create', metadata: {} }],
    });
    await db.seekerConsentRecord.create({ data: { seekerProfileId: 'sp_1', consentType: 'withdrawal_waiver', granted: true, createdAt: new Date(paidAt - 60_000) } });
    const res = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/refund-quote?userId=u_1', RA);
    expect(res.body.data.decision).toMatchObject({ eligible: false, rule: 'first_purchase_7d', blocker: 'window_passed' });
  });

  it('no charges → no decision', async () => {
    const res = await h.request<any>('GET', '/api/v1/roboapply/admin/credits/refund-quote?userId=u_go', RA);
    expect(res.body.data).toEqual({ charge: null, facts: null, decision: null });
  });
});
