// The checkout wrappers send one attempt key as the `Idempotency-Key` request
// header (ST-2, web half; MARKET_STRATEGY §5.1 "Idempotency keys"). Contract
// with the server: the header matches /^[A-Za-z0-9_-]{8,64}$/; without it the
// server falls back to a 60-second bucket. No network: `fetch` is stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHECKOUT_ATTEMPT_HEADER, CHECKOUT_ATTEMPT_KEY_PATTERN, accountApi, checkoutRequestOptions, plansBillingFacts } from './account';

const KEY = '3f2b8c1e-6a4d-4f0b-9c2e-7d1a5b8e9f00';

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { kind: 'redirect', url: 'https://pay.example.test/s', orderId: 'o1', rail: 'stripe' } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => {
  const [url, init] = fetchMock.mock.calls[call]!;
  return { url, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown>, method: init?.method };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkout attempt key → Idempotency-Key header', () => {
  it('the header name and the accepted form are the contract with the server', () => {
    expect(CHECKOUT_ATTEMPT_HEADER).toBe('Idempotency-Key');
    expect(String(CHECKOUT_ATTEMPT_KEY_PATTERN)).toBe('/^[A-Za-z0-9_-]{8,64}$/');
    expect(CHECKOUT_ATTEMPT_KEY_PATTERN.test(KEY)).toBe(true);
  });

  it('POST /billing/checkout carries the key as a header, never in the body', async () => {
    const fetchMock = stubFetch();
    const res = await accountApi.checkoutPlan({ planKey: 'pro_monthly', autoRenewAck: true, next: '/settings/billing/return?plan=pro_monthly' }, { attemptKey: KEY });
    expect(res).toMatchObject({ kind: 'redirect', url: 'https://pay.example.test/s' });
    const req = sent(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/\/api\/v1\/roboapply\/billing\/checkout$/);
    expect(req.headers['Idempotency-Key']).toBe(KEY);
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.body).toEqual({ planKey: 'pro_monthly', autoRenewAck: true, next: '/settings/billing/return?plan=pro_monthly' });
    expect(JSON.stringify(req.body)).not.toContain(KEY);
  });

  it('POST /billing/alipay carries it too (the server ignores it today)', async () => {
    const fetchMock = stubFetch();
    await accountApi.alipayCheckoutPlan({ planKey: 'pro_week_pass' }, { attemptKey: KEY });
    const req = sent(fetchMock);
    expect(req.url).toMatch(/\/api\/v1\/roboapply\/billing\/alipay$/);
    expect(req.headers['Idempotency-Key']).toBe(KEY);
    expect(req.body).toEqual({ planKey: 'pro_week_pass' });
  });

  it('the same key twice sends the same header twice; another key another header', async () => {
    const fetchMock = stubFetch();
    await accountApi.checkoutPlan({ planKey: 'practice_pack_5' }, { attemptKey: KEY });
    await accountApi.checkoutPlan({ planKey: 'practice_pack_5' }, { attemptKey: KEY });
    await accountApi.checkoutPlan({ planKey: 'practice_pack_5' }, { attemptKey: 'another_attempt-01' });
    expect([0, 1, 2].map((i) => sent(fetchMock, i).headers['Idempotency-Key'])).toEqual([KEY, KEY, 'another_attempt-01']);
  });

  it('no key, or one the server would not accept, sends no header (the server then uses its own short bucket)', async () => {
    const fetchMock = stubFetch();
    await accountApi.checkoutPlan({ planKey: 'pro_monthly' });
    await accountApi.checkoutPlan({ planKey: 'pro_monthly' }, { attemptKey: null });
    await accountApi.checkoutPlan({ planKey: 'pro_monthly' }, { attemptKey: 'short' });
    await accountApi.checkoutPlan({ planKey: 'pro_monthly' }, { attemptKey: 'has spaces and : colons' });
    await accountApi.checkoutPlan({ planKey: 'pro_monthly' }, { attemptKey: 'x'.repeat(65) });
    for (let i = 0; i < 5; i += 1) expect('Idempotency-Key' in sent(fetchMock, i).headers, String(i)).toBe(false);
    expect(checkoutRequestOptions()).toBeUndefined();
    expect(checkoutRequestOptions({ attemptKey: `  ${KEY}  ` })).toEqual({ headers: { 'Idempotency-Key': KEY } });
  });
});

describe('plansBillingFacts (the additive facts of GET /billing/plans)', () => {
  const POLICY = { firstPurchaseDays: 7, shortPlanHours: 48, paidOnlyCreditLimit: 5, accidentalRenewalDays: 3, withdrawalDays: 14, packValidMonths: 12, version: 'refund-v1-2026-10' };

  it('reads refundPolicy and checkout.collectingEntity exactly as the contract names them', () => {
    expect(plansBillingFacts({ plans: [], refundPolicy: POLICY, checkout: { rails: ['alipay'], collectingEntity: '示例科技有限公司' } })).toEqual({
      refundPolicy: POLICY,
      collectingEntity: '示例科技有限公司',
      studentOffer: [],
    });
  });

  it('a response from before the fields existed is "not stated", not an error', () => {
    const none = { refundPolicy: null, collectingEntity: null, studentOffer: [] };
    expect(plansBillingFacts({ plans: [], checkout: { rails: ['stripe'], country: null } })).toEqual(none);
    expect(plansBillingFacts(null)).toEqual(none);
    expect(plansBillingFacts('x')).toEqual(none);
    expect(plansBillingFacts({ checkout: { collectingEntity: null }, refundPolicy: null, studentOffer: null })).toEqual(none);
  });

  it('a policy with a missing, zero, fractional or non-numeric field is not stated at all (no half-filled sentence)', () => {
    for (const patch of [{ firstPurchaseDays: undefined }, { shortPlanHours: 0 }, { paidOnlyCreditLimit: -1 }, { accidentalRenewalDays: 2.5 }, { withdrawalDays: '14' }, { packValidMonths: null }]) {
      expect(plansBillingFacts({ refundPolicy: { ...POLICY, ...patch } }).refundPolicy, JSON.stringify(patch)).toBeNull();
    }
    // The version is carried when stated and empty otherwise; it never blocks the lines.
    expect(plansBillingFacts({ refundPolicy: { ...POLICY, version: undefined } }).refundPolicy).toEqual({ ...POLICY, version: '' });
  });

  it('a blank entity is no entity', () => {
    expect(plansBillingFacts({ checkout: { collectingEntity: '   ' } }).collectingEntity).toBeNull();
    expect(plansBillingFacts({ checkout: { collectingEntity: 42 } }).collectingEntity).toBeNull();
  });
});
