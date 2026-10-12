// @vitest-environment node
//
// Admin billing (bundle MKT-4B; MARKET_STRATEGY §4.4, §5.1, §5.3 G13, §7 item 17):
//   POST/GET /admin/credits/refunds          the audited Stripe refund and the list of refund rows (ST-4)
//   GET /admin/credits/cn-orders             the manual refund record of a CN order (AL-7)
//   POST /admin/credits/cn-orders/:id/refund
//   GET /admin/credits/practice-cost         average cost of the last 50 practice sessions (PC-5)
//   GET /admin/credits/stripe-health         key mode, guard, webhook secrets, endpoint events (ST-3)
//
// The routes run on the route harness behind the real `requireAdmin`. The
// database is the in-memory Prisma; Stripe is a fake installed with
// `setStripeClientForTests`; the audit store is a fake behind the real
// `writeAdminAudit`. The refund engine, `fulfilPass` and the practice-credit
// service are the REAL ones on that same in-memory database, so what a test
// reads is what an account would hold. Nothing reaches Stripe, a payment
// worker or a database.
//
// The in-memory `$transaction` has no rollback. Where a test is about what a
// transaction that throws leaves behind, the database is wrapped in
// `withRollback`, which restores the claim ledger as Postgres would.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  fake.db = createFakePrisma({ uniqueFields: { rACreditLedger: ['idempotencyKey'], rABillingRefund: ['externalRef'], alipayOrder: ['outTradeNo'] } });
  return { default: fake.db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import '../../lib/prisma.js';
import { requireAdmin } from '../../middleware/admin.js';
import { getMockPlanCatalog } from '../../lib/mockInterviewPlans.js';
import {
  billingEventClaimKey,
  fulfilPass,
  getPlanCatalog,
  grantPracticePack,
  issueRefund,
  reversePassPeriod,
  setStripeClientForTests,
  setStripeRefundDepsForTests,
  stripeEventHandler,
} from '../../platform/billing/index.js';
import { packGrantId } from '../../platform/billing/packs.js';
import { stripeLookupKey } from '../../platform/billing/stripeCatalog.js';
import { EXPECTED_STRIPE_EVENTS } from '../../platform/billing/stripeHealth.js';
import { getBillingHistory, setBillingServiceDepsForTests } from '../../roboapply/services/RoboApplyBillingService.js';
import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../test/routeHarness.js';
import { writeAdminAudit, type AdminAuditRow, type AdminAuditStore } from '../admin/audit.js';
import { AdminBillingService, CN_REVERSAL_HANDOVER_MS, PRACTICE_SKU, type PracticeCostPage, type PracticeCostRow } from './adminBilling.js';
import { refundedMarkOf } from './adminBillingTypes.js';
import { createCreditsAdminRouter } from './adminRoutes.js';

type Obj = Record<string, any>;

const DAY_MS = 86_400_000;
const T0 = new Date('2026-10-01T08:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY_MS);
const clock = { now: at(2) };

const BASE = '/api/v1/roboapply/admin/credits';

// ── The fake Stripe account ───────────────────────────────────────────────

const account = {
  invoices: new Map<string, Obj>(),
  sessions: new Map<string, Obj>(),
  /** invoice id → its payments. */
  payments: new Map<string, Obj[]>(),
  endpoints: [] as Obj[],
  /** Idempotency key → the refund it made: a repeated key gets the stored answer and moves no money, as at Stripe. */
  refundsByKey: new Map<string, Obj>(),
  /** price id → the price Stripe holds. */
  prices: new Map<string, Obj>(),
  seq: 0,
};

/** The refunds the account holds, newest first, as Stripe lists them. */
const accountRefunds = () => [...account.refundsByKey.values()].sort((a, b) => b.created - a.created);

function stripeError(over: Obj): Error {
  return Object.assign(new Error(over.message ?? 'stripe error'), over);
}

const stripe = {
  invoices: {
    retrieve: vi.fn(async (id: string) => {
      const inv = account.invoices.get(id);
      if (!inv) throw stripeError({ code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError', message: `No such invoice: '${id}'` });
      return inv;
    }),
  },
  invoicePayments: {
    // By invoice (the refund engine), or by the payment intent that paid one (the webhook).
    list: vi.fn(async (params: { invoice?: string; payment?: { payment_intent?: string } }) => {
      if (params.invoice) return { data: account.payments.get(params.invoice) ?? [] };
      const paid = [...account.payments.entries()].find(([, list]) => list.some((p) => p.payment?.payment_intent === params.payment?.payment_intent));
      return { data: paid ? [{ invoice: account.invoices.get(paid[0]) }] : [] };
    }),
  },
  checkout: {
    sessions: {
      retrieve: vi.fn(async (id: string) => {
        const s = account.sessions.get(id);
        if (!s) throw stripeError({ code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError', message: `No such session: '${id}'` });
        return s;
      }),
    },
  },
  refunds: {
    create: vi.fn(async (params: Obj, opts: { idempotencyKey: string }) => {
      const replayed = account.refundsByKey.get(opts.idempotencyKey);
      if (replayed) return replayed;
      const n = ++account.seq;
      const refund = { id: `re_${n}`, amount: params.amount ?? 2499, currency: 'usd', charge: 'ch_1', payment_intent: params.payment_intent, metadata: params.metadata, status: 'succeeded', created: 1_800_000_000 + n };
      account.refundsByKey.set(opts.idempotencyKey, refund);
      return refund;
    }),
    list: vi.fn(async (params: { payment_intent?: string; charge?: string } = {}) => ({
      data: accountRefunds().filter((r) => (params.payment_intent ? r.payment_intent === params.payment_intent : true) && (params.charge ? r.charge === params.charge : true)),
    })),
  },
  subscriptions: {
    cancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
  },
  webhookEndpoints: {
    list: vi.fn(async (_params?: Obj) => ({ data: account.endpoints, has_more: false })),
  },
  prices: {
    retrieve: vi.fn(async (id: string) => {
      const price = account.prices.get(id);
      if (!price) throw stripeError({ code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError', message: `No such price: '${id}'` });
      return price;
    }),
    list: vi.fn(async (params: { lookup_keys?: string[] }) => ({ data: [...account.prices.values()].filter((p) => (params.lookup_keys ?? []).includes(p.lookup_key)) })),
  },
};

const refundCall = (n = 0) => stripe.refunds.create.mock.calls[n] as unknown as [Obj, { idempotencyKey: string }];
const stripeWrites = () => stripe.refunds.create.mock.calls.length;
function stripeCalls(): number {
  return [
    stripe.invoices.retrieve,
    stripe.invoicePayments.list,
    stripe.checkout.sessions.retrieve,
    stripe.refunds.create,
    stripe.refunds.list,
    stripe.subscriptions.cancel,
    stripe.webhookEndpoints.list,
    stripe.prices.retrieve,
    stripe.prices.list,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);
}

// ── Audit, env, practice rows, service, harness ───────────────────────────

const auditRows: AdminAuditRow[] = [];
const auditStore: AdminAuditStore = {
  record: async (row) => void auditRows.push(row),
  list: async () => [],
};
const invalidated: string[] = [];
const env: { current: Record<string, string | undefined> } = { current: {} };
const practice: {
  rows: Record<string, PracticeCostRow[]>;
  reads: Array<{ brand: string } & PracticeCostPage>;
  /** Runs after each page is read (a session that is written while the readout is paging). */
  afterRead: ((brand: string) => void) | null;
} = { rows: { roboapply: [], goapply: [] }, reads: [], afterRead: null };

/** What the usage log answers: the rows older than the cursor, newest first (`createdAt`, then `id`). */
function practicePage(rows: readonly PracticeCostRow[], page: PracticeCostPage): PracticeCostRow[] {
  const at = (r: { createdAt: Date }) => r.createdAt.getTime();
  const before = page.before;
  return [...rows]
    .sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .filter((r) => !before || at(r) < at(before) || (at(r) === at(before) && r.id < before.id))
    .slice(0, page.take);
}

const billing = new AdminBillingService({
  db: () => fake.db as never,
  now: () => clock.now,
  env: () => env.current,
  audit: (input) => writeAdminAudit(auditStore, input),
  invalidate: (userId) => void invalidated.push(userId),
  practiceCostRows: async (brand, page) => {
    practice.reads.push({ brand, ...page });
    const rows = practicePage(practice.rows[brand] ?? [], page);
    practice.afterRead?.(brand);
    return rows;
  },
});

/**
 * The in-memory database with what Postgres does to a transaction that
 * throws: the claims it wrote are gone. (The fake runs a transaction against
 * the live store and keeps whatever it wrote.)
 */
function withRollback(db: Obj): Obj {
  return new Proxy(db, {
    get(target, prop: string) {
      if (prop !== '$transaction') return target[prop];
      return async (fn: (tx: Obj) => Promise<unknown>) => {
        const before = [...db.$rows('rACreditLedger')];
        try {
          return await fn(db);
        } catch (err) {
          const live = db.$rows('rACreditLedger');
          live.length = 0;
          live.push(...before);
          throw err;
        }
      };
    },
  });
}

const USERS: Record<string, HarnessUser> = {
  admin: { id: 'admin_1', email: 'admin@example.test', role: 'admin' },
  seeker: { id: 'u_1', email: 'u_1@example.test', role: 'user' },
};
const AS_ADMIN = { headers: { 'x-test-user': 'admin' } };
const AS_SEEKER = { headers: { 'x-test-user': 'seeker' } };

let h: RouteHarness;

beforeAll(async () => {
  const pick = fakeAuth((req) => USERS[String(req.headers['x-test-user'] ?? '')] ?? null);
  h = await startRouteHarness({ mounts: [[BASE, createCreditsAdminRouter({ adminAuth: [pick, requireAdmin], billing })]] });
});
afterAll(async () => {
  await h.close();
});

const TABLES = ['user', 'seekerProfile', 'seekerSubscription', 'seekerConsentRecord', 'rACreditLedger', 'rACreditGrant', 'rABillingRefund', 'mockInterviewCreditLedger', 'alipayOrder'];

/** What decides a person's access: everything but the claim ledger. */
const ACCESS_TABLES = TABLES.filter((t) => t !== 'rACreditLedger');

let FREE_ALLOTMENT = 1;

/** Everything a money action may touch, without the columns that only say when a row was last written. */
async function state(tables: readonly string[] = TABLES): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = (await fake.db[t].findMany({})).map(({ updatedAt: _updatedAt, ...rest }: Obj) => rest);
  return JSON.stringify(out);
}

beforeEach(async () => {
  vi.clearAllMocks();
  account.invoices.clear();
  account.sessions.clear();
  account.payments.clear();
  account.endpoints = [];
  account.refundsByKey.clear();
  account.prices.clear();
  account.seq = 0;
  auditRows.length = 0;
  invalidated.length = 0;
  env.current = {};
  practice.rows = { roboapply: [], goapply: [] };
  practice.reads = [];
  practice.afterRead = null;
  clock.now = at(2);
  for (const t of TABLES) await fake.db[t].deleteMany({});
  FREE_ALLOTMENT = (await getMockPlanCatalog()).plans.free.credits;
  setStripeClientForTests(stripe as never);
  // The webhook handlers (the dispute test) take their mail and invalidation from here.
  setStripeRefundDepsForTests({ sendEmail: (async () => ({ status: 'sent' })) as never, invalidate: () => {} });
});

afterEach(() => {
  setStripeClientForTests(undefined);
  setStripeRefundDepsForTests();
  setBillingServiceDepsForTests();
});

// ── Seeds ─────────────────────────────────────────────────────────────────

/** A RoboApply subscriber with a Stripe customer and one paid invoice. */
async function seedStripeUser(over: { id?: string; brand?: string; customer?: string } = {}) {
  const id = over.id ?? 'u_1';
  await fake.db.user.create({ data: { id, email: `${id}@example.test`, name: 'U', brand: over.brand ?? 'roboapply' } });
  await fake.db.seekerProfile.create({ data: { id: `sp_${id}`, userId: id, locale: 'en', market: 'other', deletedAt: null } });
  await fake.db.seekerSubscription.create({
    data: {
      id: `row_${id}`,
      seekerProfileId: `sp_${id}`,
      tier: 'pro',
      status: 'active',
      brand: over.brand ?? 'roboapply',
      rail: 'stripe',
      planKey: 'pro_monthly',
      interval: 'month',
      stripeCustomerId: over.customer ?? 'cus_1',
      stripeSubscriptionId: 'sub_1',
      currentPeriodEnd: at(30),
      cancelAtPeriodEnd: false,
      mockCredits: 3,
      mockCreditsPeriodAllotment: 3,
    },
  });
}

function seedInvoice(id = 'in_1', customer = 'cus_1', paymentIntent = 'pi_inv') {
  account.invoices.set(id, {
    id,
    customer,
    status: 'paid',
    amount_paid: 2499,
    currency: 'usd',
    metadata: {},
    parent: { subscription_details: { subscription: 'sub_1', metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'pro_monthly' } } },
  });
  account.payments.set(id, [{ id: 'inpay_1', status: 'paid', payment: { type: 'payment_intent', payment_intent: paymentIntent } }]);
}

const REFUND = { userId: 'u_1', target: { invoiceId: 'in_1' }, reason: 'Charged twice', attemptKey: 'dialog-0001' };

/** A GoApply buyer with a Free plan row (the practice balance lives on it). */
async function seedCnUser(over: { id?: string; mockCredits?: number } = {}) {
  const id = over.id ?? 'cn_1';
  await fake.db.user.create({ data: { id, email: `${id}@example.test`, name: 'CN', brand: 'goapply' } });
  await fake.db.seekerProfile.create({ data: { id: `sp_${id}`, userId: id, locale: 'zh', market: 'cn', deletedAt: null } });
  await fake.db.seekerSubscription.create({
    data: {
      id: `row_${id}`,
      seekerProfileId: `sp_${id}`,
      tier: 'free',
      status: 'active',
      brand: 'goapply',
      planKey: 'free',
      interval: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      startedAt: null,
      cancelAtPeriodEnd: false,
      mockCredits: over.mockCredits ?? 0,
      mockCreditsRenewedAt: at(-1),
      mockCreditsPeriodAllotment: 1,
    },
  });
}

async function seedOrder(over: Obj = {}) {
  return fake.db.alipayOrder.create({
    data: {
      id: 'o_1',
      userId: 'cn_1',
      outTradeNo: `RAORDER_${over.id ?? 'o_1'}`,
      tier: 'ra_pro_monthly',
      planKey: 'pro_monthly',
      brand: 'goapply',
      channel: 'alipay',
      purpose: 'subscription',
      amount: 39,
      amountMinor: 3900,
      status: 'pending',
      completedAt: null,
      createdAt: at(0),
      ...over,
    },
  });
}

/** The practice balance going up by a pack's credits (the idempotent ledger grant behind it needs a real database). */
async function addPracticeCredits(userId: string, credits: number) {
  const row = await fake.db.seekerSubscription.findUnique({ where: { id: `row_${userId}` } });
  const balanceAfter = Number(row.mockCredits ?? 0) + credits;
  await fake.db.seekerSubscription.update({ where: { id: row.id }, data: { mockCredits: balanceAfter } });
  return { status: 'granted' as const, ledgerId: null, balanceAfter };
}

/**
 * Pay a pending order the way the Alipay callback does: through the real
 * `fulfilPass` (never edited by this bundle) and, for a pack, the real
 * `grantPracticePack`, which writes the grant row the refund record looks up.
 */
async function pay(outTradeNo: string, when: Date, channel: 'alipay' | 'wechatpay' = 'alipay') {
  const res = await fulfilPass(
    { outTradeNo, channel, paidAmountMinor: null },
    {
      getDb: async () => fake.db as never,
      now: () => when,
      grantPack: (input) => grantPracticePack(input, { getDb: async () => fake.db as never, grant: (async (userId: string, _reason: string, _key: string, opts: { credits: number }) => addPracticeCredits(userId, opts.credits)) as never }),
      invalidate: () => {},
      notifyPaid: async () => {},
    },
  );
  expect(res.status).toBe('fulfilled');
  return res;
}

const planRow = (id = 'cn_1') => fake.db.seekerSubscription.findUnique({ where: { id: `row_${id}` } });
const refundRows = () => fake.db.rABillingRefund.findMany({ orderBy: { externalRef: 'asc' } });
const claims = async () => (await fake.db.rACreditLedger.findMany({})).map((r: Obj) => r.idempotencyKey).sort();
const record = (orderId: string, body: Obj = { reason: 'Bought twice by mistake', confirmMoneyReturned: true }, who = AS_ADMIN) =>
  h.request<any>('POST', `${BASE}/cn-orders/${orderId}/refund`, { ...who, body });

// ══ Stripe refunds ════════════════════════════════════════════════════════

describe('POST /refunds: an audited Stripe refund that changes no access', () => {
  beforeEach(async () => {
    await seedStripeUser();
    seedInvoice();
  });

  it('refunds an invoice with one Stripe call under the refund idempotency key and writes one audit row naming the admin and the user', async () => {
    const before = await state(ACCESS_TABLES);
    const res = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { refundId: 're_1', amountMinor: 2499, currency: 'USD', full: true } });

    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    const [params, opts] = refundCall();
    expect(params).toEqual({
      payment_intent: 'pi_inv',
      reason: 'requested_by_customer',
      metadata: { product: 'roboapply', userId: 'u_1', actor: 'admin_1', kind: 'refund', planKey: 'pro_monthly', reason: 'Charged twice' },
    });
    expect(opts).toEqual({ idempotencyKey: 'refund:pi_inv:full:dialog-0001' });

    expect(auditRows).toEqual([
      {
        adminId: 'admin_1',
        subjectUserId: 'u_1',
        eventType: 'billing.refund_issued',
        payload: { refundId: 're_1', target: { invoiceId: 'in_1' }, amountMinor: 2499, currency: 'USD', full: true, reason: 'Charged twice' },
      },
    ]);
    // No access changes until Stripe reports the refund (charge.refunded): the plan, the credits and the
    // refund rows are untouched. The only write is the claim that keeps the audit row to one per refund.
    expect(await state(ACCESS_TABLES)).toBe(before);
    expect(await claims()).toEqual(['billing:adminrefund:re_1']);
    expect(await planRow('u_1')).toMatchObject({ tier: 'pro', status: 'active', mockCredits: 3 });
  });

  it('a partial refund sends the amount; the same dialog retried repeats its key and is one refund, audited once; another dialog of the same amount is a second refund', async () => {
    const partial = { ...REFUND, amountMinor: 1000 };
    const first = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: partial });
    expect(first.body.data).toEqual({ refundId: 're_1', amountMinor: 1000, currency: 'USD', full: false });
    const retried = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: partial });
    expect(retried.body.data).toEqual(first.body.data);
    expect(auditRows.map((a) => a.payload.refundId)).toEqual(['re_1']);

    const second = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...partial, attemptKey: 'dialog-0002' } });
    expect(second.body.data).toMatchObject({ refundId: 're_2', amountMinor: 1000 });
    expect(stripe.refunds.create.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey)).toEqual([
      'refund:pi_inv:1000:dialog-0001',
      'refund:pi_inv:1000:dialog-0001',
      'refund:pi_inv:1000:dialog-0002',
    ]);
    expect(refundCall()[0].amount).toBe(1000);
    expect(auditRows.map((a) => a.payload.refundId)).toEqual(['re_1', 're_2']);
  });

  it('two identical requests at the same moment make one refund and one audit row', async () => {
    const both = await Promise.all([h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND }), h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND })]);
    expect(both.map((r) => [r.status, r.body.data.refundId])).toEqual([
      [200, 're_1'],
      [200, 're_1'],
    ]);
    expect(account.refundsByKey.size).toBe(1);
    expect(auditRows).toHaveLength(1);
  });

  it('an audit row that could not be stored leaves no claim behind, so the same dialog sent again writes it', async () => {
    let failing = true;
    const service = new AdminBillingService({
      db: () => withRollback(fake.db) as never,
      now: () => clock.now,
      // As `writeAdminAudit` answers when the insert fails: it never throws, it says the row is only in the log.
      audit: async (input) => (failing ? 'log_only' : writeAdminAudit(auditStore, input)),
    });
    // The refund itself succeeded: a row that cannot be stored never fails the action.
    expect(await service.refund('admin_1', REFUND)).toEqual({ refundId: 're_1', amountMinor: 2499, currency: 'USD', full: true });
    expect(auditRows).toEqual([]);
    expect(await claims()).toEqual([]);

    failing = false;
    expect(await service.refund('admin_1', REFUND)).toMatchObject({ refundId: 're_1' });
    expect(account.refundsByKey.size).toBe(1);
    expect(auditRows.map((a) => [a.adminId, a.subjectUserId, a.payload.refundId])).toEqual([['admin_1', 'u_1', 're_1']]);
    expect(await claims()).toEqual(['billing:adminrefund:re_1']);
    // And once it is stored, another retry does not write it again.
    await service.refund('admin_1', REFUND);
    expect(auditRows).toHaveLength(1);
  });

  it('the audit row is written through the transaction that holds its claim', async () => {
    const seen: unknown[] = [];
    const db = withRollback(fake.db);
    const service = new AdminBillingService({
      db: () => db as never,
      now: () => clock.now,
      audit: async (input, tx) => {
        seen.push(tx);
        return writeAdminAudit(auditStore, input);
      },
    });
    await service.refund('admin_1', REFUND);
    // The transaction client (here the in-memory database itself), never nothing.
    expect(seen).toEqual([fake.db]);
  });

  it('a claim that cannot be written never hides the audit row', async () => {
    const broken = new Proxy(fake.db, {
      get(target, prop: string) {
        if (prop !== '$transaction') return target[prop];
        return async () => {
          throw new Error('database went away');
        };
      },
    });
    const service = new AdminBillingService({ db: () => broken as never, now: () => clock.now, audit: (input) => writeAdminAudit(auditStore, input) });
    expect(await service.refund('admin_1', REFUND)).toMatchObject({ refundId: 're_1' });
    expect(auditRows.map((a) => a.payload.refundId)).toEqual(['re_1']);
  });

  describe('a retry that is refused because the money already went back', () => {
    /** `charge.refunded` as Stripe sends it once `amountRefunded` of the 2499 charge went back, through the real webhook handler. */
    async function refundWebhook(amountRefunded: number) {
      const handler = stripeEventHandler('charge.refunded')!;
      const charge = {
        id: 'ch_1',
        customer: 'cus_1',
        payment_intent: 'pi_inv',
        amount: 2499,
        amount_refunded: amountRefunded,
        currency: 'usd',
        created: Math.floor(T0.getTime() / 1000),
        metadata: {},
        refunds: { data: accountRefunds() },
      };
      const event = { id: `evt_rf_${amountRefunded}`, type: 'charge.refunded', data: { object: charge } };
      expect(await handler(event as never, { stripe: stripe as never, db: fake.db as never, now: () => clock.now })).toMatchObject({ handled: true });
    }

    /** The first request of a dialog reached Stripe and the process stopped before its audit row: the refund exists, nothing else. */
    const refundWithoutAudit = (over: Obj = {}) =>
      issueRefund({ ...REFUND, actor: 'admin_1', kind: 'refund', ...over } as never, { db: fake.db as never, getStripe: () => stripe as never, now: () => clock.now });

    it('writes the audit row of the refund the first request made, once, and still answers 409', async () => {
      expect(await refundWithoutAudit()).toMatchObject({ refundId: 're_1', full: true });
      await refundWebhook(2499);
      expect(await refundRows()).toEqual([expect.objectContaining({ kind: 'refund', actor: 'admin_1', invoiceId: 'in_1', paymentIntentId: 'pi_inv', amountMinor: 2499, full: true })]);
      expect(auditRows).toEqual([]);

      const retried = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
      expect([retried.status, retried.body.code, retried.body.details.reason]).toEqual([409, 'refund_not_available', 'already_refunded']);
      expect(auditRows).toEqual([
        {
          adminId: 'admin_1',
          subjectUserId: 'u_1',
          eventType: 'billing.refund_issued',
          payload: { refundId: 're_1', target: { invoiceId: 'in_1' }, amountMinor: 2499, currency: 'USD', full: true, reason: 'Charged twice', auditedLate: true },
        },
      ]);
      expect(await claims()).toContain('billing:adminrefund:re_1');
      // No second refund was asked of Stripe, and a further retry writes nothing more.
      expect(account.refundsByKey.size).toBe(1);
      await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
      await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, attemptKey: 'dialog-0002' } });
      expect(auditRows).toHaveLength(1);
    });

    it('a refund that has its audit row never gets a second one from a later refused attempt', async () => {
      const first = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
      expect(first.status).toBe(200);
      await refundWebhook(2499);
      expect(auditRows).toHaveLength(1);

      const again = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, attemptKey: 'dialog-0002' } });
      expect([again.status, again.body.details.reason]).toEqual([409, 'already_refunded']);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.payload).not.toHaveProperty('auditedLate');
    });

    it('a partial refund whose retry is above what is left is audited the same way; one refund among several is not audited twice', async () => {
      // 1,000 went back and was audited; the 1,200 of the next dialog reached Stripe and lost its audit row.
      await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, amountMinor: 1000 } });
      await refundWebhook(1000);
      await refundWithoutAudit({ amountMinor: 1200, attemptKey: 'dialog-0002' });
      await refundWebhook(2200);
      // Another admin's refund on the same payment is theirs to account for.
      await refundWithoutAudit({ amountMinor: 100, attemptKey: 'dialog-0009', actor: 'admin_2' });
      await refundWebhook(2300);
      expect(auditRows.map((a) => a.payload.refundId)).toEqual(['re_1']);

      const retried = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, amountMinor: 1200, attemptKey: 'dialog-0002' } });
      expect([retried.status, retried.body.details.reason]).toEqual([409, 'amount_above_refundable']);
      expect(auditRows.map((a) => [a.adminId, a.payload.refundId, a.payload.amountMinor, a.payload.full, a.payload.auditedLate ?? false])).toEqual([
        ['admin_1', 're_1', 1000, false, false],
        ['admin_1', 're_2', 1200, false, true],
      ]);
    });

    it('asks Stripe nothing when this admin refunded nothing on the payment, and a failed read leaves the refusal as it is', async () => {
      // The whole payment went back from the Stripe Dashboard: the refund names no admin.
      account.refundsByKey.set('dashboard', { id: 're_dash', amount: 2499, currency: 'usd', charge: 'ch_1', payment_intent: 'pi_inv', metadata: {}, status: 'succeeded', created: 1_800_000_001 });
      await refundWebhook(2499);
      expect((await refundRows())[0]).toMatchObject({ actor: 'stripe', full: true });
      vi.clearAllMocks();

      const refused = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
      expect([refused.status, refused.body.details.reason]).toEqual([409, 'already_refunded']);
      expect(stripe.refunds.list).not.toHaveBeenCalled();
      expect(auditRows).toEqual([]);

      // Another payment: this admin's refund lost its audit row, and Stripe cannot be read on the retry.
      seedInvoice('in_2', 'cus_1', 'pi_two');
      await refundWithoutAudit({ target: { invoiceId: 'in_2' }, attemptKey: 'dialog-0003' });
      await fake.db.rABillingRefund.create({
        data: { userId: 'u_1', brand: 'roboapply', rail: 'stripe', kind: 'refund', externalRef: 'ch_2:2499', chargeId: 'ch_2', paymentIntentId: 'pi_two', invoiceId: 'in_2', amountMinor: 2499, currency: 'USD', full: true, entitlementReversed: true, actor: 'admin_1' },
      });
      stripe.refunds.list.mockRejectedValueOnce(stripeError({ type: 'StripeAPIError', message: 'upstream down' }));
      const down = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, target: { invoiceId: 'in_2' }, attemptKey: 'dialog-0003' } });
      expect([down.status, down.body.code]).toEqual([409, 'refund_not_available']);
      expect(auditRows).toEqual([]);
      // The next retry reads Stripe and writes the row.
      await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, target: { invoiceId: 'in_2' }, attemptKey: 'dialog-0003' } });
      expect(auditRows.map((a) => [a.payload.refundId, a.payload.target])).toEqual([['re_1', { invoiceId: 'in_2' }]]);
    });
  });

  it('a refund without an attempt key is refused before anything is read; the Idempotency-Key header counts as one', async () => {
    const { attemptKey: _none, ...noKey } = REFUND;
    const refused = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: noKey });
    expect([refused.status, refused.body.code]).toEqual([422, 'invalid_request']);
    expect(refused.body.details.issues[0].path).toEqual(['attemptKey']);
    expect(stripeCalls()).toBe(0);
    expect(auditRows).toEqual([]);

    const viaHeader = await h.request<any>('POST', `${BASE}/refunds`, { headers: { ...AS_ADMIN.headers, 'idempotency-key': 'header-key-01' }, body: noKey });
    expect(viaHeader.status).toBe(200);
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_inv:full:header-key-01' });

    const malformed = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...noKey, attemptKey: 'no spaces!' } });
    expect(malformed.status).toBe(422);
    expect(stripeWrites()).toBe(1);
  });

  it('refunds a one-time payment by its Checkout Session', async () => {
    account.sessions.set('cs_pack', {
      id: 'cs_pack',
      customer: 'cus_1',
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: 'pi_cs',
      invoice: 'in_pack',
      amount_total: 999,
      currency: 'usd',
      metadata: { product: 'roboapply', brand: 'roboapply', planKey: 'practice_pack_5', userId: 'u_1' },
    });
    stripe.refunds.create.mockImplementationOnce(async (params: Obj) => ({ id: 're_pack', amount: 999, currency: 'usd', charge: 'ch_pack', payment_intent: params.payment_intent, metadata: params.metadata, status: 'succeeded' }));
    const res = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, target: { checkoutSessionId: 'cs_pack' } } });
    expect(res.body.data).toEqual({ refundId: 're_pack', amountMinor: 999, currency: 'USD', full: true });
    expect(refundCall()[1]).toEqual({ idempotencyKey: 'refund:pi_cs:full:dialog-0001' });
    expect(auditRows[0]!.payload).toMatchObject({ target: { checkoutSessionId: 'cs_pack' }, amountMinor: 999 });
  });

  it('a target that belongs to another customer answers 409 and writes no audit row', async () => {
    seedInvoice('in_theirs', 'cus_other', 'pi_theirs');
    const res = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, target: { invoiceId: 'in_theirs' } } });
    expect([res.status, res.body.code]).toEqual([409, 'refund_not_available']);
    expect(res.body.details).toMatchObject({ reason: 'not_yours' });
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(auditRows).toEqual([]);
  });

  it('answers 404 for an unknown user, 409 for a GoApply account with no Stripe call, 503 without a Stripe client and 502 when Stripe fails; none writes an audit row', async () => {
    const unknown = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, userId: 'nobody' } });
    expect([unknown.status, unknown.body.code]).toEqual([404, 'not_found']);

    await seedStripeUser({ id: 'u_go', brand: 'goapply', customer: 'cus_go' });
    const goapply = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: { ...REFUND, userId: 'u_go' } });
    expect([goapply.status, goapply.body.code, goapply.body.details.reason]).toEqual([409, 'refund_not_available', 'rail_not_allowed']);
    expect(stripeCalls()).toBe(0);

    setStripeClientForTests(null);
    const closed = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
    expect([closed.status, closed.body.code]).toEqual([503, 'rail_not_configured']);

    setStripeClientForTests(stripe as never);
    stripe.refunds.create.mockRejectedValueOnce(stripeError({ type: 'StripeAPIError', message: 'upstream down' }));
    const failed = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body: REFUND });
    expect([failed.status, failed.body.code]).toEqual([502, 'payment_provider_error']);

    expect(auditRows).toEqual([]);
  });

  it('refuses a malformed body with 422 and no Stripe call', async () => {
    const bad: Obj[] = [
      { ...REFUND, target: { invoiceId: 'in_1', checkoutSessionId: 'cs_1' } },
      { ...REFUND, target: {} },
      { ...REFUND, target: { invoiceId: 'cs_wrong_kind' } },
      { ...REFUND, reason: '   ' },
      { ...REFUND, reason: 'x'.repeat(301) },
      { ...REFUND, amountMinor: 0 },
      { ...REFUND, amountMinor: 10.5 },
      { ...REFUND, userId: '' },
    ];
    for (const body of bad) {
      const res = await h.request<any>('POST', `${BASE}/refunds`, { ...AS_ADMIN, body });
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([422, 'invalid_request']);
    }
    expect(stripeCalls()).toBe(0);
    expect(auditRows).toEqual([]);
  });
});

describe('the admin guard', () => {
  it('a signed-in user who is not an admin gets 403 on every admin billing route, and nothing happens', async () => {
    await seedStripeUser();
    seedInvoice();
    const before = await state();
    const calls: Array<[string, string, Obj?]> = [
      ['POST', '/refunds', REFUND],
      ['GET', '/refunds?userId=u_1'],
      ['GET', '/cn-orders?userId=u_1'],
      ['POST', '/cn-orders/o_1/refund', { reason: 'r', confirmMoneyReturned: true }],
      ['GET', '/practice-cost'],
      ['GET', '/stripe-health'],
    ];
    for (const [method, path, body] of calls) {
      const res = await h.request<any>(method, `${BASE}${path}`, { ...AS_SEEKER, ...(body ? { body } : {}) });
      expect([res.status, res.body.code], `${method} ${path}`).toEqual([403, 'ADMIN_REQUIRED']);
      const anonymous = await h.request<any>(method, `${BASE}${path}`, body ? { body } : {});
      expect(anonymous.status, `${method} ${path}`).toBe(401);
    }
    expect(stripeCalls()).toBe(0);
    expect(auditRows).toEqual([]);
    expect(practice.reads).toEqual([]);
    expect(await state()).toBe(before);
  });
});

describe('GET /refunds: refunds, withdrawals, disputes and manual records, newest first', () => {
  const row = (n: number, over: Obj = {}) => ({
    id: `rf_${String(n).padStart(3, '0')}`,
    userId: 'u_1',
    brand: 'roboapply',
    rail: 'stripe',
    kind: 'refund',
    externalRef: `ch_${n}:2499`,
    chargeId: `ch_${n}`,
    paymentIntentId: `pi_${n}`,
    invoiceId: `in_${n}`,
    checkoutSessionId: null,
    alipayOrderId: null,
    planKey: 'pro_monthly',
    amountMinor: 2499,
    currency: 'USD',
    full: true,
    entitlementReversed: true,
    reason: 'requested_by_customer',
    actor: 'admin_1',
    note: null,
    createdAt: new Date(T0.getTime() + n * 60_000),
    ...over,
  });

  it('lists a dispute row that the webhook wrote', async () => {
    await seedStripeUser();
    const handler = stripeEventHandler('charge.dispute.created')!;
    const event = {
      id: 'evt_dp',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', amount: 2499, currency: 'usd', reason: 'fraudulent', charge: { id: 'ch_9', customer: 'cus_1', payment_intent: null, created: Math.floor(T0.getTime() / 1000) } } },
    };
    expect(await handler(event as never, { stripe: stripe as never, db: fake.db as never, now: () => clock.now })).toEqual({ handled: true });

    const res = await h.request<any>('GET', `${BASE}/refunds?userId=u_1`, AS_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.cursor).toBeNull();
    expect(res.body.data.items).toEqual([
      {
        id: expect.any(String),
        userId: 'u_1',
        brand: 'roboapply',
        rail: 'stripe',
        kind: 'dispute',
        amountMinor: 2499,
        currency: 'USD',
        full: true,
        entitlementReversed: false,
        reason: 'fraudulent',
        actor: 'stripe',
        invoiceId: null,
        checkoutSessionId: null,
        alipayOrderId: null,
        createdAt: expect.any(String),
      },
    ]);
  });

  it('pages 50 at a time with no row repeated or skipped, filters by user, and lists every user without a filter', async () => {
    for (let n = 1; n <= 60; n += 1) await fake.db.rABillingRefund.create({ data: row(n) });
    await fake.db.rABillingRefund.create({ data: row(61, { userId: 'cn_1', brand: 'goapply', rail: 'alipay', kind: 'manual_cn', externalRef: 'order:o_1', invoiceId: null, alipayOrderId: 'o_1', currency: 'CNY' }) });
    // Two rows written in the same instant are told apart by their id.
    await fake.db.rABillingRefund.create({ data: row(62, { createdAt: new Date(T0.getTime() + 61 * 60_000), userId: 'u_1' }) });

    const first = await h.request<any>('GET', `${BASE}/refunds?userId=u_1`, AS_ADMIN);
    expect(first.body.data.items).toHaveLength(50);
    expect(first.body.data.items[0].id).toBe('rf_062');
    expect(first.body.data.cursor).toEqual(expect.any(String));
    const second = await h.request<any>('GET', `${BASE}/refunds?userId=u_1&cursor=${encodeURIComponent(first.body.data.cursor)}`, AS_ADMIN);
    expect(second.body.data.cursor).toBeNull();
    const ids = [...first.body.data.items, ...second.body.data.items].map((i: Obj) => i.id);
    expect(ids).toHaveLength(61);
    expect(new Set(ids).size).toBe(61);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(ids).not.toContain('rf_061');

    const everyone = await h.request<any>('GET', `${BASE}/refunds`, AS_ADMIN);
    expect(everyone.body.data.items.slice(0, 2).map((i: Obj) => [i.id, i.kind, i.alipayOrderId])).toEqual([
      ['rf_062', 'refund', null],
      ['rf_061', 'manual_cn', 'o_1'],
    ]);

    const badCursor = await h.request<any>('GET', `${BASE}/refunds?cursor=nonsense`, AS_ADMIN);
    expect([badCursor.status, badCursor.body.code]).toEqual([422, 'invalid_request']);
  });
});

// ══ Manual refund record for CN orders ════════════════════════════════════

describe('POST /cn-orders/:orderId/refund: record a refund made in the merchant console', () => {
  beforeEach(async () => {
    await seedCnUser();
  });

  it('a refunded pass ends: the plan goes back to Free once, the order itself is not touched, and one audit row is written', async () => {
    await seedOrder();
    await pay('RAORDER_o_1', at(0));
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', currentPeriodEnd: at(30) });
    const orderBefore = JSON.stringify(await fake.db.alipayOrder.findMany({}));

    const res = await record('o_1');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'recorded', orderId: 'o_1', entitlement: 'pass_ended' });

    expect(await planRow()).toMatchObject({ tier: 'free', planKey: 'free', status: 'canceled', currentPeriodEnd: clock.now, mockCredits: FREE_ALLOTMENT });
    expect(await refundRows()).toEqual([
      expect.objectContaining({
        userId: 'cn_1',
        brand: 'goapply',
        rail: 'alipay',
        kind: 'manual_cn',
        externalRef: 'order:o_1',
        alipayOrderId: 'o_1',
        planKey: 'pro_monthly',
        amountMinor: 3900,
        currency: 'CNY',
        full: true,
        entitlementReversed: true,
        reason: 'Bought twice by mistake',
        actor: 'admin_1',
      }),
    ]);
    // The ledger claim of strategy G13.
    expect(await claims()).toContain(billingEventClaimKey('refund:cn:o_1'));
    expect(await claims()).toContain('billing:refund:cn:o_1');
    // Rule A8: the order row is exactly what it was (status completed, no marker on it).
    expect(JSON.stringify(await fake.db.alipayOrder.findMany({}))).toBe(orderBefore);
    expect(auditRows).toEqual([
      {
        adminId: 'admin_1',
        subjectUserId: 'cn_1',
        eventType: 'billing.cn_refund_recorded',
        payload: { orderId: 'o_1', outTradeNo: 'RAORDER_o_1', channel: 'alipay', planKey: 'pro_monthly', amountMinor: 3900, currency: 'CNY', full: true, entitlement: 'pass_ended', reason: 'Bought twice by mistake' },
      },
    ]);
    expect(invalidated).toEqual(['cn_1']);
  });

  it('a second click is a no-op: already_recorded, the same account, no second audit row', async () => {
    await seedOrder();
    await pay('RAORDER_o_1', at(0));
    await record('o_1');
    const before = await state();
    const audits = auditRows.length;

    const again = await record('o_1', { reason: 'Clicked again', confirmMoneyReturned: true });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ status: 'already_recorded', orderId: 'o_1', entitlement: 'pass_ended' });
    expect(await state()).toBe(before);
    expect(auditRows).toHaveLength(audits);
    expect(await refundRows()).toHaveLength(1);
  });

  it('a pass stacked on another pass is shortened by one pass length, not ended', async () => {
    await seedOrder();
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2', createdAt: at(1) });
    await pay('RAORDER_o_1', at(0));
    await pay('RAORDER_o_2', at(1));
    expect(await planRow()).toMatchObject({ tier: 'pro', currentPeriodEnd: at(60), startedAt: at(0) });

    const res = await record('o_1');
    expect(res.body.data).toEqual({ status: 'recorded', orderId: 'o_1', entitlement: 'pass_shortened' });
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_monthly', status: 'active', currentPeriodEnd: at(30) });

    // The other pass is refunded too: now nothing is left and the plan ends.
    const second = await record('o_2');
    expect(second.body.data).toEqual({ status: 'recorded', orderId: 'o_2', entitlement: 'pass_ended' });
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    expect(auditRows.map((a) => a.payload.entitlement)).toEqual(['pass_shortened', 'pass_ended']);
  });

  it('a pass that was over before the pass that runs now began takes nothing off the newer one', async () => {
    await seedOrder({ tier: 'ra_pro_week_pass', planKey: 'pro_week_pass', amount: 12, amountMinor: 1200 });
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2', tier: 'ra_pro_week_pass', planKey: 'pro_week_pass', amount: 12, amountMinor: 1200 });
    await pay('RAORDER_o_1', at(-30));
    await pay('RAORDER_o_2', at(0)); // a fresh run: the first pass ended three weeks earlier
    const res = await record('o_1');
    expect(res.body.data).toEqual({ status: 'recorded', orderId: 'o_1', entitlement: 'none' });
    expect(await planRow()).toMatchObject({ tier: 'pro', planKey: 'pro_week_pass', currentPeriodEnd: at(7) });
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: false });
  });

  it('a pack with used credits loses what is left of it and nothing goes negative', async () => {
    await seedOrder({ id: 'o_pack', outTradeNo: 'RAORDER_o_pack', tier: 'ra_practice_pack_5', planKey: 'practice_pack_5', purpose: 'interview_pack', amount: 29, amountMinor: 2900 });
    await pay('RAORDER_o_pack', at(0));
    const grantId = packGrantId('cn_1', 'order:o_pack');
    expect(await fake.db.rACreditGrant.findUnique({ where: { id: grantId } })).toMatchObject({ amount: 5, remaining: 5 });
    expect((await planRow()).mockCredits).toBe(5);
    // Two of the five practice interviews were used.
    await fake.db.seekerSubscription.update({ where: { id: 'row_cn_1' }, data: { mockCredits: 3 } });

    const res = await record('o_pack');
    expect(res.body.data).toEqual({ status: 'recorded', orderId: 'o_pack', entitlement: 'pack_zeroed' });
    expect((await planRow()).mockCredits).toBe(0);
    expect((await fake.db.rACreditGrant.findUnique({ where: { id: grantId } })).remaining).toBe(0);
    expect(await fake.db.mockInterviewCreditLedger.findMany({ where: { reason: 'refund' } })).toEqual([
      expect.objectContaining({ userId: 'cn_1', delta: -3, balanceAfter: 0, source: 'alipay' }),
    ]);
    expect((await refundRows())[0]).toMatchObject({ kind: 'manual_cn', planKey: 'practice_pack_5', amountMinor: 2900, full: true, entitlementReversed: true });

    const again = await record('o_pack');
    expect(again.body.data).toEqual({ status: 'already_recorded', orderId: 'o_pack', entitlement: 'pack_zeroed' });
    expect((await planRow()).mockCredits).toBe(0);
  });

  it('a legacy ra_starter order loses its 30 days', async () => {
    await seedOrder({ id: 'o_old', outTradeNo: 'RAORDER_OLD', tier: 'ra_starter', planKey: null, brand: null, amount: 19, amountMinor: null });
    await pay('RAORDER_OLD', at(0));
    expect(await planRow()).toMatchObject({ tier: 'starter', planKey: 'starter', currentPeriodEnd: at(30) });

    const res = await record('o_old');
    expect(res.body.data).toEqual({ status: 'recorded', orderId: 'o_old', entitlement: 'pass_ended' });
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    // An order from before the clone names no brand: it was RoboApply's Alipay pass.
    expect((await refundRows())[0]).toMatchObject({ brand: 'roboapply', rail: 'alipay', planKey: 'starter', amountMinor: 1900, currency: 'CNY', full: true });
  });

  it('a partial amount is recorded and changes no access', async () => {
    await seedOrder();
    await pay('RAORDER_o_1', at(0));
    const plan = JSON.stringify(await planRow());

    const res = await record('o_1', { reason: 'Goodwill', confirmMoneyReturned: true, refundedAmountMinor: 1000 });
    expect(res.body.data).toEqual({ status: 'recorded', orderId: 'o_1', entitlement: 'none' });
    expect(JSON.stringify(await planRow())).toBe(plan);
    expect((await refundRows())[0]).toMatchObject({ amountMinor: 1000, full: false, entitlementReversed: false });
    expect(auditRows[0]!.payload).toMatchObject({ amountMinor: 1000, full: false, entitlement: 'none' });
    // The whole amount named explicitly is a full refund.
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2' });
    await pay('RAORDER_o_2', at(1));
    const whole = await record('o_2', { reason: 'Whole', confirmMoneyReturned: true, refundedAmountMinor: 3900 });
    expect(whole.body.data.entitlement).toBe('pass_shortened');
  });

  it('two requests at the same moment record the order once and reverse it once', async () => {
    await seedOrder();
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2', createdAt: at(1) });
    await pay('RAORDER_o_1', at(0));
    await pay('RAORDER_o_2', at(1));

    const both = await Promise.all([record('o_1'), record('o_1')]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both.map((r) => r.body.data.status).sort()).toEqual(['already_recorded', 'recorded']);
    expect(await refundRows()).toHaveLength(1);
    // One pass length came off, not two.
    expect(await planRow()).toMatchObject({ tier: 'pro', currentPeriodEnd: at(30) });
    expect(auditRows).toHaveLength(1);
  });

  it('a double click while the first request is still reversing leaves the reversal, and the audit row, to the first', async () => {
    await seedOrder();
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2', createdAt: at(1) });
    await pay('RAORDER_o_1', at(0));
    await pay('RAORDER_o_2', at(1));

    // The first request has recorded the order and is held just before it reverses the pass.
    let reached!: () => void;
    let release!: () => void;
    const atReversal = new Promise<void>((resolve) => (reached = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new AdminBillingService({
      db: () => fake.db as never,
      now: () => clock.now,
      audit: (input) => writeAdminAudit(auditStore, input),
      invalidate: () => {},
      reversePassPeriod: (async (...args: Parameters<typeof reversePassPeriod>) => {
        reached();
        await held;
        return reversePassPeriod(...args);
      }) as never,
    });
    const first = slow.recordCnRefund('admin_1', 'o_1', { reason: 'Bought twice by mistake', confirmMoneyReturned: true });
    await atReversal;

    // The second click arrives now, on a service that would reverse at once if it tried.
    const second = await record('o_1');
    expect(second.body.data).toEqual({ status: 'already_recorded', orderId: 'o_1', entitlement: 'none' });
    expect(await planRow()).toMatchObject({ tier: 'pro', currentPeriodEnd: at(60) });
    expect(auditRows).toEqual([]);

    release();
    expect(await first).toEqual({ status: 'recorded', orderId: 'o_1', entitlement: 'pass_shortened' });
    expect(await planRow()).toMatchObject({ tier: 'pro', currentPeriodEnd: at(30) });
    expect((await refundRows())[0]).toMatchObject({ entitlementReversed: true });
    // One action, one audit row, and it says what happened.
    expect(auditRows.map((a) => [a.payload.entitlement, a.payload.completesEarlierRecord ?? false])).toEqual([['pass_shortened', false]]);
    // From now on a click reads the stored outcome.
    expect((await record('o_1')).body.data).toEqual({ status: 'already_recorded', orderId: 'o_1', entitlement: 'pass_shortened' });
  });

  it('a record whose request never came back is finished by a later one, after the handover time and not before', async () => {
    await seedOrder();
    await pay('RAORDER_o_1', at(0));
    // The process stops inside the reversal: the order is recorded, nothing is reversed, nothing says it failed.
    let reached!: () => void;
    const atReversal = new Promise<void>((resolve) => (reached = resolve));
    const gone = new AdminBillingService({
      db: () => fake.db as never,
      now: () => clock.now,
      audit: (input) => writeAdminAudit(auditStore, input),
      invalidate: () => {},
      reversePassPeriod: (() => {
        reached();
        return new Promise(() => {});
      }) as never,
    });
    void gone.recordCnRefund('admin_1', 'o_1', { reason: 'Refund', confirmMoneyReturned: true });
    await atReversal;
    const recordedAt = clock.now;
    const recorded = (await refundRows())[0];
    expect(recorded).toMatchObject({ full: true, entitlementReversed: false, createdAt: recordedAt });
    expect(recorded.note ?? null).toBeNull();

    clock.now = new Date(recordedAt.getTime() + CN_REVERSAL_HANDOVER_MS - 1);
    expect((await record('o_1')).body.data).toEqual({ status: 'already_recorded', orderId: 'o_1', entitlement: 'none' });
    expect(await planRow()).toMatchObject({ tier: 'pro' });
    expect(auditRows).toEqual([]);

    clock.now = new Date(recordedAt.getTime() + CN_REVERSAL_HANDOVER_MS);
    expect((await record('o_1')).body.data).toEqual({ status: 'already_recorded', orderId: 'o_1', entitlement: 'pass_ended' });
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    expect((await refundRows())[0]).toMatchObject({ entitlementReversed: true });
    expect(auditRows.map((a) => [a.adminId, a.payload.entitlement, a.payload.completesEarlierRecord ?? false])).toEqual([['admin_1', 'pass_ended', true]]);
  });

  it('a reversal that failed is finished by the next request, and both are audited', async () => {
    await seedOrder();
    await pay('RAORDER_o_1', at(0));
    const flaky = new AdminBillingService({
      db: () => fake.db as never,
      now: () => clock.now,
      audit: (input) => writeAdminAudit(auditStore, input),
      invalidate: () => {},
      reversePassPeriod: vi.fn(async () => {
        throw new Error('database went away');
      }) as never,
    });
    await expect(flaky.recordCnRefund('admin_1', 'o_1', { reason: 'Refund', confirmMoneyReturned: true })).rejects.toThrow('database went away');
    // The row says the reversal failed, so the next click finishes it at once (no waiting for the handover time).
    expect((await refundRows())[0]).toMatchObject({ full: true, entitlementReversed: false, note: 'entitlement: not_reversed' });
    expect(await planRow()).toMatchObject({ tier: 'pro' });
    expect(auditRows.map((a) => a.payload.entitlement)).toEqual(['not_reversed']);
    // The order list says the record stopped half way (the console then offers "Check the record"): M4 gate.
    const listed = async () => (await h.request<any>('GET', `${BASE}/cn-orders?userId=cn_1`, AS_ADMIN)).body.data.items.find((o: { id: string }) => o.id === 'o_1');
    expect(await listed()).toMatchObject({ refunded: 'full', reversalPending: true });

    const healed = await record('o_1');
    expect(healed.body.data).toEqual({ status: 'already_recorded', orderId: 'o_1', entitlement: 'pass_ended' });
    // Finished: the flag is gone (absent, never false).
    expect(await listed()).toMatchObject({ refunded: 'full' });
    expect('reversalPending' in (await listed())).toBe(false);
    expect(await planRow()).toMatchObject({ tier: 'free', status: 'canceled' });
    expect((await refundRows())[0]).toMatchObject({ entitlementReversed: true });
    expect(auditRows.map((a) => [a.payload.entitlement, a.payload.completesEarlierRecord ?? false])).toEqual([
      ['not_reversed', false],
      ['pass_ended', true],
    ]);
  });

  it('a WeChat Pay order is recorded on its own rail', async () => {
    await seedOrder({ channel: 'wechatpay' });
    await pay('RAORDER_o_1', at(0), 'wechatpay');
    const res = await record('o_1');
    expect(res.body.data.entitlement).toBe('pass_ended');
    expect((await refundRows())[0]).toMatchObject({ rail: 'wechatpay', kind: 'manual_cn', externalRef: 'order:o_1' });
    expect(auditRows[0]!.payload.channel).toBe('wechatpay');
  });

  it('answers 404 for a recruiter order and for an unknown one, 409 for an order that was never paid, and writes nothing', async () => {
    await seedOrder({ id: 'o_rh', outTradeNo: 'ORDER_RH', tier: 'growth', planKey: null, brand: null, status: 'completed', completedAt: at(0) });
    await seedOrder({ id: 'o_pending', outTradeNo: 'RAORDER_PENDING' });
    await seedOrder({ id: 'o_closed', outTradeNo: 'RAORDER_CLOSED', status: 'closed' });
    const before = await state();

    const recruiter = await record('o_rh');
    expect([recruiter.status, recruiter.body.code]).toEqual([404, 'not_found']);
    const unknown = await record('o_nowhere');
    expect([unknown.status, unknown.body.code]).toEqual([404, 'not_found']);
    const pending = await record('o_pending');
    expect([pending.status, pending.body.code]).toEqual([409, 'order_not_completed']);
    const closed = await record('o_closed');
    expect([closed.status, closed.body.code]).toEqual([409, 'order_not_completed']);

    expect(await state()).toBe(before);
    expect(auditRows).toEqual([]);
  });

  it('refuses a body that does not confirm the money went back, and an amount above the order, with 422', async () => {
    await seedOrder();
    await pay('RAORDER_o_1', at(0));
    const before = await state();
    const bad: Obj[] = [
      { reason: 'r' },
      { reason: 'r', confirmMoneyReturned: false },
      { reason: 'r', confirmMoneyReturned: 'yes' },
      { confirmMoneyReturned: true },
      { reason: '  ', confirmMoneyReturned: true },
      { reason: 'r', confirmMoneyReturned: true, refundedAmountMinor: 0 },
      { reason: 'r', confirmMoneyReturned: true, refundedAmountMinor: 12.5 },
      { reason: 'r', confirmMoneyReturned: true, refundedAmountMinor: 3901 },
    ];
    for (const body of bad) {
      const res = await record('o_1', body);
      expect([res.status, res.body.code], JSON.stringify(body)).toEqual([422, 'invalid_request']);
    }
    expect(await state()).toBe(before);
    expect(auditRows).toEqual([]);
  });
});

describe('GET /cn-orders: the completed orders of a user with their refunded marker', () => {
  it('lists completed seeker orders newest first with the marker, and nothing else', async () => {
    await seedCnUser();
    await seedCnUser({ id: 'cn_2' });
    await seedOrder();
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2', createdAt: at(1) });
    await seedOrder({ id: 'o_wx', outTradeNo: 'RAORDER_o_wx', channel: 'wechatpay', tier: 'ra_practice_pack_5', planKey: 'practice_pack_5', purpose: 'interview_pack', amount: 29, amountMinor: 2900 });
    await seedOrder({ id: 'o_old', outTradeNo: 'RAORDER_OLD', tier: 'ra_starter', planKey: null, brand: null, amount: 19, amountMinor: null, status: 'completed', completedAt: at(-40) });
    await seedOrder({ id: 'o_pending', outTradeNo: 'RAORDER_PENDING' });
    await seedOrder({ id: 'o_rh', outTradeNo: 'ORDER_RH', tier: 'growth', planKey: null, status: 'completed', completedAt: at(0) });
    await seedOrder({ id: 'o_theirs', outTradeNo: 'RAORDER_THEIRS', userId: 'cn_2', status: 'completed', completedAt: at(0) });
    await pay('RAORDER_o_1', at(0));
    await pay('RAORDER_o_2', at(1));
    await pay('RAORDER_o_wx', new Date(at(1).getTime() + 3_600_000), 'wechatpay');
    await record('o_1');
    await record('o_wx', { reason: 'Part', confirmMoneyReturned: true, refundedAmountMinor: 900 });

    const res = await h.request<any>('GET', `${BASE}/cn-orders?userId=cn_1`, AS_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [
        { id: 'o_wx', outTradeNo: 'RAORDER_o_wx', planKey: 'practice_pack_5', channel: 'wechatpay', amountMinor: 2900, completedAt: new Date(at(1).getTime() + 3_600_000).toISOString(), refunded: 'partial' },
        { id: 'o_2', outTradeNo: 'RAORDER_o_2', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: at(1).toISOString(), refunded: null },
        { id: 'o_1', outTradeNo: 'RAORDER_o_1', planKey: 'pro_monthly', channel: 'alipay', amountMinor: 3900, completedAt: at(0).toISOString(), refunded: 'full' },
        { id: 'o_old', outTradeNo: 'RAORDER_OLD', planKey: 'starter', channel: 'alipay', amountMinor: 1900, completedAt: at(-40).toISOString(), refunded: null },
      ],
    });

    const missing = await h.request<any>('GET', `${BASE}/cn-orders`, AS_ADMIN);
    expect([missing.status, missing.body.code]).toEqual([422, 'invalid_request']);
  });

  it('a recorded order stays in the buyer\'s own billing history, downloadable, with the marker (rule A10)', async () => {
    await seedCnUser();
    await seedOrder();
    await seedOrder({ id: 'o_2', outTradeNo: 'RAORDER_o_2', createdAt: at(1) });
    await pay('RAORDER_o_1', at(0));
    await pay('RAORDER_o_2', at(1));
    setBillingServiceDepsForTests({ db: fake.db as never, getStripe: () => null, now: () => clock.now, invalidate: () => {} });
    const before = (await getBillingHistory('cn_1')).invoices;
    expect(before.map((i) => [i.id, i.refunded])).toEqual([
      ['o_2', undefined],
      ['o_1', undefined],
    ]);

    await record('o_1');
    await record('o_2', { reason: 'Part', confirmMoneyReturned: true, refundedAmountMinor: 500 });
    const after = (await getBillingHistory('cn_1')).invoices;
    expect(after).toEqual([
      { ...before[0]!, refunded: 'partial' },
      { ...before[1]!, refunded: 'full' },
    ]);
    expect(after.every((i) => i.status === 'paid' && i.downloadable)).toBe(true);
  });

  it('the marker rule: a full row or a dispute is full, other rows are partial, no row is no marker', () => {
    expect(refundedMarkOf([])).toBeNull();
    expect(refundedMarkOf([{ kind: 'refund', full: false }])).toBe('partial');
    expect(refundedMarkOf([{ kind: 'refund', full: false }, { kind: 'refund', full: true }])).toBe('full');
    expect(refundedMarkOf([{ kind: 'dispute', full: false }])).toBe('full');
    expect(refundedMarkOf([{ kind: 'manual_cn', full: true }])).toBe('full');
  });
});

// ══ Practice cost ═════════════════════════════════════════════════════════

describe('GET /practice-cost: average cost of the last 50 practice sessions per brand', () => {
  /** Session n was recorded n minutes after T0; the higher n, the newer. */
  const session = (n: number, costUsd: number | null, over: Partial<PracticeCostRow> = {}): PracticeCostRow => ({
    id: `log_${n}`,
    relatedEntityId: `sess_${n}`,
    platformCostUsd: costUsd,
    metadata: { sessionSource: 'roboapply' },
    createdAt: new Date(T0.getTime() + n * 60_000),
    ...over,
  });
  const newestFirst = (rows: PracticeCostRow[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const read = async () => (await h.request<any>('GET', `${BASE}/practice-cost`, AS_ADMIN)).body.data;

  it('60 sessions: the newest 50 are averaged, with the sample size and its dates', async () => {
    // Sessions 1 to 10 cost $9.00 and are too old to count; 11 to 60 cost $0.80.
    practice.rows.roboapply = newestFirst(Array.from({ length: 60 }, (_, i) => session(i + 1, i + 1 <= 10 ? 9 : 0.8)));
    const data = await read();
    expect(data.brands.roboapply).toEqual({
      sampleSize: 50,
      averageUsd: 0.8,
      enough: true,
      maxSessions: 50,
      minSessions: 10,
      oldest: new Date(T0.getTime() + 11 * 60_000).toISOString(),
      newest: new Date(T0.getTime() + 60 * 60_000).toISOString(),
    });
    expect(data.brands.goapply).toEqual({ sampleSize: 0, averageUsd: null, enough: false, maxSessions: 50, minSessions: 10, oldest: null, newest: null });
  });

  it('9 sessions are not enough: no average, never a number from a thin sample; 10 are', async () => {
    practice.rows.goapply = newestFirst(Array.from({ length: 9 }, (_, i) => session(i + 1, 1.25)));
    expect((await read()).brands.goapply).toMatchObject({ sampleSize: 9, averageUsd: null, enough: false });
    practice.rows.goapply = newestFirst(Array.from({ length: 10 }, (_, i) => session(i + 1, 1.25)));
    expect((await read()).brands.goapply).toMatchObject({ sampleSize: 10, averageUsd: 1.25, enough: true });
  });

  it('a session without a cost is skipped and not counted; so is one that was not metered, a recruiter interview and a staff session', async () => {
    practice.rows.roboapply = newestFirst([
      ...Array.from({ length: 12 }, (_, i) => session(i + 1, 0.5)),
      session(20, null),
      session(21, 0),
      session(22, 40, { metadata: { sessionSource: 'recruiter' } }),
      session(23, 40, { metadata: { sessionSource: 'roboapply', creditExempt: true } }),
      // An old row that says nothing about its source is a practice session.
      session(24, 1.5, { metadata: null }),
    ]);
    const data = (await read()).brands.roboapply;
    expect(data.sampleSize).toBe(13);
    expect(data.averageUsd).toBe(Math.round(((12 * 0.5 + 1.5) / 13) * 10_000) / 10_000);
    expect(data.newest).toBe(new Date(T0.getTime() + 24 * 60_000).toISOString());
  });

  it('rows of one session are one session; a row without a session id is read from its metadata, else stands alone', async () => {
    practice.rows.roboapply = newestFirst([
      ...Array.from({ length: 9 }, (_, i) => session(i + 1, 1)),
      session(30, 0.4, { relatedEntityId: 'sess_x' }),
      session(31, 0.6, { relatedEntityId: 'sess_x' }),
      session(32, 0.25, { relatedEntityId: null, metadata: { sessionId: 'sess_y' } }),
      session(33, 0.75, { relatedEntityId: '', metadata: { sessionId: 'sess_y' } }),
      session(34, 2, { relatedEntityId: null, metadata: {} }),
    ]);
    const data = (await read()).brands.roboapply;
    // 9 sessions at $1, sess_x at $1, sess_y at $1, and the lone row at $2.
    expect(data.sampleSize).toBe(12);
    expect(data.averageUsd).toBe(Math.round((13 / 12) * 10_000) / 10_000);
  });

  it('each brand is computed from its own users', async () => {
    practice.rows.roboapply = newestFirst(Array.from({ length: 10 }, (_, i) => session(i + 1, 0.9)));
    practice.rows.goapply = newestFirst(Array.from({ length: 20 }, (_, i) => session(i + 100, 0.3)));
    const data = await read();
    expect([data.brands.roboapply.sampleSize, data.brands.roboapply.averageUsd]).toEqual([10, 0.9]);
    expect([data.brands.goapply.sampleSize, data.brands.goapply.averageUsd]).toEqual([20, 0.3]);
    expect(new Set(practice.reads.map((r) => r.brand))).toEqual(new Set(['roboapply', 'goapply']));
  });

  it('reads on past the first page until 50 metered sessions are found', async () => {
    // 250 unmetered sessions on top of 60 real ones: the first page of 200 holds no cost at all.
    practice.rows.roboapply = newestFirst([...Array.from({ length: 60 }, (_, i) => session(i + 1, 0.7)), ...Array.from({ length: 250 }, (_, i) => session(i + 1000, 0))]);
    const data = (await read()).brands.roboapply;
    expect([data.sampleSize, data.averageUsd]).toEqual([50, 0.7]);
    // The second page starts after the last row of the first one (the 200th newest: unmetered session 1050).
    expect(practice.reads.filter((r) => r.brand === 'roboapply').map((r) => [r.before, r.take])).toEqual([
      [null, 200],
      [{ createdAt: new Date(T0.getTime() + 1050 * 60_000), id: 'log_1050' }, 200],
    ]);
  });

  it('a session written while the readout is paging does not make an older row count twice', async () => {
    // Session A ($3) is the 200th newest row, the last of the first page; 20 sessions at $1 are behind it.
    practice.rows.roboapply = [
      ...Array.from({ length: 199 }, (_, i) => session(i + 1000, 0)),
      session(500, 3),
      ...Array.from({ length: 20 }, (_, i) => session(i + 1, 1)),
    ];
    let written = false;
    practice.afterRead = (brand) => {
      if (brand !== 'roboapply' || written) return;
      written = true;
      // A practice session finishes between the two reads: it is now the newest row.
      practice.rows.roboapply!.push(session(9000, 1));
    };
    const data = (await read()).brands.roboapply;
    // A at $3 once and the 20 older sessions: counting rows to skip would read A again and average $1.2381.
    expect([data.sampleSize, data.averageUsd]).toEqual([21, Math.round((23 / 21) * 10_000) / 10_000]);
    expect(practice.reads.filter((r) => r.brand === 'roboapply')[1]!.before).toEqual({ createdAt: new Date(T0.getTime() + 500 * 60_000), id: 'log_500' });
  });

  it('a usage row is added once even when a page hands it back again', async () => {
    const pages = [
      [...Array.from({ length: 199 }, (_, i) => session(i + 1000, 0)), session(500, 3)],
      // A reader that repeats the row it stopped at.
      [session(500, 3), ...Array.from({ length: 10 }, (_, i) => session(i + 1, 1))],
    ];
    const service = new AdminBillingService({ practiceCostRows: async (brand) => (brand === 'roboapply' ? (pages.shift() ?? []) : []) });
    const data = (await service.practiceCost()).brands.roboapply;
    expect([data.sampleSize, data.averageUsd]).toEqual([11, Math.round((13 / 11) * 10_000) / 10_000]);
  });

  it('the default reader asks the usage log for the practice SKU, rows with a cost, of users of that brand, newest first, page by page after the last row read', async () => {
    const select = { id: true, relatedEntityId: true, platformCostUsd: true, metadata: true, createdAt: true };
    const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    const base = (brand: string) => ({ sku: 'mock_interview', platformCostUsd: { not: null }, user: { brand } });
    // GoApply has a full first page of unmetered rows, so its second page is asked for.
    const firstPage = Array.from({ length: 200 }, (_, i) => session(1000 - i, 0));
    const findMany = vi.fn(async (args: Obj) => (args.where.user.brand === 'goapply' && !args.where.OR ? firstPage : ([] as PracticeCostRow[])));
    const service = new AdminBillingService({ db: () => ({ usageDeductionLog: { findMany } }) as never });
    const data = await service.practiceCost();
    expect(data.brands.goapply.sampleSize).toBe(0);
    expect(PRACTICE_SKU).toBe('mock_interview');
    expect(findMany).toHaveBeenCalledTimes(3);
    for (const brand of ['roboapply', 'goapply']) {
      expect(findMany).toHaveBeenCalledWith({ where: base(brand), orderBy, take: 200, select });
    }
    const last = firstPage[199]!;
    expect(findMany).toHaveBeenCalledWith({
      where: { ...base('goapply'), OR: [{ createdAt: { lt: last.createdAt } }, { createdAt: last.createdAt, id: { lt: last.id } }] },
      orderBy,
      take: 200,
      select,
    });
    // Never a number of rows to skip.
    expect(findMany.mock.calls.some(([args]) => 'skip' in args)).toBe(false);
  });

  it('reads only: nothing is written', async () => {
    await seedCnUser();
    const before = await state();
    practice.rows.goapply = newestFirst(Array.from({ length: 12 }, (_, i) => session(i + 1, 4)));
    await read();
    expect(await state()).toBe(before);
    expect(auditRows).toEqual([]);
  });
});

// ══ Stripe health ═════════════════════════════════════════════════════════

describe('GET /stripe-health: what staff see about the Stripe rail', () => {
  const WEBHOOK_URL = 'https://www.roboapply.io/api/v1/roboapply/stripe/webhook';
  const read = async () => await h.request<any>('GET', `${BASE}/stripe-health`, AS_ADMIN);
  const SECRET_SHAPED = /\b(sk|rk|whsec|price)_/;

  it('a test key and one webhook secret: test, usable, rail ready, and the events the endpoint lacks', async () => {
    env.current = { STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: 'whsec_one_secret_value' };
    const lacking = ['charge.refunded', 'invoice.payment_action_required'];
    account.endpoints = [{ id: 'we_1', status: 'enabled', url: WEBHOOK_URL, enabled_events: EXPECTED_STRIPE_EVENTS.filter((e) => !lacking.includes(e)) }];
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      keyMode: 'test',
      usable: true,
      refusedReason: null,
      webhookSecrets: 1,
      railReady: true,
      endpoint: { checked: true, url: WEBHOOK_URL, missingEvents: ['invoice.payment_action_required', 'charge.refunded'] },
      pinnedPlans: [],
    });
    expect(stripe.webhookEndpoints.list).toHaveBeenCalledTimes(1);
    expect(res.text).not.toMatch(SECRET_SHAPED);
  });

  it('a live key outside production is refused with the reason and no Stripe call is made', async () => {
    env.current = { STRIPE_SECRET_KEY: 'sk_live_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: 'whsec_one_secret_value', VERCEL_ENV: 'preview' };
    account.endpoints = [{ id: 'we_1', status: 'enabled', url: WEBHOOK_URL, enabled_events: ['*'] }];
    const res = await read();
    expect(res.body.data).toEqual({
      keyMode: 'live',
      usable: false,
      refusedReason: 'live_key_outside_production',
      webhookSecrets: 1,
      railReady: false,
      endpoint: { checked: false, url: null, missingEvents: [] },
      pinnedPlans: [],
    });
    expect(stripeCalls()).toBe(0);
    expect(res.text).not.toMatch(SECRET_SHAPED);

    // The same key in production is usable, and so is the explicit override elsewhere.
    env.current = { ...env.current, VERCEL_ENV: 'production' };
    expect((await read()).body.data).toMatchObject({ keyMode: 'live', usable: true, refusedReason: null, railReady: true, endpoint: { checked: true, missingEvents: [] } });
    env.current = { ...env.current, VERCEL_ENV: 'preview', STRIPE_ALLOW_LIVE_KEY_OUTSIDE_PRODUCTION: 'true' };
    expect((await read()).body.data).toMatchObject({ usable: true, refusedReason: null });
  });

  it('no key: none, missing, rail closed, nothing asked of Stripe; a key without a webhook secret is usable but the rail is not ready', async () => {
    env.current = {};
    const none = await read();
    expect(none.body.data).toEqual({ keyMode: 'none', usable: false, refusedReason: 'missing', webhookSecrets: 0, railReady: false, endpoint: { checked: false, url: null, missingEvents: [] }, pinnedPlans: [] });
    expect(stripeCalls()).toBe(0);

    env.current = { STRIPE_SECRET_KEY: 'rk_test_abcdefghijklmnop' };
    const keyOnly = await read();
    expect(keyOnly.body.data).toMatchObject({ keyMode: 'test', usable: true, webhookSecrets: 0, railReady: false, endpoint: { checked: true, url: null, reason: 'not_found' } });
    expect(keyOnly.body.data.endpoint.missingEvents).toEqual([...EXPECTED_STRIPE_EVENTS]);
  });

  it('counts every secret of a rotation list and reports a key that may not read webhook endpoints', async () => {
    env.current = { STRIPE_SECRET_KEY: 'rk_test_abcdefghijklmnop', ROBOAPPLY_STRIPE_WEBHOOK_SECRET: 'whsec_new_value', STRIPE_WEBHOOK_SECRET: 'whsec_old_value, whsec_older_value' };
    stripe.webhookEndpoints.list.mockRejectedValueOnce(stripeError({ type: 'StripePermissionError', statusCode: 403 }));
    const res = await read();
    expect(res.body.data).toMatchObject({ webhookSecrets: 3, railReady: true, endpoint: { checked: false, url: null, missingEvents: [], reason: 'restricted_key' } });
    expect(res.text).not.toMatch(SECRET_SHAPED);
  });

  it('names the pinned plans by their plan key and never prints a price id, a key or a secret', async () => {
    env.current = {
      STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop',
      STRIPE_WEBHOOK_SECRET: 'whsec_one_secret_value',
      STRIPE_PRICE_PRO_MONTHLY: 'price_pinned_monthly',
      PRICE_PRO_MONTHLY_USD_CENTS: '2499',
      STRIPE_PRICE_PRO_QUARTERLY_TWD: 'price_pinned_quarterly_twd',
      PRICE_PRO_QUARTERLY_TWD_CENTS: '165000',
      // A pin with no amount next to it does not stand, so it is not listed.
      STRIPE_PRICE_PRO_WEEKLY: 'price_pin_without_amount',
    };
    account.endpoints = [{ id: 'we_1', status: 'enabled', url: WEBHOOK_URL, enabled_events: ['*'] }];
    const res = await read();
    expect(res.body.data.pinnedPlans).toEqual(['pro_monthly', 'pro_quarterly']);
    expect(res.body.data.endpoint).toEqual({ checked: true, url: WEBHOOK_URL, missingEvents: [] });
    expect(res.text).not.toMatch(SECRET_SHAPED);
    for (const value of Object.values(env.current)) if (value && value.length > 8) expect(res.text).not.toContain(value);
  });

  describe('?prices=1: the prices the catalog charges on against what Stripe holds', () => {
    const KEYS = { STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: 'whsec_one_secret_value' };
    const readPrices = async (query = '?prices=1') => await h.request<any>('GET', `${BASE}/stripe-health${query}`, AS_ADMIN);
    const plan = (key: string) => getPlanCatalog('roboapply', env.current).find((p) => p.key === key)!;

    it('is not made unless asked for: the default answer has no prices and reads no price', async () => {
      env.current = { ...KEYS };
      for (const query of ['', '?prices=0', '?prices=false']) {
        const res = await readPrices(query);
        expect(res.status).toBe(200);
        expect(res.body.data).not.toHaveProperty('prices');
      }
      expect(stripe.prices.retrieve).not.toHaveBeenCalled();
      expect(stripe.prices.list).not.toHaveBeenCalled();
      const bad = await readPrices('?prices=yes');
      expect([bad.status, bad.body.code]).toEqual([422, 'invalid_request']);
    });

    it('reports a pin next to another amount and an archived synced price, by plan and amount, never by price id', async () => {
      env.current = { ...KEYS, STRIPE_PRICE_PRO_MONTHLY: 'price_pinned_monthly', PRICE_PRO_MONTHLY_USD_CENTS: '2499' };
      // The pinned price charges 19.99 where the catalog says 24.99.
      account.prices.set('price_pinned_monthly', { id: 'price_pinned_monthly', unit_amount: 1999, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, active: true, lookup_key: null });
      // The synced weekly price was archived in the Dashboard and nothing replaces it.
      const weekly = plan('pro_weekly');
      account.prices.set('price_weekly_old', {
        id: 'price_weekly_old',
        unit_amount: weekly.amountMinor,
        currency: 'usd',
        recurring: { interval: 'week', interval_count: 1 },
        active: false,
        lookup_key: stripeLookupKey('pro_weekly', 'USD', weekly.amountMinor!),
      });

      const res = await readPrices();
      expect(res.status).toBe(200);
      expect(res.body.data.prices).toEqual({
        checked: true,
        pinsChecked: 1,
        lookupKeysChecked: expect.any(Number),
        issues: [
          {
            planKey: 'pro_monthly',
            currency: 'USD',
            problem: 'pin_mismatch',
            expected: { amountMinor: 2499, currency: 'USD', recurring: { interval: 'month', intervalCount: 1 } },
            found: { amountMinor: 1999, currency: 'USD', recurring: { interval: 'month', intervalCount: 1 }, active: true },
          },
          {
            planKey: 'pro_weekly',
            currency: 'USD',
            problem: 'synced_archived',
            expected: { amountMinor: weekly.amountMinor, currency: 'USD', recurring: { interval: 'week', intervalCount: 1 } },
            found: { amountMinor: weekly.amountMinor, currency: 'USD', recurring: { interval: 'week', intervalCount: 1 }, active: false },
          },
        ],
      });
      expect(res.body.data.prices.lookupKeysChecked).toBeGreaterThan(0);
      // The seven fields of the readout are what they are without the flag.
      expect(res.body.data).toMatchObject({ keyMode: 'test', usable: true, railReady: true, pinnedPlans: ['pro_monthly'] });
      expect(res.text).not.toMatch(SECRET_SHAPED);
      // Read-only: prices are retrieved and listed, nothing is written.
      expect(stripe.prices.retrieve).toHaveBeenCalledTimes(1);
      expect(Object.keys(stripe.prices)).toEqual(['retrieve', 'list']);
    });

    it('a pinned price Stripe does not know is reported; healthy prices give no issue', async () => {
      env.current = { ...KEYS, STRIPE_PRICE_PRO_MONTHLY: 'price_gone', PRICE_PRO_MONTHLY_USD_CENTS: '2499' };
      const missing = (await readPrices()).body.data.prices;
      expect(missing.issues).toEqual([
        { planKey: 'pro_monthly', currency: 'USD', problem: 'pin_not_found', expected: { amountMinor: 2499, currency: 'USD', recurring: { interval: 'month', intervalCount: 1 } }, found: null },
      ]);

      account.prices.set('price_gone', { id: 'price_gone', unit_amount: 2499, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, active: true, lookup_key: null });
      const healthy = await readPrices();
      expect(healthy.body.data.prices).toMatchObject({ checked: true, pinsChecked: 1, issues: [] });
      expect(healthy.text).not.toMatch(SECRET_SHAPED);
    });

    it('says the check was not made for a key that may not read prices, and asks Stripe nothing without a usable key', async () => {
      env.current = { ...KEYS, STRIPE_SECRET_KEY: 'rk_test_abcdefghijklmnop' };
      stripe.prices.list.mockRejectedValueOnce(stripeError({ type: 'StripePermissionError', statusCode: 403 }));
      expect((await readPrices()).body.data.prices).toEqual({ checked: false, pinsChecked: 0, lookupKeysChecked: 0, issues: [], reason: 'restricted_key' });

      vi.clearAllMocks();
      env.current = { STRIPE_SECRET_KEY: 'sk_live_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: 'whsec_one_secret_value', VERCEL_ENV: 'preview' };
      const refused = await readPrices();
      expect(refused.body.data).toMatchObject({ usable: false, refusedReason: 'live_key_outside_production', prices: { checked: false, pinsChecked: 0, lookupKeysChecked: 0, issues: [] } });
      expect(refused.body.data.prices).not.toHaveProperty('reason');
      expect(stripeCalls()).toBe(0);
    });
  });

  it('only lists webhook endpoints: it never creates or edits one', async () => {
    env.current = { STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop', STRIPE_WEBHOOK_SECRET: 'whsec_one_secret_value' };
    await read();
    expect(Object.keys(stripe.webhookEndpoints)).toEqual(['list']);
    expect(stripeWrites()).toBe(0);
    // The endpoint that is checked is the one at RoboApply's public origin.
    account.endpoints = [
      { id: 'we_stage', status: 'enabled', url: 'https://staging.example.test/api/v1/roboapply/stripe/webhook', enabled_events: ['invoice.paid'] },
      { id: 'we_prod', status: 'enabled', url: WEBHOOK_URL, enabled_events: ['*'] },
    ];
    expect((await read()).body.data.endpoint).toEqual({ checked: true, url: WEBHOOK_URL, missingEvents: [] });

    // An endpoint registered with credentials or a token in its URL is shown by its address only.
    account.endpoints = [{ id: 'we_tok', status: 'enabled', url: 'https://hook:whsec_in_userinfo@www.roboapply.io/api/v1/roboapply/stripe/webhook?token=sk_test_in_query#frag', enabled_events: ['*'] }];
    const res = await read();
    expect(res.body.data.endpoint.url).toBe(WEBHOOK_URL);
    expect(res.text).not.toMatch(SECRET_SHAPED);
  });
});
