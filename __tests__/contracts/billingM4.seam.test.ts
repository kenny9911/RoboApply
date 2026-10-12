// @vitest-environment node
//
// Market wave M4 gate: the seams between the billing servers (MKT-4A: the
// withdrawal routes, signed in and on the public cancel link; MKT-4B: the admin
// refund, the mainland refund record, the practice cost, the Stripe readout
// and the paged invoice history) and the billing web (MKT-4C). The three were
// built in separate worktrees against the contract text of
// MARKET_TASK_PLAN.md 3.1: the web types every request and answer by hand and
// reads answers through normalisers, the server tests assert their own
// responses, so neither side proves that the web SENDS what the server accepts
// and READS what the server sends. This file holds them together, route by
// route:
//
//   - the path and method the web calls is a route the server mounts;
//   - the body (or query) the web sends parses with the server's own schema
//     (the body schemas of the withdrawal routes are strict: one extra key is 422);
//   - an answer typed with the server's own response type (`satisfies`, checked
//     by `npm run typecheck:web`) goes through JSON and the web's reader, and
//     every field arrives.
//
// No network, no database, no Stripe: the web's HTTP client is a recording fake
// and the server routers are only built, never called.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/src/lib/prisma.js', () => ({ default: {} }));
vi.mock('../../server/src/services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const http = vi.hoisted(() => ({
  calls: [] as Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }>,
  answer: null as unknown,
}));

vi.mock('../../lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wire = () => JSON.parse(JSON.stringify(http.answer ?? null)) as unknown;
  return {
    ...actual,
    roboApi: {
      get: vi.fn(async (path: string) => {
        http.calls.push({ method: 'GET', path });
        return wire();
      }),
      post: vi.fn(async (path: string, body?: unknown) => {
        http.calls.push({ method: 'POST', path, body });
        return wire();
      }),
    },
  };
});

import { accountApi, invoiceChannel, invoiceRefunded } from '../../lib/api/account';
import { adminBillingApi, stripeEndpointState } from '../../lib/api/adminBilling';
import type {
  PublicCancelConfirmResponse,
  PublicCancelPreviewResponse,
  WithdrawResponse,
  WithdrawalResponse,
} from '../../server/src/features/credits/contract';
import { PublicCancelConfirmBodySchema, PublicCancelPreviewBodySchema, WithdrawBodySchema } from '../../server/src/features/credits/contract';
import type {
  AdminCnOrdersResponse,
  AdminRefundListResponse,
  AdminRefundResponse,
  PracticeCostResponse,
  RecordCnRefundResponse,
  StripeHealthResponse,
} from '../../server/src/features/credits/adminBillingTypes';
import {
  AdminCnOrderParamsSchema,
  AdminCnOrdersQuerySchema,
  AdminRefundBodySchema,
  AdminRefundListQuerySchema,
  RecordCnRefundBodySchema,
  StripeHealthQuerySchema,
} from '../../server/src/features/credits/adminBillingTypes';
import { EXPECTED_STRIPE_EVENTS } from '../../server/src/platform/billing/stripeHealth';
import type { BillingHistoryPage } from '../../server/src/roboapply/services/RoboApplyBillingService';

const ADMIN = '/api/v1/roboapply/admin/credits';
const CREDITS = '/api/v1/roboapply/credits';
const PUBLIC_CANCEL = '/api/v1/public/cancel';
const BILLING = '/api/v1/roboapply/billing';

/** method + path (Express patterns) of every route the three credit routers and the legacy billing router mount. */
let mounted: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
  const { FEATURE_MOUNTS } = await import('../../server/src/features/index');
  const noop = (_req: unknown, _res: unknown, next: () => void) => next();
  const deps = { seekerAuth: [noop], adminAuth: [noop], optionalAuth: [noop], extensionAuth: [noop] };
  type Stack = Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  const routesOf = (base: string, stack: Stack) =>
    stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((method) => ({ method: method.toUpperCase(), path: `${base}${layer.route!.path === '/' ? '' : layer.route!.path}` })) : []));
  const out: typeof mounted = [];
  for (const mount of FEATURE_MOUNTS.filter((m) => m.area === 'credits')) out.push(...routesOf(mount.path, (mount.build(deps as never) as unknown as { stack: Stack }).stack));
  // The invoice history is a route of the legacy billing router (roboapply/routes/billing.ts, mounted at /billing).
  const billing = (await import('../../server/src/roboapply/routes/billing')).default as unknown as { stack: Stack };
  out.push(...routesOf(BILLING, billing.stack));
  mounted = out;
}, 60_000);

/** Is `path` (a concrete URL path, no query) a mounted route of `method`? `:param` segments match one segment. */
function isMounted(method: string, path: string): boolean {
  return mounted.some((r) => r.method === method && new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
}

const lastCall = () => http.calls[http.calls.length - 1]!;
const pathOf = (url: string) => url.split('?')[0]!;
const queryOf = (url: string) => Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));

beforeEach(() => {
  http.calls.length = 0;
  http.answer = null;
});

describe('the routes the billing web calls are mounted (M4: MKT-4A, MKT-4B to MKT-4C)', () => {
  it('found the routers', () => {
    expect(mounted.length).toBeGreaterThan(20);
    for (const [method, path] of [
      ['GET', `${CREDITS}/withdrawal`],
      ['POST', `${CREDITS}/withdrawal`],
      ['POST', `${PUBLIC_CANCEL}/preview`],
      ['POST', `${PUBLIC_CANCEL}/confirm`],
      ['GET', `${BILLING}/history`],
      ['POST', `${ADMIN}/refunds`],
      ['GET', `${ADMIN}/refunds`],
      ['GET', `${ADMIN}/cn-orders`],
      ['POST', `${ADMIN}/cn-orders/ord_1/refund`],
      ['GET', `${ADMIN}/practice-cost`],
      ['GET', `${ADMIN}/stripe-health`],
    ] as const) {
      expect(isMounted(method, path), `${method} ${path}`).toBe(true);
    }
    expect(isMounted('GET', `${ADMIN}/no-such-route`)).toBe(false);
  });
});

describe('statutory withdrawal, signed in (MKT-4A to MKT-4C)', () => {
  const answer = {
    available: true,
    purchase: { source: 'stripe', id: 'in_plan', planKey: 'pro_monthly', chargedAt: '2026-10-06T08:00:00.000Z', amountMinor: 2499, currency: 'USD' },
    quote: { rule: 'withdrawal_14d_prorata', refundMinor: 2083, currency: 'USD', deadline: '2026-10-20T08:00:00.000Z', prorata: { usedDays: 5, periodDays: 30 }, endsAccess: true, region: 'eu' },
    purchases: [
      {
        purchase: { source: 'stripe', id: 'in_plan', planKey: 'pro_monthly', chargedAt: '2026-10-06T08:00:00.000Z', amountMinor: 2499, currency: 'USD' },
        quote: { rule: 'withdrawal_14d_prorata', refundMinor: 2083, currency: 'USD', deadline: '2026-10-20T08:00:00.000Z', prorata: { usedDays: 5, periodDays: 30 }, endsAccess: true, region: 'eu' },
      },
      {
        purchase: { source: 'stripe', id: 'in_pack', planKey: 'practice_pack_5', chargedAt: '2026-10-04T08:00:00.000Z', amountMinor: 999, currency: 'USD' },
        quote: { rule: 'withdrawal_14d', refundMinor: 999, currency: 'USD', deadline: '2026-10-18T08:00:00.000Z', prorata: null, endsAccess: true, region: 'eu' },
      },
    ],
  } satisfies WithdrawalResponse;

  it('GET /credits/withdrawal: every open purchase reaches the page, in the server\'s order, with its amount, rule, deadline and day counts', async () => {
    http.answer = answer;
    const read = await accountApi.withdrawal();
    expect(lastCall()).toEqual({ method: 'GET', path: `${CREDITS}/withdrawal` });
    expect(isMounted('GET', pathOf(lastCall().path))).toBe(true);
    expect(read.available).toBe(true);
    expect(read.options.map((o) => [o.purchase.id, o.purchase.planKey, o.purchase.amountMinor, o.purchase.currency, o.purchase.chargedAt])).toEqual(
      answer.purchases.map((o) => [o.purchase.id, o.purchase.planKey, o.purchase.amountMinor, o.purchase.currency, o.purchase.chargedAt]),
    );
    expect(read.options.map((o) => [o.quote.rule, o.quote.refundMinor, o.quote.currency, o.quote.deadline, o.quote.prorata])).toEqual(
      answer.purchases.map((o) => [o.quote.rule, o.quote.refundMinor, o.quote.currency, o.quote.deadline, o.quote.prorata]),
    );
    // GoApply, outside the countries, after the 14 days: nothing is offered.
    http.answer = { available: false, purchase: null, quote: null, purchases: [] } satisfies WithdrawalResponse;
    expect(await accountApi.withdrawal()).toMatchObject({ available: false, options: [] });
  });

  it('POST /credits/withdrawal: the body is exactly what the strict schema accepts, and only `withdrawn` is read as a withdrawal', async () => {
    http.answer = { status: 'withdrawn', refundMinor: 2083, currency: 'USD', accessEnded: true } satisfies WithdrawResponse;
    const done = await accountApi.withdraw('in_plan');
    expect(lastCall().method).toBe('POST');
    expect(isMounted('POST', lastCall().path)).toBe(true);
    expect(WithdrawBodySchema.safeParse(lastCall().body).success).toBe(true);
    expect(lastCall().body).toEqual({ purchaseId: 'in_plan', confirm: true });
    expect(done).toMatchObject({ status: 'withdrawn', refundMinor: 2083, currency: 'USD' });
    // The schema is strict: a body with one more key would be refused, so the web must send nothing else.
    expect(WithdrawBodySchema.safeParse({ purchaseId: 'in_plan', confirm: true, withdraw: true }).success).toBe(false);
  });
});

describe('the public cancel link with the withdrawal choice (MKT-4A to MKT-4C)', () => {
  const TOKEN = 'tok_0123456789abcdef0123456789abcdef';

  it('preview: { token } in, the plan, the end of the period and the open withdrawal out', async () => {
    http.answer = { planKey: 'pro_monthly', accessUntil: '2026-11-05T08:00:00.000Z', withdrawal: { refundMinor: 2083, currency: 'USD', rule: 'withdrawal_14d_prorata', deadline: '2026-10-20T08:00:00.000Z' } } satisfies PublicCancelPreviewResponse;
    const preview = await accountApi.previewPublicCancel(TOKEN);
    expect(isMounted('POST', lastCall().path)).toBe(true);
    expect(lastCall().path).toBe(`${PUBLIC_CANCEL}/preview`);
    expect(PublicCancelPreviewBodySchema.safeParse(lastCall().body).success).toBe(true);
    expect(preview).toEqual({ planKey: 'pro_monthly', accessUntil: '2026-11-05T08:00:00.000Z', withdrawal: { refundMinor: 2083, currency: 'USD', rule: 'withdrawal_14d_prorata', deadline: '2026-10-20T08:00:00.000Z' } });
    // No withdrawal open (or Stripe unreadable, or the 21st preview of a link): the page is the one-button page.
    http.answer = { planKey: 'pro_monthly', accessUntil: '2026-11-05T08:00:00.000Z', withdrawal: null } satisfies PublicCancelPreviewResponse;
    expect((await accountApi.previewPublicCancel(TOKEN)).withdrawal).toBeNull();
  });

  it('confirm: an ordinary cancel sends exactly { token }, a withdrawal { token, withdraw: true }; the three answers are read', async () => {
    http.answer = { status: 'cancelled', accessUntil: '2026-11-05T08:00:00.000Z', alternative: null } satisfies PublicCancelConfirmResponse;
    expect(await accountApi.confirmPublicCancel({ token: TOKEN })).toEqual({ status: 'cancelled', accessUntil: '2026-11-05T08:00:00.000Z', withdrawal: null });
    expect(lastCall().body).toEqual({ token: TOKEN });
    expect(await accountApi.confirmPublicCancel({ token: TOKEN, withdraw: false })).toMatchObject({ withdrawal: null });
    expect(lastCall().body).toEqual({ token: TOKEN });

    http.answer = { status: 'cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'withdrawn', refundMinor: 2083, currency: 'USD' } } satisfies PublicCancelConfirmResponse;
    expect(await accountApi.confirmPublicCancel({ token: TOKEN, withdraw: true })).toEqual({ status: 'cancelled', accessUntil: null, withdrawal: { status: 'withdrawn', refundMinor: 2083, currency: 'USD' } });
    expect(lastCall()).toMatchObject({ method: 'POST', path: `${PUBLIC_CANCEL}/confirm`, body: { token: TOKEN, withdraw: true } });
    for (const call of http.calls) expect(PublicCancelConfirmBodySchema.safeParse(call.body).success, JSON.stringify(call.body)).toBe(true);
    expect(isMounted('POST', lastCall().path)).toBe(true);

    // Not open any more: cancelled at the end of the period instead. And a plan a withdrawal elsewhere already ended.
    http.answer = { status: 'cancelled', accessUntil: '2026-11-05T08:00:00.000Z', alternative: null, withdrawal: { status: 'not_available', refundMinor: null, currency: null } } satisfies PublicCancelConfirmResponse;
    expect(await accountApi.confirmPublicCancel({ token: TOKEN, withdraw: true })).toMatchObject({ status: 'cancelled', withdrawal: { status: 'not_available', refundMinor: null, currency: null } });
    http.answer = { status: 'already_cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'not_available', refundMinor: null, currency: null } } satisfies PublicCancelConfirmResponse;
    expect(await accountApi.confirmPublicCancel({ token: TOKEN, withdraw: true })).toMatchObject({ status: 'already_cancelled', withdrawal: { status: 'not_available' } });
  });
});

describe('the invoice history, paged, with the channel and the refunded marker (MKT-4B to MKT-4C)', () => {
  it('GET /billing/history?cursor=&limit=: the query parses with the route\'s schema; channel and refunded are read only where the server sends them', async () => {
    const { HistoryQuerySchema } = await import('../../server/src/roboapply/routes/billing');
    http.answer = {
      invoices: [
        { id: 'in_1', kind: 'stripe', date: '2026-10-06T08:00:00.000Z', amountMinor: 2499, currency: 'USD', status: 'paid', description: 'Pro monthly', downloadable: true, refunded: 'partial' },
        { id: 'ord_wx', kind: 'alipay', date: '2026-10-05T08:00:00.000Z', amountMinor: 3900, currency: 'CNY', status: 'paid', description: '月卡', downloadable: true, channel: 'wechatpay', refunded: 'full' },
        { id: 'ord_ali', kind: 'alipay', date: '2026-10-04T08:00:00.000Z', amountMinor: 3900, currency: 'CNY', status: 'paid', description: '月卡', downloadable: true },
      ],
      nextCursor: 'eyJzIjoiaW5fMSJ9',
    } satisfies BillingHistoryPage;
    const first = await accountApi.history();
    expect(lastCall().method).toBe('GET');
    expect(isMounted('GET', pathOf(lastCall().path))).toBe(true);
    expect(HistoryQuerySchema.safeParse(queryOf(lastCall().path))).toMatchObject({ success: true, data: { limit: 20 } });
    expect(first.nextCursor).toBe('eyJzIjoiaW5fMSJ9');
    expect(first.invoices.map((inv) => [inv.id, invoiceChannel(inv), invoiceRefunded(inv)])).toEqual([
      ['in_1', 'card', 'partial'],
      ['ord_wx', 'wechatpay', 'full'],
      ['ord_ali', 'alipay', null],
    ]);
    // The next page sends the cursor back as it came.
    http.answer = { invoices: [], nextCursor: null } satisfies BillingHistoryPage;
    expect(await accountApi.history(first.nextCursor)).toEqual({ invoices: [], nextCursor: null });
    expect(HistoryQuerySchema.safeParse(queryOf(lastCall().path))).toMatchObject({ success: true, data: { cursor: 'eyJzIjoiaW5fMSJ9', limit: 20 } });
  });
});

describe('the admin console: refund, refunds list, mainland record, practice cost, Stripe (MKT-4B to MKT-4C)', () => {
  const ATTEMPT = '0b9d7f6e-2a41-4c63-9d0e-5f1a2b3c4d5e';

  it('POST /admin/credits/refunds: the body parses, carries the attempt key (carry-over MKT-4B.2a), and the answer is read', async () => {
    http.answer = { refundId: 're_1', amountMinor: 1000, currency: 'usd', full: false } satisfies AdminRefundResponse;
    const made = await adminBillingApi.issueRefund({ userId: ' u_1 ', target: { invoiceId: 'in_0123456789' }, amountMinor: 1000, reason: ' Charged twice ', attemptKey: ATTEMPT });
    expect(isMounted('POST', lastCall().path)).toBe(true);
    const parsed = AdminRefundBodySchema.safeParse(lastCall().body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ userId: 'u_1', target: { invoiceId: 'in_0123456789' }, amountMinor: 1000, reason: 'Charged twice', attemptKey: ATTEMPT });
    expect(made).toEqual({ refundId: 're_1', amountMinor: 1000, currency: 'USD', full: false });
    // "Everything": no amount. A one-time payment: the Checkout Session.
    await adminBillingApi.issueRefund({ userId: 'u_1', target: { checkoutSessionId: 'cs_0123456789' }, reason: 'Duplicate', attemptKey: ATTEMPT });
    expect(AdminRefundBodySchema.safeParse(lastCall().body)).toMatchObject({ success: true, data: { target: { checkoutSessionId: 'cs_0123456789' }, attemptKey: ATTEMPT } });
    expect(lastCall().body).not.toHaveProperty('amountMinor');
  });

  it('GET /admin/credits/refunds: the query parses, and a row keeps its fifteen fields', async () => {
    const row = {
      id: 'rf_1',
      userId: 'u_1',
      brand: 'roboapply',
      rail: 'stripe',
      kind: 'withdrawal',
      amountMinor: 2083,
      currency: 'USD',
      full: false,
      entitlementReversed: true,
      reason: 'statutory withdrawal',
      actor: 'self',
      invoiceId: 'in_1',
      checkoutSessionId: null,
      alipayOrderId: null,
      createdAt: '2026-10-11T08:00:00.000Z',
    } satisfies AdminRefundListResponse['items'][number];
    http.answer = { items: [row, { ...row, id: 'rf_2', kind: 'dispute', full: true, actor: 'stripe' }], cursor: '2026-10-11T08:00:00.000Z|rf_2' } satisfies AdminRefundListResponse;
    const page = await adminBillingApi.listRefunds(' u_1 ', '2026-10-12T08:00:00.000Z|rf_9');
    expect(isMounted('GET', pathOf(lastCall().path))).toBe(true);
    expect(AdminRefundListQuerySchema.safeParse(queryOf(lastCall().path))).toMatchObject({ success: true, data: { userId: 'u_1', cursor: '2026-10-12T08:00:00.000Z|rf_9' } });
    expect(page.items[0]).toEqual(row);
    expect(Object.keys(page.items[0]!).sort()).toEqual(Object.keys(row).sort());
    expect(page.items[1]).toMatchObject({ kind: 'dispute', full: true, actor: 'stripe' });
    expect(page.cursor).toBe('2026-10-11T08:00:00.000Z|rf_2');
  });

  it('GET /admin/credits/cn-orders: the marker and the half-finished record reach the console', async () => {
    http.answer = {
      items: [
        { id: 'ord_1', outTradeNo: 'RAORDER_1', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: '2026-10-01T08:00:00.000Z', refunded: 'full', reversalPending: true },
        { id: 'ord_2', outTradeNo: 'RAORDER_2', planKey: 'practice_pack_5', channel: 'wechatpay', amountMinor: 2900, completedAt: '2026-10-02T08:00:00.000Z', refunded: null },
      ],
    } satisfies AdminCnOrdersResponse;
    const orders = await adminBillingApi.listCnOrders('cn_1');
    expect(isMounted('GET', pathOf(lastCall().path))).toBe(true);
    expect(AdminCnOrdersQuerySchema.safeParse(queryOf(lastCall().path))).toMatchObject({ success: true, data: { userId: 'cn_1' } });
    expect(orders.items).toEqual([
      { id: 'ord_1', outTradeNo: 'RAORDER_1', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: '2026-10-01T08:00:00.000Z', refunded: 'full', reversalPending: true },
      { id: 'ord_2', outTradeNo: 'RAORDER_2', planKey: 'practice_pack_5', channel: 'wechatpay', amountMinor: 2900, completedAt: '2026-10-02T08:00:00.000Z', refunded: null, reversalPending: false },
    ]);
  });

  it('POST /admin/credits/cn-orders/:orderId/refund: the path carries the order id, the body parses, both statuses are read', async () => {
    http.answer = { status: 'recorded', orderId: 'ord_1', entitlement: 'pass_ended' } satisfies RecordCnRefundResponse;
    expect(await adminBillingApi.recordCnRefund('ord_1', { reason: ' Returned in the console ', confirmMoneyReturned: true })).toEqual({ status: 'recorded', orderId: 'ord_1', entitlement: 'pass_ended' });
    expect(lastCall().path).toBe(`${ADMIN}/cn-orders/ord_1/refund`);
    expect(isMounted('POST', lastCall().path)).toBe(true);
    expect(AdminCnOrderParamsSchema.safeParse({ orderId: lastCall().path.split('/').at(-2) }).success).toBe(true);
    expect(RecordCnRefundBodySchema.safeParse(lastCall().body)).toMatchObject({ success: true, data: { reason: 'Returned in the console', confirmMoneyReturned: true } });
    http.answer = { status: 'already_recorded', orderId: 'ord_1', entitlement: 'none' } satisfies RecordCnRefundResponse;
    expect(await adminBillingApi.recordCnRefund('ord_1', { reason: 'Part', confirmMoneyReturned: true, refundedAmountMinor: 900 })).toEqual({ status: 'already_recorded', orderId: 'ord_1', entitlement: 'none' });
    expect(RecordCnRefundBodySchema.safeParse(lastCall().body)).toMatchObject({ success: true, data: { refundedAmountMinor: 900 } });
  });

  it('GET /admin/credits/practice-cost: both brands, with the server\'s own sample sizes', async () => {
    const cost = { sampleSize: 50, averageUsd: 0.4123, enough: true, maxSessions: 50, minSessions: 10, oldest: '2026-09-01T08:00:00.000Z', newest: '2026-10-10T08:00:00.000Z' } satisfies PracticeCostResponse['brands']['roboapply'];
    http.answer = { brands: { roboapply: cost, goapply: { ...cost, sampleSize: 4, averageUsd: null, enough: false } } } satisfies PracticeCostResponse;
    const read = await adminBillingApi.practiceCost();
    expect(isMounted('GET', lastCall().path)).toBe(true);
    expect(read.brands.roboapply).toEqual(cost);
    expect(read.brands.goapply).toMatchObject({ sampleSize: 4, averageUsd: null, enough: false, maxSessions: 50, minSessions: 10 });
  });

  it('GET /admin/credits/stripe-health: the seven fields, and the server\'s "no endpoint" answer as its own state', async () => {
    const healthy = {
      keyMode: 'test',
      usable: true,
      refusedReason: null,
      webhookSecrets: 1,
      railReady: true,
      endpoint: { checked: true, url: 'https://www.roboapply.io/api/v1/roboapply/billing/webhook', missingEvents: ['charge.refunded'] },
      pinnedPlans: ['pro_monthly'],
    } satisfies StripeHealthResponse;
    http.answer = healthy;
    const read = await adminBillingApi.stripeHealth();
    expect(isMounted('GET', pathOf(lastCall().path))).toBe(true);
    // The console asks for the default answer (no price check): the query the route parses is empty.
    expect(StripeHealthQuerySchema.safeParse(queryOf(lastCall().path))).toMatchObject({ success: true, data: { prices: false } });
    expect(read).toMatchObject({ keyMode: 'test', usable: true, refusedReason: null, webhookSecrets: 1, railReady: true, pinnedPlans: ['pro_monthly'] });
    expect(read.endpoint).toMatchObject({ checked: true, url: healthy.endpoint.url, missingEvents: ['charge.refunded'] });
    expect(stripeEndpointState(read)).toBe('missing');
    // No endpoint points at this site: `checked: true`, no address, every expected event listed, reason `not_found`.
    http.answer = { ...healthy, endpoint: { checked: true, url: null, missingEvents: [...EXPECTED_STRIPE_EVENTS], reason: 'not_found' } } satisfies StripeHealthResponse;
    expect(stripeEndpointState(await adminBillingApi.stripeHealth())).toBe('no_endpoint');
    // A live key outside production: nothing was asked of Stripe.
    http.answer = { keyMode: 'live', usable: false, refusedReason: 'live_key_outside_production', webhookSecrets: 1, railReady: false, endpoint: { checked: false, url: null, missingEvents: [] }, pinnedPlans: [] } satisfies StripeHealthResponse;
    const refused = await adminBillingApi.stripeHealth();
    expect(refused).toMatchObject({ keyMode: 'live', usable: false, refusedReason: 'live_key_outside_production', railReady: false });
    expect(stripeEndpointState(refused)).toBe('unchecked');
  });
});
