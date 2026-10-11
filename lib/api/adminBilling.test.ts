// lib/api/adminBilling — the admin billing calls of /admin/credits (MKT-4C;
// server MKT-4B, built in parallel). These tests pin what the web SENDS for
// each route of the contract (MARKET_TASK_PLAN §3.1) and how each documented
// answer is read, with the safe default for anything else. No network:
// `fetch` is stubbed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CN_RECHECK_REASON,
  PRACTICE_COST_MAX_SESSIONS,
  PRACTICE_COST_MIN_SESSIONS,
  REFUND_ATTEMPT_KEY_PATTERN,
  SECRET_SHAPED,
  adminBillingApi,
  adminRefundRequestBody,
  cnRefundRequestBody,
  cnReversalOpen,
  normaliseAdminRefund,
  normaliseAdminRefunds,
  normaliseCnOrders,
  normaliseCnRefund,
  normalisePracticeCost,
  normaliseStripeHealth,
  parseAmountMinor,
  refundTargetId,
  refundTargetOf,
  stripeEndpointState,
  stripeUncheckedReason,
} from './adminBilling';
// The server's own endpoint check, run here against a fake client: the shapes the console must read are its answers.
import { EXPECTED_STRIPE_EVENTS, checkStripeWebhookEndpoint } from '../../server/src/platform/billing/stripeHealth';

const KEY = '3f2b8c1e-6a4d-4f0b-9c2e-7d1a5b8e9f00';

function answer(data: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const request = (fetchMock: ReturnType<typeof answer>, call = 0) => {
  const [url, init] = fetchMock.mock.calls[call]!;
  return { url, method: init?.method, body: init?.body === undefined || init?.body === null ? undefined : (JSON.parse(String(init.body)) as unknown) };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('this file is not a documented wrapper file', () => {
  it('uses the plain client and does not import the contract wire (so the mount-table test does not scan it before the server half merges)', () => {
    const src = readFileSync(join(process.cwd(), 'lib/api/adminBilling.ts'), 'utf8');
    expect(src).not.toMatch(/from '\.\/contracts\//);
    expect(src).toMatch(/from '\.\/client'/);
  });
});

describe('refund through Stripe: POST /admin/credits/refunds', () => {
  it('sends the user, the target, the reason and the attempt key; an amount only when one is given', async () => {
    const fetchMock = answer({ refundId: 're_1', amountMinor: 2499, currency: 'usd', full: true });
    const res = await adminBillingApi.issueRefund({ userId: ' u1 ', target: { invoiceId: 'in_12345678' }, reason: ' Charged twice ', attemptKey: KEY });
    expect(res).toEqual({ refundId: 're_1', amountMinor: 2499, currency: 'USD', full: true });
    const req = request(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/\/api\/v1\/roboapply\/admin\/credits\/refunds$/);
    expect(req.body).toEqual({ userId: 'u1', target: { invoiceId: 'in_12345678' }, reason: 'Charged twice', attemptKey: KEY });
    await adminBillingApi.issueRefund({ userId: 'u1', target: { checkoutSessionId: 'cs_test_12345678' }, amountMinor: 1000, reason: 'Partial', attemptKey: KEY });
    expect(request(fetchMock, 1).body).toEqual({ userId: 'u1', target: { checkoutSessionId: 'cs_test_12345678' }, amountMinor: 1000, reason: 'Partial', attemptKey: KEY });
  });

  it('money is whole minor units: a fraction, zero or a negative amount is never sent; nor is a key in a form the server would refuse', () => {
    const base = { userId: 'u1', target: { invoiceId: 'in_12345678' }, reason: 'x' };
    for (const amountMinor of [0, -5, 10.5, Number.NaN]) expect('amountMinor' in adminRefundRequestBody({ ...base, amountMinor }), String(amountMinor)).toBe(false);
    expect(adminRefundRequestBody({ ...base, amountMinor: 1 })).toMatchObject({ amountMinor: 1 });
    for (const attemptKey of ['short', 'has space in it', 'a'.repeat(65), '']) expect('attemptKey' in adminRefundRequestBody({ ...base, attemptKey }), attemptKey).toBe(false);
    expect(String(REFUND_ATTEMPT_KEY_PATTERN)).toBe('/^[A-Za-z0-9_-]{8,64}$/');
    expect(REFUND_ATTEMPT_KEY_PATTERN.test(KEY)).toBe(true);
  });

  it('an answer without an amount states none (the console then says only that the refund was sent)', () => {
    expect(normaliseAdminRefund({ refundId: 're_1' })).toEqual({ refundId: 're_1', amountMinor: null, currency: null, full: null });
    expect(normaliseAdminRefund({ refundId: 're_1', amountMinor: 500, full: false })).toEqual({ refundId: 're_1', amountMinor: null, currency: null, full: false });
    expect(normaliseAdminRefund(null)).toEqual({ refundId: null, amountMinor: null, currency: null, full: null });
  });

  it('a pasted id names an invoice or a Checkout Session, or nothing', () => {
    expect(refundTargetOf(' in_1PabcDEF2345 ')).toEqual({ invoiceId: 'in_1PabcDEF2345' });
    expect(refundTargetOf('cs_test_a1B2c3D4e5F6')).toEqual({ checkoutSessionId: 'cs_test_a1B2c3D4e5F6' });
    for (const bad of ['', 'in_', 'in_short', 'pi_12345678901', 'ch_12345678901', 're_12345678901', 'sub_12345678901', 'in_1234 5678', null, undefined]) expect(refundTargetOf(bad), String(bad)).toBeNull();
    expect(refundTargetId({ invoiceId: 'in_12345678' })).toBe('in_12345678');
    expect(refundTargetId({ checkoutSessionId: 'cs_12345678' })).toBe('cs_12345678');
  });
});

describe('refunds, withdrawals and disputes of one user: GET /admin/credits/refunds', () => {
  const row = { id: 'r1', userId: 'u1', brand: 'roboapply', rail: 'stripe', kind: 'refund', amountMinor: 2499, currency: 'usd', full: true, entitlementReversed: true, reason: 'Charged twice', actor: 'admin_1', invoiceId: 'in_12345678', checkoutSessionId: null, alipayOrderId: null, createdAt: '2026-10-10T12:00:00.000Z' };

  it('asks with the user id, then with the cursor it was given', async () => {
    const fetchMock = answer({ items: [row], cursor: 'next-1' });
    const page = await adminBillingApi.listRefunds(' u1 ');
    expect(request(fetchMock).method).toBe('GET');
    expect(request(fetchMock).url).toMatch(/\/api\/v1\/roboapply\/admin\/credits\/refunds\?userId=u1$/);
    expect(page.cursor).toBe('next-1');
    expect(page.items[0]).toEqual({ ...row, currency: 'USD' });
    await adminBillingApi.listRefunds('u1', page.cursor);
    expect(request(fetchMock, 1).url).toMatch(/\/refunds\?userId=u1&cursor=next-1$/);
  });

  it('every kind of the contract is kept; a kind this build does not know is "other", never a refund', () => {
    const kinds = normaliseAdminRefunds({ items: ['refund', 'withdrawal', 'dispute', 'manual_cn', 'chargeback_v2'].map((kind, i) => ({ ...row, id: `r${i}`, kind })) }).items.map((r) => r.kind);
    expect(kinds).toEqual(['refund', 'withdrawal', 'dispute', 'manual_cn', 'other']);
  });

  it('rows without an id are dropped; an amount without its currency is not stated; no cursor is the end', () => {
    const page = normaliseAdminRefunds({ items: [{ ...row, id: '' }, null, { ...row, id: 'r2', currency: null }, { id: 'r3' }] });
    expect(page.items.map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(page.items[0]).toMatchObject({ amountMinor: null, currency: null });
    expect(page.items[1]).toMatchObject({ kind: 'other', full: false, entitlementReversed: false, reason: null, actor: null });
    expect(page.cursor).toBeNull();
    for (const raw of [null, 'x', {}, { items: 'no' }]) expect(normaliseAdminRefunds(raw)).toEqual({ items: [], cursor: null });
  });
});

describe('mainland orders and the manual refund record (AL-7)', () => {
  const order = { id: 'ord_1', outTradeNo: 'RAORDER_20261001_abc', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: '2026-10-01T12:00:00.000Z', refunded: null };

  it('GET /admin/credits/cn-orders?userId= and the three refund markers', async () => {
    const fetchMock = answer({ items: [order, { ...order, id: 'ord_2', channel: 'wechatpay', refunded: 'full' }, { ...order, id: 'ord_3', refunded: 'partial' }, { ...order, id: 'ord_4', refunded: 'yes' }] });
    const res = await adminBillingApi.listCnOrders('u1');
    expect(request(fetchMock).method).toBe('GET');
    expect(request(fetchMock).url).toMatch(/\/api\/v1\/roboapply\/admin\/credits\/cn-orders\?userId=u1$/);
    expect(res.items.map((o) => [o.id, o.channel, o.refunded])).toEqual([
      ['ord_1', 'alipay', null],
      ['ord_2', 'wechatpay', 'full'],
      ['ord_3', 'alipay', 'partial'],
      ['ord_4', 'alipay', null],
    ]);
    expect(normaliseCnOrders(null)).toEqual({ items: [] });
  });

  it('"reversal pending" is read only as the server\'s own true; a server that does not send it reads as false', () => {
    const rows = normaliseCnOrders({ items: [order, { ...order, id: 'ord_2', refunded: 'full', reversalPending: true }, { ...order, id: 'ord_3', refunded: 'full', reversalPending: 'yes' }] }).items;
    expect(rows.map((o) => o.reversalPending)).toEqual([false, true, false]);
  });

  it('the refunds list says which full mainland refund is on record with no access taken back', () => {
    const page = normaliseAdminRefunds({
      items: [
        { id: 'r1', kind: 'manual_cn', full: true, entitlementReversed: false, alipayOrderId: 'ord_1', reason: ' Refunded in the console ', amountMinor: 3900, currency: 'CNY' },
        // Access taken back, a partial record, another kind, no order: none of these is open.
        { id: 'r2', kind: 'manual_cn', full: true, entitlementReversed: true, alipayOrderId: 'ord_2', reason: 'x' },
        { id: 'r3', kind: 'manual_cn', full: false, entitlementReversed: false, alipayOrderId: 'ord_3', reason: 'x' },
        { id: 'r4', kind: 'refund', full: true, entitlementReversed: false, alipayOrderId: 'ord_4', reason: 'x' },
        { id: 'r5', kind: 'manual_cn', full: true, entitlementReversed: false, alipayOrderId: null, reason: 'x' },
        { id: 'r6', kind: 'manual_cn', full: true, entitlementReversed: false, alipayOrderId: 'ord_6' },
      ],
    });
    const open = cnReversalOpen(page.items);
    expect([...open.keys()]).toEqual(['ord_1', 'ord_6']);
    expect(open.get('ord_1')).toEqual({ reason: 'Refunded in the console' });
    // No reason on the row: the caller sends the fixed one, which the server accepts as a reason (1 to 300 characters).
    expect(open.get('ord_6')).toEqual({ reason: null });
    expect(CN_RECHECK_REASON.trim().length).toBeGreaterThan(0);
    expect(CN_RECHECK_REASON.length).toBeLessThanOrEqual(300);
    expect(cnReversalOpen([]).size).toBe(0);
  });

  it('POST /admin/credits/cn-orders/:orderId/refund sends the reason and confirmMoneyReturned: true; an amount only for a partial record', async () => {
    const fetchMock = answer({ status: 'recorded', orderId: 'ord_1', entitlement: 'pass_ended' });
    expect(await adminBillingApi.recordCnRefund('ord/1', { reason: ' Asked by phone ', confirmMoneyReturned: true })).toEqual({ status: 'recorded', orderId: 'ord_1', entitlement: 'pass_ended' });
    const req = request(fetchMock);
    expect(req.method).toBe('POST');
    expect(req.url).toMatch(/\/api\/v1\/roboapply\/admin\/credits\/cn-orders\/ord%2F1\/refund$/);
    expect(req.body).toEqual({ reason: 'Asked by phone', confirmMoneyReturned: true });
    await adminBillingApi.recordCnRefund('ord_1', { reason: 'Half back', confirmMoneyReturned: true, refundedAmountMinor: 1900 });
    expect(request(fetchMock, 1).body).toEqual({ reason: 'Half back', confirmMoneyReturned: true, refundedAmountMinor: 1900 });
    expect(cnRefundRequestBody({ reason: 'x', confirmMoneyReturned: true, refundedAmountMinor: 0 })).toEqual({ reason: 'x', confirmMoneyReturned: true });
  });

  it('"already recorded" is an answer, not an error; an answer that names neither status is not confirmed', () => {
    expect(normaliseCnRefund({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'none' })).toEqual({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'none' });
    expect(normaliseCnRefund({ status: 'recorded', orderId: 'ord_1', entitlement: 'something_new' })).toEqual({ status: 'recorded', orderId: 'ord_1', entitlement: null });
    for (const e of ['pass_ended', 'pass_shortened', 'pack_zeroed', 'none']) expect(normaliseCnRefund({ status: 'recorded', entitlement: e }).entitlement).toBe(e);
    for (const raw of [{}, null, { status: 'ok' }]) expect(() => normaliseCnRefund(raw), JSON.stringify(raw)).toThrow('Unexpected refund record answer');
  });
});

describe('practice-session cost (PC-5): GET /admin/credits/practice-cost', () => {
  const cost = { sampleSize: 50, averageUsd: 0.8421, enough: true, maxSessions: 50, minSessions: 10, oldest: '2026-09-01T00:00:00.000Z', newest: '2026-10-10T00:00:00.000Z' };

  it('reads both brands as sent', async () => {
    const fetchMock = answer({ brands: { roboapply: cost, goapply: { ...cost, sampleSize: 4, averageUsd: null, enough: false } } });
    const res = await adminBillingApi.practiceCost();
    expect(request(fetchMock).url).toMatch(/\/api\/v1\/roboapply\/admin\/credits\/practice-cost$/);
    expect(res.brands.roboapply).toEqual(cost);
    expect(res.brands.goapply).toEqual({ ...cost, sampleSize: 4, averageUsd: null, enough: false });
  });

  it('never an average from a thin sample: without "enough" there is none, whatever number came with it', () => {
    expect(normalisePracticeCost({ brands: { roboapply: { ...cost, enough: false } } }).brands.roboapply).toMatchObject({ enough: false, averageUsd: null });
    expect(normalisePracticeCost({ brands: { roboapply: { ...cost, averageUsd: null } } }).brands.roboapply).toMatchObject({ enough: false, averageUsd: null });
    expect(normalisePracticeCost({ brands: { roboapply: { ...cost, averageUsd: -1 } } }).brands.roboapply).toMatchObject({ enough: false, averageUsd: null });
  });

  it('a brand the server did not answer for is null, never an empty sample; the two sizes fall back to the contract\'s', () => {
    expect(normalisePracticeCost({ brands: { roboapply: cost } }).brands.goapply).toBeNull();
    expect(normalisePracticeCost(null).brands).toEqual({ roboapply: null, goapply: null });
    expect(normalisePracticeCost({ brands: { roboapply: { sampleSize: 3 } } }).brands.roboapply).toEqual({ sampleSize: 3, averageUsd: null, enough: false, maxSessions: 50, minSessions: 10, oldest: null, newest: null });
    expect([PRACTICE_COST_MAX_SESSIONS, PRACTICE_COST_MIN_SESSIONS]).toEqual([50, 10]);
    // The server's own sizes win when it sends them.
    expect(normalisePracticeCost({ brands: { roboapply: { ...cost, maxSessions: 80, minSessions: 20 } } }).brands.roboapply).toMatchObject({ maxSessions: 80, minSessions: 20 });
  });
});

describe('Stripe health (ST-3): GET /admin/credits/stripe-health', () => {
  const health = { keyMode: 'test', usable: true, refusedReason: null, webhookSecrets: 1, railReady: true, endpoint: { checked: true, url: 'https://www.example.test/api/v1/roboapply/stripe/webhook', missingEvents: ['charge.refunded', 'charge.dispute.created'] }, pinnedPlans: ['pro_monthly'] };

  it('reads the readout as sent', async () => {
    const fetchMock = answer(health);
    const res = await adminBillingApi.stripeHealth();
    expect(request(fetchMock).url).toMatch(/\/api\/v1\/roboapply\/admin\/credits\/stripe-health$/);
    expect(res).toEqual({ ...health, endpoint: { ...health.endpoint, reason: null } });
  });

  it('a live key refused outside production, and a restricted key that cannot read the endpoint', () => {
    expect(normaliseStripeHealth({ keyMode: 'live', usable: false, refusedReason: 'live_key_outside_production', webhookSecrets: 0, railReady: false, endpoint: { checked: false, url: null, missingEvents: [] }, pinnedPlans: [] })).toMatchObject({
      keyMode: 'live',
      usable: false,
      refusedReason: 'live_key_outside_production',
      railReady: false,
      endpoint: { checked: false, missingEvents: [], reason: null },
    });
    const restricted = normaliseStripeHealth({ ...health, endpoint: { checked: false, url: null, missingEvents: ['left.over'], reason: 'restricted_key' } });
    // Not checked: nothing is known about the events, so none is listed.
    expect(restricted.endpoint).toEqual({ checked: false, url: null, missingEvents: [], reason: 'restricted_key' });
  });

  describe('what is known about the webhook endpoint (one reading for the Stripe panel and the System view)', () => {
    /** The readout around the server's own check of these endpoints. */
    const readoutOf = async (endpoints: Array<{ url: string; status: string; enabled_events: string[] }>, fail?: unknown) => {
      const stripe = {
        webhookEndpoints: {
          list: async () => {
            if (fail) throw fail;
            return { data: endpoints.map((e, i) => ({ id: `we_${i}`, ...e })), has_more: false };
          },
        },
      };
      const check = await checkStripeWebhookEndpoint(stripe as never, { origin: 'https://www.example.test' });
      return normaliseStripeHealth({ ...health, endpoint: check });
    };
    const HOOK = 'https://www.example.test/api/v1/roboapply/stripe/webhook';

    it('no endpoint in Stripe: the server answers a check that was made, every event missing, reason not_found; the console reads "no endpoint", never "events are missing"', async () => {
      const readout = await readoutOf([]);
      // The server's shape, as the console receives it.
      expect(readout.endpoint).toEqual({ checked: true, url: null, missingEvents: [...EXPECTED_STRIPE_EVENTS], reason: 'not_found' });
      expect(readout.endpoint.missingEvents).toHaveLength(14);
      expect(stripeEndpointState(readout)).toBe('no_endpoint');
      // A disabled endpoint, or one on another path, is no endpoint either.
      expect(stripeEndpointState(await readoutOf([{ url: HOOK, status: 'disabled', enabled_events: ['*'] }]))).toBe('no_endpoint');
      expect(stripeEndpointState(await readoutOf([{ url: 'https://www.example.test/other', status: 'enabled', enabled_events: ['*'] }]))).toBe('no_endpoint');
    });

    it('an endpoint that sends everything, one that misses events, and one that could not be read', async () => {
      expect(stripeEndpointState(await readoutOf([{ url: HOOK, status: 'enabled', enabled_events: ['*'] }]))).toBe('complete');
      const partial = await readoutOf([{ url: HOOK, status: 'enabled', enabled_events: EXPECTED_STRIPE_EVENTS.filter((e) => e !== 'charge.refunded') }]);
      expect(stripeEndpointState(partial)).toBe('missing');
      expect(partial.endpoint.missingEvents).toEqual(['charge.refunded']);
      const restricted = await readoutOf([], { type: 'StripePermissionError', statusCode: 403 });
      expect(stripeEndpointState(restricted)).toBe('unchecked');
      expect(stripeUncheckedReason(restricted)).toBe('restricted_key');
      const down = await readoutOf([], new Error('socket hang up'));
      expect(stripeEndpointState(down)).toBe('unchecked');
      expect(stripeUncheckedReason(down)).toBe('error');
    });

    it('"no endpoint" is its own answer whatever `checked` says', () => {
      expect(stripeEndpointState(normaliseStripeHealth({ ...health, endpoint: { checked: false, url: null, missingEvents: [], reason: 'not_found' } }))).toBe('no_endpoint');
    });

    it('not checked with no reason: "no key" only when the key cannot be used; a usable key gets no reason at all', () => {
      const unchecked = { checked: false, url: null, missingEvents: [] };
      expect(stripeUncheckedReason(normaliseStripeHealth({ ...health, usable: false, refusedReason: 'missing', endpoint: unchecked }))).toBe('no_key');
      expect(stripeUncheckedReason(normaliseStripeHealth({ ...health, usable: true, endpoint: unchecked }))).toBeNull();
      // A stated reason wins over the guess.
      expect(stripeUncheckedReason(normaliseStripeHealth({ ...health, usable: false, endpoint: { ...unchecked, reason: 'error' } }))).toBe('error');
    });
  });

  it('a malformed answer claims nothing: not ready, not usable, key mode not stated', () => {
    expect(normaliseStripeHealth(null)).toEqual({ keyMode: null, usable: false, refusedReason: null, webhookSecrets: null, railReady: false, endpoint: { checked: false, url: null, missingEvents: [], reason: null }, pinnedPlans: [] });
    expect(normaliseStripeHealth({ keyMode: 'sandbox', usable: 'yes', railReady: 1 })).toMatchObject({ keyMode: null, usable: false, railReady: false });
  });

  it('nothing shaped like a key, a signing secret or a price id is ever handed to the page', () => {
    const leaky = normaliseStripeHealth({
      ...health,
      endpoint: { checked: true, url: 'https://x.test/hook?key=sk_live_abc123', missingEvents: ['invoice.paid', 'whsec_abc123', 'sk_test_abc123', 'rk_live_abc123'] },
      pinnedPlans: ['pro_monthly', 'price_1Pabc123'],
    });
    expect(leaky.endpoint.url).toBeNull();
    expect(leaky.endpoint.missingEvents).toEqual(['invoice.paid']);
    expect(leaky.pinnedPlans).toEqual(['pro_monthly']);
    expect(JSON.stringify(leaky)).not.toMatch(/sk_|rk_|whsec_|price_/);
    // Event names and plan keys never look like one.
    for (const ok of ['charge.refunded', 'customer.subscription.pending_update_applied', 'pro_week_pass', 'practice_pack_15', 'student_monthly']) expect(SECRET_SHAPED.test(ok), ok).toBe(false);
  });
});

describe('parseAmountMinor: an amount typed by staff, as whole minor units', () => {
  it('reads the digits as text (never a float)', () => {
    expect(parseAmountMinor('10')).toBe(1000);
    expect(parseAmountMinor('10.5')).toBe(1050);
    expect(parseAmountMinor('10.50')).toBe(1050);
    expect(parseAmountMinor(' 0.07 ')).toBe(7);
    expect(parseAmountMinor('19.99')).toBe(1999);
    // 4.35 * 100 is 434.99999999999994 in floating point; the text gives 435.
    expect(parseAmountMinor('4.35')).toBe(435);
    expect(parseAmountMinor('1234567.89')).toBe(123456789);
  });

  it('refuses anything that is not a positive amount with at most two decimals', () => {
    for (const bad of ['', ' ', '0', '0.00', '-5', '1.234', '1,50', '1e3', 'abc', '$10', '10.', '.5', '1 000', null, undefined]) expect(parseAmountMinor(bad), String(bad)).toBeNull();
  });
});
