// @vitest-environment node
//
// Billing history (requirement ST-10; MARKET_STRATEGY §9.2, PAY S16):
// `getBillingHistory` and GET /api/v1/roboapply/billing/history.
//
//   - Stripe invoices are read page by page; drafts and voids are not listed;
//   - CN orders (completed `ra_` orders) are paged by the moment they were paid;
//   - the two lists are merged by date, newest first, under one opaque cursor;
//   - a refunded row carries `refunded: 'full' | 'partial'` (one RABillingRefund
//     query a page; a dispute counts as full), a WeChat Pay order carries
//     `channel: 'wechatpay'`; a row that says nothing new keeps exactly the
//     eight keys it had before (rule A10: the parity wave's A10 tests compare
//     rows with `toEqual` and are not edited).
//
// In-memory Prisma and a fake Stripe whose `invoices.list` honours `customer`,
// `limit` and `starting_after`. Nothing reaches Stripe or a database.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'], rABillingRefund: ['externalRef'], alipayOrder: ['outTradeNo'] } });
  return { default: fake.db };
});
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    req.user = { id, email: `${id}@example.test`, name: 'Test', brand: 'roboapply' };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import billingRouter from '../../../roboapply/routes/billing.js';
import {
  BILLING_HISTORY_DEFAULT_LIMIT,
  BILLING_HISTORY_MAX_LIMIT,
  RoboApplyBillingError,
  getBillingHistory,
  setBillingServiceDepsForTests,
  type BillingInvoice,
} from '../../../roboapply/services/RoboApplyBillingService.js';
import { logger } from '../../../services/LoggerService.js';
import { startRouteHarness, type RouteHarness } from '../../../test/routeHarness.js';

type Obj = Record<string, any>;

const NOW = new Date('2026-10-10T08:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const HOUR_S = 3600;
const PATH = '/api/v1/roboapply/billing/history';

// ── The fake Stripe account ───────────────────────────────────────────────

const account = { invoices: [] as Obj[] };

/** Newest first, one customer, after `starting_after`, at most `limit`: as Stripe lists. */
async function listInvoices(params: { customer: string; limit?: number; starting_after?: string }): Promise<{ data: Obj[]; has_more: boolean }> {
  const mine = account.invoices.filter((i) => i.customer === params.customer).sort((a, b) => b.created - a.created);
  const from = params.starting_after ? mine.findIndex((i) => i.id === params.starting_after) + 1 : 0;
  const limit = params.limit ?? 10;
  return { data: mine.slice(from, from + limit), has_more: mine.length > from + limit };
}

const stripe = { invoices: { list: vi.fn(listInvoices) } };

/** Invoice n was created n hours before now (n = 1 is the newest). */
function invoice(n: number, over: Obj = {}): Obj {
  return {
    id: `in_${String(n).padStart(3, '0')}`,
    customer: 'cus_1',
    status: 'paid',
    created: NOW_S - n * HOUR_S,
    amount_paid: 2499,
    amount_due: 2499,
    currency: 'usd',
    invoice_pdf: `https://pay.stripe.test/in_${n}.pdf`,
    lines: { data: [{ description: '1 × Pro Monthly' }] },
    ...over,
  };
}

/** Order n was paid n hours and 30 minutes before now, so orders and invoices interleave. */
async function order(n: number, over: Obj = {}) {
  const id = `o_${String(n).padStart(3, '0')}`;
  return fake.db.alipayOrder.create({
    data: {
      id,
      userId: 'u_1',
      outTradeNo: `RAORDER_${id}`,
      tier: 'ra_pro_monthly',
      planKey: 'pro_monthly',
      brand: 'goapply',
      channel: 'alipay',
      amount: 39,
      amountMinor: 3900,
      status: 'completed',
      completedAt: new Date((NOW_S - n * HOUR_S - 1800) * 1000),
      createdAt: new Date((NOW_S - n * HOUR_S - 2000) * 1000),
      ...over,
    },
  });
}

async function refundRow(over: Obj) {
  return fake.db.rABillingRefund.create({
    data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'refund', amountMinor: 2499, currency: 'USD', full: true, entitlementReversed: true, invoiceId: null, alipayOrderId: null, createdAt: NOW, ...over },
  });
}

const TABLES = ['user', 'seekerProfile', 'seekerSubscription', 'alipayOrder', 'rABillingRefund'];

async function seedUser(id: string, brand: 'roboapply' | 'goapply', customer: string | null) {
  await fake.db.user.create({ data: { id, email: `${id}@example.test`, name: id, brand } });
  await fake.db.seekerProfile.create({ data: { id: `sp_${id}`, userId: id, locale: 'en', deletedAt: null } });
  await fake.db.seekerSubscription.create({
    data: { id: `row_${id}`, seekerProfileId: `sp_${id}`, tier: 'free', status: 'active', brand, stripeCustomerId: customer, stripeSubscriptionId: null, cancelAtPeriodEnd: false },
  });
}

let h: RouteHarness;
beforeAll(async () => {
  h = await startRouteHarness({ mounts: [['/api/v1/roboapply/billing', billingRouter]] });
});
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  stripe.invoices.list.mockReset();
  stripe.invoices.list.mockImplementation(listInvoices);
  account.invoices = [];
  for (const t of TABLES) await fake.db[t].deleteMany({});
  await seedUser('u_1', 'roboapply', 'cus_1');
  setBillingServiceDepsForTests({ db: fake.db as never, getStripe: () => stripe as never, now: () => NOW, invalidate: () => {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  setBillingServiceDepsForTests();
});

/** Every page of a user's history, in order, with the number of pages read. */
async function allPages(userId: string, limit?: number): Promise<{ rows: BillingInvoice[]; pages: number[] }> {
  const rows: BillingInvoice[] = [];
  const pages: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const page: { invoices: BillingInvoice[]; nextCursor: string | null } = await getBillingHistory(userId, { cursor, ...(limit ? { limit } : {}) });
    rows.push(...page.invoices);
    pages.push(page.invoices.length);
    cursor = page.nextCursor;
    if (!cursor) return { rows, pages };
  }
  throw new Error('the history never ended');
}

const ids = (rows: BillingInvoice[]) => rows.map((r) => r.id);
const EIGHT_KEYS = ['amountMinor', 'currency', 'date', 'description', 'downloadable', 'id', 'kind', 'status'];

// ── What is listed ────────────────────────────────────────────────────────

describe('which Stripe invoices are listed', () => {
  it('drafts and voids are not listed; paid, open and uncollectible are', async () => {
    account.invoices = [
      invoice(1, { status: 'draft', amount_paid: 0 }),
      invoice(2),
      invoice(3, { status: 'void', amount_paid: 0 }),
      invoice(4, { status: 'open', amount_paid: 0, amount_due: 999 }),
      invoice(5, { status: 'uncollectible', amount_paid: 0, amount_due: 2499 }),
    ];
    const page = await getBillingHistory('u_1');
    expect(page.invoices.map((i) => [i.id, i.status, i.amountMinor])).toEqual([
      ['in_002', 'paid', 2499],
      ['in_004', 'open', 999],
      ['in_005', 'uncollectible', 2499],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('a Stripe row keeps the shape it had: eight keys, no channel and no refunded marker', async () => {
    account.invoices = [invoice(1)];
    const page = await getBillingHistory('u_1');
    expect(page.invoices).toEqual([
      { id: 'in_001', kind: 'stripe', date: new Date((NOW_S - HOUR_S) * 1000).toISOString(), amountMinor: 2499, currency: 'USD', status: 'paid', description: '1 × Pro Monthly', downloadable: true },
    ]);
    expect(Object.keys(page.invoices[0]!).sort()).toEqual(EIGHT_KEYS);
  });

  it('an invoice of another customer is never listed', async () => {
    await seedUser('u_2', 'roboapply', 'cus_2');
    account.invoices = [invoice(1), invoice(2, { customer: 'cus_2' }), invoice(3)];
    expect(ids((await getBillingHistory('u_1')).invoices)).toEqual(['in_001', 'in_003']);
    expect(ids((await getBillingHistory('u_2')).invoices)).toEqual(['in_002']);
    expect(stripe.invoices.list.mock.calls.map((c) => c[0].customer)).toEqual(['cus_1', 'cus_2']);

    // Even when the list itself hands back a stranger's invoice, it is dropped.
    stripe.invoices.list.mockResolvedValueOnce({ data: [invoice(4), invoice(5, { customer: 'cus_2' }), invoice(6, { customer: { id: 'cus_1' } })], has_more: false });
    expect(ids((await getBillingHistory('u_1')).invoices)).toEqual(['in_004', 'in_006']);
  });

  it('a GoApply account never makes the server ask Stripe, even with a customer id on its row', async () => {
    await seedUser('u_go', 'goapply', 'cus_go');
    account.invoices = [invoice(1, { customer: 'cus_go' })];
    await order(1, { userId: 'u_go' });
    const page = await getBillingHistory('u_go');
    expect(ids(page.invoices)).toEqual(['o_001']);
    expect(page.nextCursor).toBeNull();
    expect(stripe.invoices.list).not.toHaveBeenCalled();
  });
});

describe('CN orders', () => {
  it('an Alipay order that was not refunded is serialised with exactly the eight keys it has today', async () => {
    await order(1);
    const page = await getBillingHistory('u_1');
    expect(page.invoices).toEqual([
      { id: 'o_001', kind: 'alipay', date: new Date((NOW_S - HOUR_S - 1800) * 1000).toISOString(), amountMinor: 3900, currency: 'CNY', status: 'paid', description: 'GoApply 会员月卡 (Alipay)', downloadable: true },
    ]);
    expect(Object.keys(page.invoices[0]!).sort()).toEqual(EIGHT_KEYS);
    expect(page.invoices[0]).not.toHaveProperty('channel');
    expect(page.invoices[0]).not.toHaveProperty('refunded');
  });

  it('a WeChat Pay order says its channel; kind stays alipay for old clients', async () => {
    await order(1, { channel: 'wechatpay' });
    await order(2);
    const page = await getBillingHistory('u_1');
    expect(page.invoices.map((i) => [i.id, i.kind, i.channel])).toEqual([
      ['o_001', 'alipay', 'wechatpay'],
      ['o_002', 'alipay', undefined],
    ]);
    expect(page.invoices[0]!.description).toBe('GoApply 会员月卡 (WeChat Pay)');
  });

  it('only completed seeker orders of the caller are listed', async () => {
    await seedUser('u_2', 'goapply', null);
    await order(1);
    await order(2, { status: 'pending', completedAt: null });
    await order(3, { tier: 'growth', planKey: null });
    await order(4, { userId: 'u_2' });
    expect(ids((await getBillingHistory('u_1')).invoices)).toEqual(['o_001']);
    expect(ids((await getBillingHistory('u_2')).invoices)).toEqual(['o_004']);
  });
});

// ── The refunded marker ───────────────────────────────────────────────────

describe('the refunded marker', () => {
  it('a refunded invoice shows the marker: full, partial, a dispute counts as full, the last partial refund completes it', async () => {
    account.invoices = [invoice(1), invoice(2), invoice(3), invoice(4), invoice(5)];
    await refundRow({ externalRef: 'ch_1:2499', invoiceId: 'in_001', full: true });
    await refundRow({ externalRef: 'ch_2:1000', invoiceId: 'in_002', amountMinor: 1000, full: false });
    await refundRow({ externalRef: 'dispute:dp_3', invoiceId: 'in_003', kind: 'dispute', full: true });
    await refundRow({ externalRef: 'ch_4:1000', invoiceId: 'in_004', amountMinor: 1000, full: false });
    await refundRow({ externalRef: 'ch_4:2499', invoiceId: 'in_004', amountMinor: 1499, full: true });
    const page = await getBillingHistory('u_1');
    expect(page.invoices.map((i) => [i.id, i.refunded])).toEqual([
      ['in_001', 'full'],
      ['in_002', 'partial'],
      ['in_003', 'full'],
      ['in_004', 'full'],
      ['in_005', undefined],
    ]);
    expect(page.invoices[4]).not.toHaveProperty('refunded');
    // A refunded row stays listed and downloadable.
    expect(page.invoices[0]).toMatchObject({ status: 'paid', downloadable: true });
  });

  it('a CN order recorded by the manual refund record is marked, and stays in the history (rule A10)', async () => {
    await order(1);
    await order(2, { channel: 'wechatpay' });
    await order(3);
    await refundRow({ brand: 'goapply', rail: 'alipay', kind: 'manual_cn', externalRef: 'order:o_001', alipayOrderId: 'o_001', amountMinor: 3900, currency: 'CNY', full: true });
    await refundRow({ brand: 'goapply', rail: 'wechatpay', kind: 'manual_cn', externalRef: 'order:o_002', alipayOrderId: 'o_002', amountMinor: 1000, currency: 'CNY', full: false, entitlementReversed: false });
    const page = await getBillingHistory('u_1');
    expect(page.invoices.map((i) => [i.id, i.status, i.downloadable, i.channel, i.refunded])).toEqual([
      ['o_001', 'paid', true, undefined, 'full'],
      ['o_002', 'paid', true, 'wechatpay', 'partial'],
      ['o_003', 'paid', true, undefined, undefined],
    ]);
  });

  it('the markers of a page are read in one query, and a refund row of another user marks nothing', async () => {
    account.invoices = [invoice(1), invoice(2)];
    await order(1);
    await refundRow({ externalRef: 'ch_x:2499', invoiceId: 'in_001', userId: 'someone_else' });
    const reads = vi.spyOn(fake.db.rABillingRefund, 'findMany');
    const page = await getBillingHistory('u_1');
    expect(reads).toHaveBeenCalledTimes(1);
    expect(page.invoices.every((i) => i.refunded === undefined)).toBe(true);
  });

  it('when the refund rows cannot be read the history is still served, without markers', async () => {
    account.invoices = [invoice(1)];
    await order(1);
    await refundRow({ externalRef: 'ch_1:2499', invoiceId: 'in_001' });
    vi.spyOn(fake.db.rABillingRefund, 'findMany').mockRejectedValueOnce(new Error('relation does not exist'));
    const page = await getBillingHistory('u_1');
    expect(ids(page.invoices)).toEqual(['in_001', 'o_001']);
    expect(page.invoices[0]).not.toHaveProperty('refunded');
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── Paging ────────────────────────────────────────────────────────────────

describe('merged paging under one cursor', () => {
  it('45 Stripe invoices and 30 CN orders page through with no row repeated or skipped, newest first, and end with no cursor', async () => {
    account.invoices = Array.from({ length: 45 }, (_, i) => invoice(i + 1));
    for (let n = 1; n <= 30; n += 1) await order(n);

    const { rows, pages } = await allPages('u_1');
    expect(BILLING_HISTORY_DEFAULT_LIMIT).toBe(20);
    expect(pages).toEqual([20, 20, 20, 15]);
    expect(rows).toHaveLength(75);
    expect(new Set(ids(rows)).size).toBe(75);
    expect(rows.filter((r) => r.kind === 'stripe')).toHaveLength(45);
    expect(rows.filter((r) => r.kind === 'alipay')).toHaveLength(30);
    const dates = rows.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    // The first page interleaves the two sources by date.
    expect(ids(rows).slice(0, 4)).toEqual(['in_001', 'o_001', 'in_002', 'o_002']);
  });

  it.each([1, 2, 7, 19, 20, 33, 50])('with %i rows a page, and drafts and voids in between, every listed row appears exactly once', async (limit) => {
    account.invoices = Array.from({ length: 45 }, (_, i) => invoice(i + 1, i % 4 === 1 ? { status: 'draft' } : i % 9 === 3 ? { status: 'void' } : {}));
    for (let n = 1; n <= 30; n += 1) await order(n, n % 6 === 0 ? { channel: 'wechatpay' } : {});
    const listed = account.invoices.filter((i) => i.status === 'paid').map((i) => i.id);

    const { rows, pages } = await allPages('u_1', limit);
    expect(ids(rows).filter((id) => id.startsWith('in_'))).toEqual(listed);
    expect(ids(rows).filter((id) => id.startsWith('o_'))).toEqual(Array.from({ length: 30 }, (_, i) => `o_${String(i + 1).padStart(3, '0')}`));
    expect(new Set(ids(rows)).size).toBe(rows.length);
    expect(pages.slice(0, -1).every((n) => n === limit)).toBe(true);
    const dates = rows.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('orders paid in the same instant are told apart by their id', async () => {
    const sameMoment = new Date((NOW_S - HOUR_S) * 1000);
    for (let n = 1; n <= 7; n += 1) await order(n, { completedAt: sameMoment });
    const { rows } = await allPages('u_1', 3);
    expect(ids(rows).sort()).toEqual(['o_001', 'o_002', 'o_003', 'o_004', 'o_005', 'o_006', 'o_007']);
    expect(new Set(ids(rows)).size).toBe(7);
  });

  it('Stripe is read after the last invoice taken, and not at all once its side is finished', async () => {
    account.invoices = [invoice(1), invoice(2), invoice(3)];
    for (let n = 10; n <= 14; n += 1) await order(n);
    const first = await getBillingHistory('u_1', { limit: 2 });
    expect(ids(first.invoices)).toEqual(['in_001', 'in_002']);
    const second = await getBillingHistory('u_1', { limit: 2, cursor: first.nextCursor });
    expect(ids(second.invoices)).toEqual(['in_003', 'o_010']);
    expect(stripe.invoices.list.mock.calls[1]![0]).toMatchObject({ customer: 'cus_1', starting_after: 'in_002' });

    const calls = stripe.invoices.list.mock.calls.length;
    const third = await getBillingHistory('u_1', { limit: 2, cursor: second.nextCursor });
    expect(ids(third.invoices)).toEqual(['o_011', 'o_012']);
    expect(stripe.invoices.list.mock.calls.length).toBe(calls);
    const last = await getBillingHistory('u_1', { limit: 2, cursor: third.nextCursor });
    expect(ids(last.invoices)).toEqual(['o_013', 'o_014']);
    expect(last.nextCursor).toBeNull();
  });

  it('a page that ends exactly at the end of both lists has no next cursor', async () => {
    account.invoices = [invoice(1), invoice(2)];
    await order(1);
    await order(2);
    const page = await getBillingHistory('u_1', { limit: 4 });
    expect(page.invoices).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
  });

  it('the limit is held between 1 and 50, and the cursor is opaque but checked', async () => {
    account.invoices = Array.from({ length: 60 }, (_, i) => invoice(i + 1));
    expect(BILLING_HISTORY_MAX_LIMIT).toBe(50);
    expect((await getBillingHistory('u_1', { limit: 500 })).invoices).toHaveLength(50);
    expect((await getBillingHistory('u_1', { limit: 0 })).invoices).toHaveLength(1);
    for (const cursor of ['nonsense', Buffer.from('{"s":1}').toString('base64url'), Buffer.from('[]').toString('base64url'), Buffer.from(JSON.stringify({ s: 'in_1', sDone: false, c: 'no-date|o_1', cDone: false })).toString('base64url')]) {
      const err = await getBillingHistory('u_1', { cursor }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, cursor).toBeInstanceOf(RoboApplyBillingError);
      expect([(err as RoboApplyBillingError).code, (err as RoboApplyBillingError).status]).toEqual(['invalid_request', 422]);
    }
  });
});

describe('when Stripe cannot be read', () => {
  it('a Stripe list failure still returns the CN orders', async () => {
    account.invoices = [invoice(1)];
    await order(1);
    await order(2);
    stripe.invoices.list.mockRejectedValueOnce(new Error('stripe is down'));
    const page = await getBillingHistory('u_1');
    expect(ids(page.invoices)).toEqual(['o_001', 'o_002']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('the next page asks Stripe again, and paging ends even when Stripe stays down', async () => {
    account.invoices = [invoice(1), invoice(2)];
    for (let n = 1; n <= 3; n += 1) await order(n);
    stripe.invoices.list.mockRejectedValueOnce(new Error('stripe is down'));
    const first = await getBillingHistory('u_1', { limit: 2 });
    expect(ids(first.invoices)).toEqual(['o_001', 'o_002']);
    // Stripe answers again: its invoices are not lost.
    const second = await getBillingHistory('u_1', { limit: 2, cursor: first.nextCursor });
    expect(ids(second.invoices)).toEqual(['in_001', 'in_002']);
    const third = await getBillingHistory('u_1', { limit: 2, cursor: second.nextCursor });
    expect(ids(third.invoices)).toEqual(['o_003']);
    expect(third.nextCursor).toBeNull();

    // Down for good: the pages run out instead of offering "more" for ever.
    stripe.invoices.list.mockRejectedValue(new Error('stripe is down'));
    const { rows, pages } = await allPages('u_1', 2);
    expect(ids(rows)).toEqual(['o_001', 'o_002', 'o_003']);
    expect(pages.length).toBeLessThanOrEqual(3);
  });

  it('without a Stripe client only the CN orders are listed', async () => {
    setBillingServiceDepsForTests({ db: fake.db as never, getStripe: () => null, now: () => NOW, invalidate: () => {} });
    account.invoices = [invoice(1)];
    await order(1);
    const page = await getBillingHistory('u_1');
    expect(ids(page.invoices)).toEqual(['o_001']);
    expect(page.nextCursor).toBeNull();
  });
});

// ── The route ─────────────────────────────────────────────────────────────

describe('GET /billing/history', () => {
  const AS = { headers: { 'x-test-user': 'u_1' } };

  it('answers { invoices, nextCursor } with 20 rows by default, and follows ?cursor and ?limit', async () => {
    account.invoices = Array.from({ length: 25 }, (_, i) => invoice(i + 1));
    await order(1, { channel: 'wechatpay' });
    await refundRow({ externalRef: 'ch_2:2499', invoiceId: 'in_002' });

    const first = await h.request<any>('GET', PATH, AS);
    expect(first.status).toBe(200);
    expect(Object.keys(first.body.data).sort()).toEqual(['invoices', 'nextCursor']);
    expect(first.body.data.invoices).toHaveLength(20);
    expect(first.body.data.invoices.slice(0, 3)).toEqual([
      expect.objectContaining({ id: 'in_001', kind: 'stripe' }),
      { id: 'o_001', kind: 'alipay', date: expect.any(String), amountMinor: 3900, currency: 'CNY', status: 'paid', description: 'GoApply 会员月卡 (WeChat Pay)', downloadable: true, channel: 'wechatpay' },
      expect.objectContaining({ id: 'in_002', kind: 'stripe', refunded: 'full' }),
    ]);
    // The keys are left out, never null, when they do not apply.
    expect(first.text).not.toContain('"refunded":null');
    expect(first.text).not.toContain('"channel":null');

    const rest = await h.request<any>('GET', `${PATH}?limit=50&cursor=${encodeURIComponent(first.body.data.nextCursor)}`, AS);
    expect(rest.body.data.invoices).toHaveLength(6);
    expect(rest.body.data.nextCursor).toBeNull();

    const small = await h.request<any>('GET', `${PATH}?limit=5`, AS);
    expect(small.body.data.invoices).toHaveLength(5);
  });

  it('refuses a limit outside 1 to 50 and an unreadable cursor with 422, and needs a session', async () => {
    for (const query of ['limit=0', 'limit=51', 'limit=abc', 'limit=2.5', 'cursor=nonsense']) {
      const res = await h.request<any>('GET', `${PATH}?${query}`, AS);
      expect([query, res.status, res.body.code]).toEqual([query, 422, 'invalid_request']);
    }
    expect((await h.request<any>('GET', PATH)).status).toBe(401);
  });
});
