// @vitest-environment node
//
// Credits area routes (WP-21a): /credits, /credits/history, /credits/cancel,
// /billing/plans, public /cancel, and the admin caps / overrides / FX / TW
// revenue / refund-quote routes. Fake Prisma, fake Stripe, fake email.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createFakePrisma } from '../../test/fakePrisma.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { setCreditCatalogConfigLoader, invalidateCreditCatalog } from '../../platform/credits/index.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import {
  CreditsAreaService,
  createBillingPlansRouter,
  createCreditsAdminRouter,
  createCreditsRouter,
  createPublicCancelRouter,
  hashToken,
  overrideProblem,
  type CreditsAreaDeps,
  type CreditsDb,
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

  it('GoApply: CNY passes, nothing purchasable until payments open, no TWD line', async () => {
    const res = await h.request<any>('GET', '/anon/plans', GO);
    expect(res.body.data).toMatchObject({ currency: 'CNY', paymentsOpen: false, fxReference: null });
    expect(res.body.data.checkout.rails).toEqual([]);
    expect(res.body.data.plans.every((p: any) => !p.sellable && !p.autoRenews)).toBe(true);
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
