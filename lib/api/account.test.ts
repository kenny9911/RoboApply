// The checkout wrappers send one attempt key as the `Idempotency-Key` request
// header (ST-2, web half; MARKET_STRATEGY §5.1 "Idempotency keys"). Contract
// with the server: the header matches /^[A-Za-z0-9_-]{8,64}$/; without it the
// server falls back to a 60-second bucket. No network: `fetch` is stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BILLING_HISTORY_PAGE_SIZE,
  CHECKOUT_ATTEMPT_HEADER,
  CHECKOUT_ATTEMPT_KEY_PATTERN,
  CHECKOUT_SESSION_ID_PATTERN,
  accountApi,
  checkoutRequestOptions,
  checkoutSessionId,
  fromServerSwitch,
  invoiceChannel,
  invoiceRefunded,
  normaliseHistory,
  normalisePublicCancelPreview,
  normalisePublicCancelResult,
  normaliseReconcile,
  normaliseResume,
  normaliseWithdraw,
  normaliseWithdrawal,
  plansBillingFacts,
} from './account';

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

// Market wave M2 (MKT-2E): the web halves of ST-3, ST-5, ST-6 and ST-7. The
// server routes are built in parallel, so these tests pin the wire exactly as
// MARKET_TASK_PLAN.md §3.1 writes it: path, method, body, and how each answer
// is read (with a safe default for a shape the client does not know).
describe('subscription lifecycle calls (contract of MARKET_TASK_PLAN §3.1)', () => {
  const SESSION = 'cs_test_a1B2c3D4e5F6g7H8';

  function answer(data: unknown) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const request = (fetchMock: ReturnType<typeof answer>, call = 0) => {
    const [url, init] = fetchMock.mock.calls[call]!;
    return { url, method: init?.method, body: init?.body === undefined || init?.body === null ? undefined : (JSON.parse(String(init.body)) as unknown) };
  };

  it('a Checkout Session id is cs_ plus 8 to 200 letters, digits or underscores', () => {
    expect(String(CHECKOUT_SESSION_ID_PATTERN)).toBe('/^cs_[A-Za-z0-9_]{8,200}$/');
    expect(checkoutSessionId(SESSION)).toBe(SESSION);
    expect(checkoutSessionId(`cs_${'a'.repeat(200)}`)).toBe(`cs_${'a'.repeat(200)}`);
    for (const bad of ['cs_short', `cs_${'a'.repeat(201)}`, 'sub_12345678', ' cs_test_12345678', 'cs_test_1234-5678', '', null, undefined, 42, [SESSION]]) {
      expect(checkoutSessionId(bad), String(bad)).toBeNull();
    }
  });

  it('reconcile: POST /billing/checkout/reconcile { sessionId } and the three statuses', async () => {
    const fetchMock = answer({ status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    expect(await accountApi.reconcileCheckout(SESSION)).toEqual({ status: 'fulfilled', mode: 'payment', planKey: 'pro_week_pass' });
    const req = request(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/\/api\/v1\/roboapply\/billing\/checkout\/reconcile$/);
    expect(req.body).toEqual({ sessionId: SESSION });
    expect(normaliseReconcile({ status: 'already_fulfilled', mode: 'subscription', planKey: null })).toEqual({ status: 'already_fulfilled', mode: 'subscription', planKey: null });
    expect(normaliseReconcile({ status: 'pending', mode: 'payment', planKey: 'practice_pack_5' })).toEqual({ status: 'pending', mode: 'payment', planKey: 'practice_pack_5' });
  });

  it('reconcile: an answer in a shape the client does not know claims nothing (pending)', () => {
    const pending = { status: 'pending', mode: null, planKey: null };
    for (const raw of [null, undefined, 'ok', [], {}, { status: 'paid' }, { status: true }, { fulfilled: true }]) expect(normaliseReconcile(raw), JSON.stringify(raw)).toEqual(pending);
    expect(normaliseReconcile({ status: 'fulfilled', mode: 'setup', planKey: 7 })).toEqual({ status: 'fulfilled', mode: null, planKey: null });
  });

  it('reconcile: anything that is not a session id is refused without a request', async () => {
    const fetchMock = answer({ status: 'fulfilled' });
    for (const bad of ['', 'cs_x', 'pi_1234567890', '{CHECKOUT_SESSION_ID}']) await expect(accountApi.reconcileCheckout(bad)).rejects.toThrow('Invalid checkout session id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('portal: the payment-method flow posts { flow: "payment_method_update" }; the plain portal posts no body', async () => {
    const fetchMock = answer({ url: 'https://billing.stripe.test/session' });
    expect(await accountApi.portal({ flow: 'payment_method_update' })).toEqual({ url: 'https://billing.stripe.test/session' });
    await accountApi.portal();
    await accountApi.portal({});
    const [flow, plain, empty] = [0, 1, 2].map((i) => request(fetchMock, i));
    for (const req of [flow, plain, empty]) {
      expect(req.method).toBe('POST');
      expect(req.url).toMatch(/\/api\/v1\/roboapply\/billing\/portal$/);
    }
    expect(flow!.body).toEqual({ flow: 'payment_method_update' });
    expect(plain!.body).toBeUndefined();
    expect(empty!.body).toBeUndefined();
  });

  it('resume: POST /credits/resume { autoRenewAck: true } → resumed, the plan and the renewal date', async () => {
    const fetchMock = answer({ status: 'resumed', planKey: 'pro_monthly', renewsAt: '2026-11-10T00:00:00.000Z' });
    expect(await accountApi.resumeSubscription()).toEqual({ status: 'resumed', planKey: 'pro_monthly', renewsAt: '2026-11-10T00:00:00.000Z' });
    const req = request(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/\/api\/v1\/roboapply\/credits\/resume$/);
    expect(req.body).toEqual({ autoRenewAck: true });
    expect(normaliseResume({ status: 'resumed', planKey: 'pro_weekly', renewsAt: null })).toEqual({ status: 'resumed', planKey: 'pro_weekly', renewsAt: null });
    expect(normaliseResume({})).toEqual({ status: 'resumed', planKey: null, renewsAt: null });
  });

  it('switch confirm: { switched: true } is a changed plan', async () => {
    const fetchMock = answer({ switched: true, planKey: 'pro_quarterly' });
    expect(await accountApi.switchConfirm({ quoteId: 'pro_quarterly:1791590400', autoRenewAck: true })).toEqual({ status: 'switched', planKey: 'pro_quarterly', nextRenewalAt: null });
    expect(request(fetchMock).body).toEqual({ planKey: 'pro_quarterly', confirm: true, prorationDate: 1791590400, autoRenewAck: true });
  });

  it('switch confirm: { switched: false, requiresAction: true } is NOT a changed plan and carries the invoice page', async () => {
    answer({ switched: false, requiresAction: true, hostedInvoiceUrl: 'https://invoice.stripe.test/i/1', planKey: 'pro_quarterly' });
    expect(await accountApi.switchConfirm({ quoteId: 'pro_quarterly:1791590400', autoRenewAck: true, withdrawalWaiver: true })).toEqual({
      status: 'requires_action',
      planKey: 'pro_quarterly',
      hostedInvoiceUrl: 'https://invoice.stripe.test/i/1',
    });
    expect(fromServerSwitch({ switched: false, requiresAction: true, hostedInvoiceUrl: null, planKey: 'pro_weekly' }, 'pro_weekly')).toEqual({ status: 'requires_action', planKey: 'pro_weekly', hostedInvoiceUrl: null });
    // Only a web address is ever handed to the page as a link.
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', '', 42, undefined]) {
      expect(fromServerSwitch({ switched: false, requiresAction: true, hostedInvoiceUrl: url }, 'pro_weekly'), String(url)).toEqual({ status: 'requires_action', planKey: 'pro_weekly', hostedInvoiceUrl: null });
    }
  });

  it('switch confirm: any other answer is not called a switch (it throws, so the sheet says it did not go through)', async () => {
    for (const raw of [{ switched: false }, { switched: 'true', planKey: 'pro_weekly' }, { requiresAction: 'yes' }, {}, null, 'ok']) {
      expect(() => fromServerSwitch(raw, 'pro_weekly'), JSON.stringify(raw)).toThrow('Unexpected switch answer');
    }
    answer({ quote: { planKey: 'pro_weekly' } });
    await expect(accountApi.switchConfirm({ quoteId: 'pro_weekly:1791590400', autoRenewAck: true })).rejects.toThrow('Unexpected switch answer');
  });
});

// Market wave M4 (MKT-4C): the web halves of ST-9 (withdrawal) and ST-10
// (paged invoice history). The server halves are built in parallel (MKT-4A,
// MKT-4B), so these tests pin what the web SENDS and how each documented
// answer is read, with the safe default for an older server.
describe('billing phase B calls (contract of MARKET_TASK_PLAN §3.1)', () => {
  function answer(data: unknown) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const request = (fetchMock: ReturnType<typeof answer>, call = 0) => {
    const [url, init] = fetchMock.mock.calls[call]!;
    return { url, method: init?.method, body: init?.body === undefined || init?.body === null ? undefined : (JSON.parse(String(init.body)) as unknown) };
  };

  const PURCHASE = { source: 'stripe', id: 'in_monthly_1', planKey: 'pro_monthly', chargedAt: '2026-10-06T10:00:00.000Z', amountMinor: 2499, currency: 'usd' };
  const QUOTE = { rule: 'withdrawal_14d_prorata', refundMinor: 2083, currency: 'usd', deadline: '2026-10-20T10:00:00.000Z', prorata: { usedDays: 5, periodDays: 30 }, endsAccess: true, region: 'eu' };

  describe('GET /billing/history (ST-10)', () => {
    const row = { id: 'in_1', kind: 'stripe', date: '2026-10-01T00:00:00.000Z', amountMinor: 2499, currency: 'USD', status: 'paid', description: 'Pro Monthly', downloadable: true };

    it('the first page asks for the page size and no cursor; the next page sends the cursor it was given', async () => {
      const fetchMock = answer({ invoices: [row], nextCursor: 'eyJzIjoiaW5fMSJ9' });
      const page = await accountApi.history();
      expect(BILLING_HISTORY_PAGE_SIZE).toBe(20);
      expect(request(fetchMock).method).toBe('GET');
      expect(request(fetchMock).url).toMatch(/\/api\/v1\/roboapply\/billing\/history\?limit=20$/);
      expect(page).toEqual({ invoices: [row], nextCursor: 'eyJzIjoiaW5fMSJ9' });
      await accountApi.history(page.nextCursor);
      expect(request(fetchMock, 1).url).toMatch(/\/billing\/history\?cursor=eyJzIjoiaW5fMSJ9&limit=20$/);
      await accountApi.history(null);
      expect(request(fetchMock, 2).url).toMatch(/\/billing\/history\?limit=20$/);
    });

    it('an older server sends rows and nothing else: no further page, card or Alipay by kind, not refunded', () => {
      const old = normaliseHistory({ invoices: [row, { ...row, id: 'o1', kind: 'alipay', currency: 'CNY' }] });
      expect(old.nextCursor).toBeNull();
      expect(old.invoices.map(invoiceChannel)).toEqual(['card', 'alipay']);
      expect(old.invoices.map(invoiceRefunded)).toEqual([null, null]);
      // The rows keep exactly the keys the server sent: the optional two are never invented.
      expect(Object.keys(old.invoices[0]!).sort()).toEqual(Object.keys(row).sort());
    });

    it('channel and refunded are read only in the contract\'s values', () => {
      const page = normaliseHistory({
        invoices: [
          { ...row, id: 'w1', kind: 'alipay', channel: 'wechatpay', refunded: 'full' },
          { ...row, id: 'p1', refunded: 'partial' },
          { ...row, id: 'x1', channel: 'bitcoin', refunded: 'yes' },
        ],
        nextCursor: '',
      });
      expect(page.invoices.map(invoiceChannel)).toEqual(['wechatpay', 'card', 'card']);
      expect(page.invoices.map(invoiceRefunded)).toEqual(['full', 'partial', null]);
      expect(page.nextCursor).toBeNull();
      expect('channel' in page.invoices[2]! || 'refunded' in page.invoices[2]!).toBe(false);
    });

    it('anything that is not a page reads as an empty one; a row without an id is dropped', () => {
      for (const raw of [null, undefined, 'x', [], { invoices: 'no' }]) expect(normaliseHistory(raw)).toEqual({ invoices: [], nextCursor: null });
      expect(normaliseHistory({ invoices: [{ kind: 'stripe' }, null, row] }).invoices.map((i) => i.id)).toEqual(['in_1']);
    });
  });

  describe('GET and POST /credits/withdrawal (ST-9)', () => {
    it('the quote is a GET; the contract\'s purchase and quote become one option, currency upper-cased', async () => {
      const fetchMock = answer({ available: true, purchase: PURCHASE, quote: QUOTE });
      const overview = await accountApi.withdrawal();
      expect(request(fetchMock).method).toBe('GET');
      expect(request(fetchMock).url).toMatch(/\/api\/v1\/roboapply\/credits\/withdrawal$/);
      expect(request(fetchMock).body).toBeUndefined();
      expect(overview).toEqual({
        available: true,
        options: [
          {
            purchase: { source: 'stripe', id: 'in_monthly_1', planKey: 'pro_monthly', chargedAt: '2026-10-06T10:00:00.000Z', amountMinor: 2499, currency: 'USD' },
            quote: { rule: 'withdrawal_14d_prorata', refundMinor: 2083, currency: 'USD', deadline: '2026-10-20T10:00:00.000Z', prorata: { usedDays: 5, periodDays: 30 }, region: 'eu' },
          },
        ],
      });
    });

    it('every open purchase is read when the server lists them, in its order and each once', () => {
      const pack = { purchase: { ...PURCHASE, id: 'in_pack_1', planKey: 'practice_pack_5', amountMinor: 999 }, quote: { ...QUOTE, rule: 'withdrawal_14d', refundMinor: 999, prorata: null } };
      const plan = { purchase: PURCHASE, quote: QUOTE };
      const overview = normaliseWithdrawal({ available: true, purchase: pack.purchase, quote: pack.quote, purchases: [pack, plan, pack] });
      expect(overview.options.map((o) => o.purchase.id)).toEqual(['in_pack_1', 'in_monthly_1']);
      expect(overview.options[0]!.quote).toMatchObject({ rule: 'withdrawal_14d', refundMinor: 999, prorata: null });
      // A list with nothing usable in it falls back to the documented pair.
      expect(normaliseWithdrawal({ available: true, purchase: PURCHASE, quote: QUOTE, purchases: [{}, null] }).options.map((o) => o.purchase.id)).toEqual(['in_monthly_1']);
    });

    it('not available, an older server, or a quote that does not state its amount and last day offers nothing', () => {
      const none = { available: false, options: [] };
      for (const raw of [null, {}, 'x', { available: false, purchase: PURCHASE, quote: QUOTE }, { available: 'true', purchase: PURCHASE, quote: QUOTE }, { available: true, purchase: null, quote: null }]) {
        expect(normaliseWithdrawal(raw), JSON.stringify(raw)).toEqual(none);
      }
      for (const quote of [{ ...QUOTE, refundMinor: 20.83 }, { ...QUOTE, refundMinor: -1 }, { ...QUOTE, deadline: 'soon' }, { ...QUOTE, rule: 'first_purchase_7d' }, { ...QUOTE, currency: '' }]) {
        expect(normaliseWithdrawal({ available: true, purchase: PURCHASE, quote }), JSON.stringify(quote)).toEqual(none);
      }
      for (const purchase of [{ ...PURCHASE, id: '' }, { ...PURCHASE, amountMinor: '2499' }, { ...PURCHASE, currency: 'dollars' }]) {
        expect(normaliseWithdrawal({ available: true, purchase, quote: QUOTE }), JSON.stringify(purchase)).toEqual(none);
      }
    });

    it('pro-rata days are kept only when they are whole and make sense; a refund of nothing is still a quote', () => {
      const read = (prorata: unknown) => normaliseWithdrawal({ available: true, purchase: PURCHASE, quote: { ...QUOTE, prorata } }).options[0]!.quote.prorata;
      expect(read({ usedDays: 0, periodDays: 7 })).toEqual({ usedDays: 0, periodDays: 7 });
      for (const bad of [null, { usedDays: 31, periodDays: 30 }, { usedDays: 1.5, periodDays: 30 }, { usedDays: 5, periodDays: 0 }, { usedDays: 5 }]) expect(read(bad), JSON.stringify(bad)).toBeNull();
      expect(normaliseWithdrawal({ available: true, purchase: PURCHASE, quote: { ...QUOTE, refundMinor: 0 } }).options[0]!.quote.refundMinor).toBe(0);
    });

    it('the withdrawal posts { purchaseId, confirm: true } and nothing else', async () => {
      const fetchMock = answer({ status: 'withdrawn', refundMinor: 2083, currency: 'usd', accessEnded: true });
      expect(await accountApi.withdraw('in_monthly_1')).toEqual({ status: 'withdrawn', refundMinor: 2083, currency: 'USD' });
      const req = request(fetchMock);
      expect(req.method).toBe('POST');
      expect(req.url).toMatch(/\/api\/v1\/roboapply\/credits\/withdrawal$/);
      expect(req.body).toEqual({ purchaseId: 'in_monthly_1', confirm: true });
    });

    it('no purchase id sends nothing; an answer that does not say "withdrawn" is never called a withdrawal', async () => {
      const fetchMock = answer({ status: 'withdrawn' });
      await expect(accountApi.withdraw('  ')).rejects.toThrow('Missing purchase id');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(normaliseWithdraw({ status: 'withdrawn' })).toEqual({ status: 'withdrawn', refundMinor: null, currency: null });
      for (const raw of [{}, null, { status: 'pending' }, { refundMinor: 2083, currency: 'USD' }]) expect(() => normaliseWithdraw(raw), JSON.stringify(raw)).toThrow('Unexpected withdrawal answer');
    });
  });

  describe('the public cancel link: preview, then cancel or withdraw (ST-9)', () => {
    const TOKEN = 'tok_abcdefghijklmnop';

    it('preview posts the token to /public/cancel/preview and reads the plan, the period end and the withdrawal', async () => {
      const fetchMock = answer({ planKey: 'pro_monthly', accessUntil: '2026-11-05T10:00:00.000Z', withdrawal: { refundMinor: 2083, currency: 'usd', rule: 'withdrawal_14d_prorata', deadline: '2026-10-20T10:00:00.000Z' } });
      expect(await accountApi.previewPublicCancel(TOKEN)).toEqual({
        planKey: 'pro_monthly',
        accessUntil: '2026-11-05T10:00:00.000Z',
        withdrawal: { refundMinor: 2083, currency: 'USD', rule: 'withdrawal_14d_prorata', deadline: '2026-10-20T10:00:00.000Z' },
      });
      const req = request(fetchMock);
      expect(req.method).toBe('POST');
      expect(req.url).toMatch(/\/api\/v1\/public\/cancel\/preview$/);
      expect(req.body).toEqual({ token: TOKEN });
    });

    it('preview hands the caller\'s signal to the request, so the page can give up on a question that hangs; the body is the same', async () => {
      const fetchMock = answer({ planKey: 'pro_monthly', accessUntil: null, withdrawal: null });
      const controller = new AbortController();
      await accountApi.previewPublicCancel(TOKEN, { signal: controller.signal });
      const [, init] = fetchMock.mock.calls[0]!;
      expect((init as RequestInit).signal).toBe(controller.signal);
      expect(request(fetchMock).body).toEqual({ token: TOKEN });
      // Without one, none is invented.
      await accountApi.previewPublicCancel(TOKEN);
      expect((fetchMock.mock.calls[1]![1] as RequestInit).signal).toBeUndefined();
    });

    it('no withdrawal, or one without its amount, rule or last day, is no withdrawal', () => {
      expect(normalisePublicCancelPreview({ planKey: 'pro_weekly', accessUntil: null, withdrawal: null })).toEqual({ planKey: 'pro_weekly', accessUntil: null, withdrawal: null });
      for (const w of [{}, { refundMinor: 999, currency: 'USD', rule: 'withdrawal_14d' }, { refundMinor: 9.99, currency: 'USD', rule: 'withdrawal_14d', deadline: '2026-10-20T10:00:00.000Z' }, { refundMinor: 999, currency: 'USD', rule: 'other', deadline: '2026-10-20T10:00:00.000Z' }]) {
        expect(normalisePublicCancelPreview({ withdrawal: w }).withdrawal, JSON.stringify(w)).toBeNull();
      }
      expect(normalisePublicCancelPreview(null)).toEqual({ planKey: null, accessUntil: null, withdrawal: null });
    });

    it('an ordinary cancel posts exactly { token }, as it always did; a withdrawal adds withdraw: true', async () => {
      const fetchMock = answer({ status: 'cancelled', accessUntil: '2026-11-05T10:00:00.000Z', alternative: null });
      expect(await accountApi.confirmPublicCancel({ token: TOKEN })).toEqual({ status: 'cancelled', accessUntil: '2026-11-05T10:00:00.000Z', withdrawal: null });
      expect(request(fetchMock).url).toMatch(/\/api\/v1\/public\/cancel\/confirm$/);
      expect(request(fetchMock).body).toEqual({ token: TOKEN });
      await accountApi.confirmPublicCancel({ token: TOKEN, withdraw: false });
      expect(request(fetchMock, 1).body).toEqual({ token: TOKEN });
      await accountApi.confirmPublicCancel({ token: TOKEN, withdraw: true });
      expect(request(fetchMock, 2).body).toEqual({ token: TOKEN, withdraw: true });
    });

    it('the answer says whether the withdrawal happened; only the server\'s own word makes it one', () => {
      expect(normalisePublicCancelResult({ status: 'cancelled', accessUntil: null, withdrawal: { status: 'withdrawn', refundMinor: 2083, currency: 'usd' } })).toEqual({
        status: 'cancelled',
        accessUntil: null,
        withdrawal: { status: 'withdrawn', refundMinor: 2083, currency: 'USD' },
      });
      expect(normalisePublicCancelResult({ status: 'cancelled', accessUntil: '2026-11-05T10:00:00.000Z', withdrawal: { status: 'not_available', refundMinor: null, currency: null } }).withdrawal).toEqual({
        status: 'not_available',
        refundMinor: null,
        currency: null,
      });
      expect(normalisePublicCancelResult({ status: 'cancelled', withdrawal: { status: 'done', refundMinor: 2083, currency: 'USD' } }).withdrawal?.status).toBe('not_available');
      expect(normalisePublicCancelResult({ status: 'already_cancelled', accessUntil: 'x' })).toEqual({ status: 'already_cancelled', accessUntil: null, withdrawal: null });
    });
  });
});

