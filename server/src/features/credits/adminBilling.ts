// server/src/features/credits/adminBilling.ts — what staff can do and read
// about money (docs/jobright-clone/market/MARKET_STRATEGY.md §4.4 "How a
// refund is executed", §5.1 "Refunds and disputes" and "Endpoint health",
// §5.3 G13, §7 item 17). The routes are in adminRoutes.ts; the shapes in
// adminBillingTypes.ts.
//
//   refund          one Stripe refund through the refund engine (`issueRefund`),
//                   then one admin audit row per refund (a retry that gets the
//                   same refund back is not audited twice; the claim that says
//                   so and the row are one transaction, so a row that was not
//                   stored is written by the next request). It changes NO
//                   entitlement: access changes when Stripe reports the money
//                   went back (`charge.refunded`), so a refund made in the
//                   Stripe Dashboard behaves the same.
//   listRefunds     RABillingRefund rows, newest first: refunds, withdrawals,
//                   disputes and manual CN records.
//   cnOrders        a user's completed CN orders, each with its refunded marker.
//   recordCnRefund  the manual refund record of a CN order (AL-7). The Alipay
//                   and WeChat Pay rails have no refund call here: staff return
//                   the money in the merchant console, then record it. A full
//                   amount reverses what the order bought, once.
//   practiceCost    average platform cost of the last 50 practice sessions per
//                   brand, in USD as the usage log stores it. Read-only.
//   stripeHealth    key mode, the live-key guard, webhook secrets, the events
//                   the webhook endpoint lacks, pinned plans and, when asked
//                   for, the prices the catalog charges on against what Stripe
//                   holds. Never a key, a secret or a price id; never edits
//                   anything at Stripe.
//
// The manual CN record, step by step:
//   1. the order must be a completed seeker order (`tier` starts with `ra_`);
//   2. one transaction claims `billing:refund:cn:<orderId>` and writes the
//      RABillingRefund row (kind 'manual_cn'), so an order is recorded once,
//      under replay and under two requests at the same moment;
//   3. a FULL amount reverses the entitlement with the engine's own rules: a
//      pack loses what is left of it, a pass loses one pass length (passes
//      stack, so a pass under another one shortens access and does not end
//      it). The request that recorded the order does it. Another request
//      finishes a reversal only when that one failed or never came back, so a
//      double click leaves the work, and the audit row, to the first;
//   4. entitlements are invalidated and one admin audit row is written.
// AlipayOrder is never written (rule A8): its status stays `completed`, the
// order stays in the buyer's history (rule A10) and the marker is the refund
// row. Nothing here touches fulfilPass, a rail or the callback.
//
// Dependencies are injectable; the defaults are imported on first use, so
// importing this module opens no database client.

import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, parseBrandId, type BrandId } from '../../platform/brand/registry.js';
import {
  claimBillingEvent,
  getPlanCatalog,
  getStripe as platformGetStripe,
  isBillingError,
  isLegacyPlanKey,
  issueRefund as engineIssueRefund,
  planDefinitionFor,
  reversePackGrant as engineReversePackGrant,
  reversePassPeriod as engineReversePassPeriod,
  stripeKeyMode,
  stripeKeyUsable,
  stripeRailReady,
  stripeWebhookSecrets,
  type RefundDb,
  type StripeClient,
  type StripeRefundDeps,
} from '../../platform/billing/index.js';
import { packGrantId } from '../../platform/billing/packs.js';
import {
  checkStripePrices as platformCheckPrices,
  checkStripeWebhookEndpoint as platformCheckWebhookEndpoint,
} from '../../platform/billing/stripeHealth.js';
import { HttpError } from '../../platform/http.js';
import type { AuditInput } from '../admin/index.js';
import {
  ADMIN_REFUND_PAGE_SIZE,
  AdminBillingError,
  PRACTICE_COST_MAX_SESSIONS,
  PRACTICE_COST_MIN_SESSIONS,
  refundedMarkOf,
  type AdminCnOrdersResponse,
  type AdminRefundBody,
  type AdminRefundKind,
  type AdminRefundListQuery,
  type AdminRefundListResponse,
  type AdminRefundResponse,
  type AdminRefundRow,
  type CnRefundEntitlement,
  type PracticeCost,
  type PracticeCostResponse,
  type RecordCnRefundBody,
  type RecordCnRefundResponse,
  type StripeHealthPrices,
  type StripeHealthResponse,
} from './adminBillingTypes.js';

// ── Dependencies ──────────────────────────────────────────────────────────

export type AdminBillingDb = RefundDb & Pick<ExtendedPrismaClient, 'alipayOrder' | 'usageDeductionLog'>;

/** Where an audit row is written when it has to be part of a transaction: that transaction's client. */
export type AdminAuditDb = Pick<ExtendedPrismaClient, 'rAAdminAuditLog'>;

/** One usage-log row of the practice-interview SKU, as the cost readout reads it. */
export interface PracticeCostRow {
  id: string;
  /** The interview session the row is about (the writer sets it on every row). */
  relatedEntityId: string | null;
  platformCostUsd: number | null;
  metadata: unknown;
  createdAt: Date;
}

/** One page of the practice-cost read: the rows older than `before` (by `createdAt`, then `id`), or the newest ones. */
export interface PracticeCostPage {
  before: { createdAt: Date; id: string } | null;
  take: number;
}

export interface AdminBillingDeps {
  /** The database, or how to get it (the default imports the Prisma client on first use). */
  db: AdminBillingDb | (() => AdminBillingDb | Promise<AdminBillingDb>);
  getStripe: () => StripeClient | null;
  now: () => Date;
  env: () => EnvSource;
  /**
   * One admin audit row (features/admin `writeAdminAudit` on RAAdminAuditLog;
   * it never throws and answers 'log_only' when the row could not be stored).
   * With `tx` the row is written through that transaction, so it is stored or
   * not together with whatever else the transaction holds.
   */
  audit: (input: AuditInput, tx?: AdminAuditDb) => Promise<unknown>;
  invalidate: (userId: string) => void | Promise<void>;
  /** The refund engine (platform/billing/stripeRefunds.ts). */
  issueRefund: typeof engineIssueRefund;
  reversePackGrant: typeof engineReversePackGrant;
  reversePassPeriod: typeof engineReversePassPeriod;
  /** What the engine functions get besides the database, the Stripe client and the clock (tests replace the credit functions). */
  engineDeps: Partial<StripeRefundDeps>;
  checkWebhookEndpoint: typeof platformCheckWebhookEndpoint;
  checkPrices: typeof platformCheckPrices;
  /**
   * Usage-log rows of the practice SKU that carry a cost, for users of one
   * brand, newest first, one page at a time. The default reads
   * UsageDeductionLog through the user's brand.
   */
  practiceCostRows: (brand: BrandId, page: PracticeCostPage) => Promise<PracticeCostRow[]>;
}

const defaultDb = async (): Promise<AdminBillingDb> => (await import('../../lib/prisma.js')).default;

async function resolveDb(db: AdminBillingDeps['db']): Promise<AdminBillingDb> {
  return typeof db === 'function' ? await db() : db;
}

function defaultDeps(): AdminBillingDeps {
  const deps: AdminBillingDeps = {
    db: defaultDb,
    // The one client factory (stripeClient.ts), on the same environment the health readout describes.
    getStripe: () => platformGetStripe(deps.env()),
    now: () => new Date(),
    env: () => process.env,
    audit: async (input, tx) => {
      const { createPrismaAuditStore, writeAdminAudit } = await import('../admin/index.js');
      return writeAdminAudit(tx ? createPrismaAuditStore(tx) : createPrismaAuditStore(), input);
    },
    invalidate: async (userId) => (await import('../../platform/credits/index.js')).entitlementService.invalidate(userId),
    issueRefund: engineIssueRefund,
    reversePackGrant: engineReversePackGrant,
    reversePassPeriod: engineReversePassPeriod,
    engineDeps: {},
    checkWebhookEndpoint: platformCheckWebhookEndpoint,
    checkPrices: platformCheckPrices,
    practiceCostRows: async (brand, page) => {
      const db = await resolveDb(deps.db);
      // Paged by position in the order, never by a count of rows to skip: a
      // session that is written between two reads cannot move the window.
      const before = page.before;
      return db.usageDeductionLog.findMany({
        where: {
          sku: PRACTICE_SKU,
          platformCostUsd: { not: null },
          user: { brand },
          ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        select: { id: true, relatedEntityId: true, platformCostUsd: true, metadata: true, createdAt: true },
      });
    },
  };
  return deps;
}

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * The usage-log SKU of a practice interview. interview-engine/billing/
 * sessionCost.ts `writeMockInterviewLedger` writes ONE row per finished
 * session: `relatedEntityType: 'interview_session'`, `relatedEntityId` = the
 * session id, `platformCostUsd` = the session's whole cost (model, speech,
 * recording), and in `metadata` the session's `sessionSource` and, for a staff
 * session that pays no credit, `creditExempt: true`.
 */
export const PRACTICE_SKU = 'mock_interview';
/** `InterviewSession.source` of candidate practice on both brands; other sources are recruiter and partner interviews. */
const PRACTICE_SESSION_SOURCE = 'roboapply';
const PRACTICE_PAGE = 200;
const PRACTICE_MAX_PAGES = 5;

/** A legacy `ra_starter` / `ra_growth` order bought 30 days (fulfilPass.ts). */
const LEGACY_PASS_DAYS = 30;
/** Completed orders listed for one user. */
const CN_ORDERS_LIMIT = 200;

export const ADMIN_AUDIT_REFUND_ISSUED = 'billing.refund_issued';
export const ADMIN_AUDIT_CN_REFUND_RECORDED = 'billing.cn_refund_recorded';

const REFUND_ROW_SELECT = {
  id: true,
  userId: true,
  brand: true,
  rail: true,
  kind: true,
  amountMinor: true,
  currency: true,
  full: true,
  entitlementReversed: true,
  reason: true,
  actor: true,
  invoiceId: true,
  checkoutSessionId: true,
  alipayOrderId: true,
  createdAt: true,
} as const;

const CN_ORDER_SELECT = {
  id: true,
  userId: true,
  outTradeNo: true,
  tier: true,
  status: true,
  amount: true,
  amountMinor: true,
  channel: true,
  brand: true,
  planKey: true,
  completedAt: true,
  createdAt: true,
} as const;

interface CnOrder {
  id: string;
  userId: string;
  outTradeNo: string;
  tier: string;
  status: string;
  amount: number;
  amountMinor: number | null;
  channel: string;
  brand: string | null;
  planKey: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

const SEEKER_ORDER_PREFIX = 'ra_';
const CN_ENTITLEMENTS: readonly CnRefundEntitlement[] = ['pass_ended', 'pass_shortened', 'pack_zeroed', 'none'];
const NOTE_PREFIX = 'entitlement: ';
/** On a record whose reversal threw: the next request may finish it at once. */
const NOTE_NOT_REVERSED = `${NOTE_PREFIX}not_reversed`;
/**
 * How long the request that recorded a CN refund has its reversal to itself.
 * A second request inside that time is a double click and leaves the work to
 * the first; after it, the first request is taken to be gone (the process
 * stopped) and the next one finishes the reversal.
 */
export const CN_REVERSAL_HANDOVER_MS = 30_000;

/** The engine's refusals that can mean "this money already went back": the retry of a refund whose first request never got to its audit row. */
const REFUSED_AS_REFUNDED: readonly string[] = ['already_refunded', 'amount_above_refundable'];
/** Refunds read from Stripe for one payment when a refused retry is checked (a payment has a handful at most). */
const REFUNDS_PER_PAYMENT = 100;

/** The audit row of a refund could not be stored: the transaction that claimed it is rolled back. */
class AuditNotStored extends Error {
  constructor() {
    super('admin audit row not stored');
    this.name = 'AuditNotStored';
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────

function cnChannel(order: Pick<CnOrder, 'channel'>): 'alipay' | 'wechatpay' {
  return order.channel === 'wechatpay' ? 'wechatpay' : 'alipay';
}

function cnPlanKey(order: Pick<CnOrder, 'planKey' | 'tier'>): string {
  return order.planKey ?? order.tier.slice(SEEKER_ORDER_PREFIX.length);
}

function cnAmountMinor(order: Pick<CnOrder, 'amount' | 'amountMinor'>): number {
  return order.amountMinor ?? Math.round(order.amount * 100);
}

function cnExternalRef(orderId: string): string {
  return `order:${orderId}`;
}

function invalidRequest(path: string, message: string): HttpError {
  return new HttpError('invalid_request', message, { where: 'body', issues: [{ path: [path], code: 'custom', message }] });
}

function refundCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function parseRefundCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf('|');
  const createdAt = at > 0 ? new Date(cursor.slice(0, at)) : new Date(Number.NaN);
  const id = at > 0 ? cursor.slice(at + 1) : '';
  if (Number.isNaN(createdAt.getTime()) || !id) {
    throw new HttpError('invalid_request', 'The cursor is not valid.', { where: 'query', issues: [{ path: ['cursor'], code: 'custom', message: 'Unknown cursor' }] });
  }
  return { createdAt, id };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function storedEntitlement(note: string | null | undefined): CnRefundEntitlement {
  const value = note?.startsWith(NOTE_PREFIX) ? note.slice(NOTE_PREFIX.length) : '';
  return (CN_ENTITLEMENTS as readonly string[]).includes(value) ? (value as CnRefundEntitlement) : 'none';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── The service ───────────────────────────────────────────────────────────

export class AdminBillingService {
  private readonly d: AdminBillingDeps;

  constructor(deps: Partial<AdminBillingDeps> = {}) {
    // Assigned onto the defaults object itself: the default row reader reads the database from it.
    const given = Object.fromEntries(Object.entries(deps).filter(([, value]) => value !== undefined)) as Partial<AdminBillingDeps>;
    this.d = Object.assign(defaultDeps(), given);
  }

  private db(): Promise<AdminBillingDb> {
    return resolveDb(this.d.db);
  }

  /**
   * Write one audit row; true when it was stored. The action already happened:
   * a row that cannot be written is logged and never undoes or fails it.
   */
  private async audit(input: AuditInput, tx?: AdminAuditDb): Promise<boolean> {
    try {
      return (await this.d.audit(input, tx)) !== 'log_only';
    } catch (err) {
      logger.error('RA_BILLING', 'admin billing audit row failed', { eventType: input.eventType, adminId: input.adminId, subjectUserId: input.subjectUserId ?? null, error: errorText(err) });
      return false;
    }
  }

  // ── Stripe refunds ──────────────────────────────────────────────────────

  /**
   * Refund a Stripe payment of a user, in full or in part, and write one
   * audit row. Throws 404 `not_found` (no such user), 422 `invalid_request`
   * (no attempt key), and the engine's 409 `refund_not_available`, 503
   * `rail_not_configured` and 502 `payment_provider_error`. A refusal writes
   * no audit row for the request it refuses: nothing happened. (It can write
   * the row of a refund an earlier request made and never got to audit; see
   * `auditRefundsMadeEarlier`.)
   */
  async refund(adminId: string, body: AdminRefundBody): Promise<AdminRefundResponse> {
    // Without it two refunds of the same amount on one payment are one Stripe
    // request: the second moves no money and still reads as a success.
    if (!body.attemptKey) throw invalidRequest('attemptKey', 'A refund needs an attempt key: one value per refund dialog, sent again when that dialog retries.');
    const db = await this.db();
    const user = await db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!user) throw new HttpError('not_found', 'No such user.');
    let issued: Awaited<ReturnType<typeof engineIssueRefund>>;
    try {
      issued = await this.d.issueRefund(
        {
          userId: body.userId,
          target: body.target,
          ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor } : {}),
          reason: body.reason,
          actor: adminId,
          kind: 'refund',
          attemptKey: body.attemptKey,
        },
        { ...this.d.engineDeps, db, getStripe: this.d.getStripe, now: this.d.now },
      );
    } catch (err) {
      if (isBillingError(err) && err.code === 'refund_not_available' && REFUSED_AS_REFUNDED.includes(String(err.details?.reason))) {
        await this.auditRefundsMadeEarlier(db, adminId, body);
      }
      throw err;
    }
    const result: AdminRefundResponse = { refundId: issued.refundId, amountMinor: issued.amountMinor, currency: issued.currency, full: issued.full };
    await this.auditRefundOnce(db, issued.refundId, {
      adminId,
      subjectUserId: body.userId,
      eventType: ADMIN_AUDIT_REFUND_ISSUED,
      payload: { refundId: result.refundId, target: body.target, amountMinor: result.amountMinor, currency: result.currency, full: result.full, reason: body.reason },
    });
    return result;
  }

  /**
   * One audit row per Stripe refund. A retry of the same dialog reaches Stripe
   * under the same key and gets the same refund back, so the row is written
   * under the claim `billing:adminrefund:<refund>`. The claim and the row are
   * ONE transaction: a row that could not be stored takes its claim with it
   * (so does a process that stops in between), and the next request that is
   * answered with this refund writes the row. A claim that cannot be written
   * never hides the row.
   */
  private async auditRefundOnce(db: AdminBillingDb, refundId: string, input: AuditInput): Promise<void> {
    const subject = input.subjectUserId ?? input.adminId;
    try {
      await db.$transaction(async (tx) => {
        if (!(await claimBillingEvent(tx, subject, `adminrefund:${refundId}`, 'stripe_refund', this.d.now()))) return;
        if (!(await this.audit(input, tx))) throw new AuditNotStored();
      });
    } catch (err) {
      if (err instanceof AuditNotStored) {
        logger.error('RA_BILLING', 'admin refund not audited: nothing is claimed, the next request for this refund writes the row', { adminId: input.adminId, userId: subject, refundId });
        return;
      }
      logger.error('RA_BILLING', 'admin refund claim failed; auditing anyway', { userId: subject, refundId, error: errorText(err) });
      await this.audit(input);
    }
  }

  /**
   * A refused retry can be the last request that knows about a refund: the
   * first request reached Stripe and stopped before its audit row, and by the
   * time the dialog retries, `charge.refunded` has recorded the money, so the
   * engine refuses ("already refunded", "above what is left"). Every refund
   * this admin made on that payment is then audited under the same per-refund
   * claim, so a refund that has its row never gets a second one. The refunds
   * are read from Stripe, which is where a refund names who made it; nothing
   * is asked of Stripe unless our rows say this admin refunded this payment.
   * A failure here is logged and the refusal is answered as it is.
   */
  private async auditRefundsMadeEarlier(db: AdminBillingDb, adminId: string, body: AdminRefundBody): Promise<void> {
    try {
      const target = 'invoiceId' in body.target ? { invoiceId: body.target.invoiceId } : { checkoutSessionId: body.target.checkoutSessionId };
      const rows = await db.rABillingRefund.findMany({
        where: { userId: body.userId, rail: 'stripe', kind: { in: ['refund', 'withdrawal'] }, ...target },
        select: { paymentIntentId: true, actor: true, full: true },
      });
      const paymentIntentId = rows.find((row) => row.actor === adminId && row.paymentIntentId)?.paymentIntentId;
      if (!paymentIntentId) return;
      const stripe = this.d.getStripe();
      if (!stripe) return;
      const list = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: REFUNDS_PER_PAYMENT });
      const made = (list.data ?? []).filter((r) => r.status !== 'failed' && r.status !== 'canceled').sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
      const last = made[made.length - 1];
      // Nothing is left of the payment when one of its rows says so; the refund that took the rest is the last one.
      const nothingLeft = rows.some((row) => row.full);
      for (const refund of made) {
        if (refund.metadata?.actor !== adminId || (refund.metadata?.kind ?? 'refund') !== 'refund') continue;
        await this.auditRefundOnce(db, refund.id, {
          adminId,
          subjectUserId: body.userId,
          eventType: ADMIN_AUDIT_REFUND_ISSUED,
          payload: {
            refundId: refund.id,
            target: body.target,
            amountMinor: refund.amount,
            currency: (refund.currency ?? '').toUpperCase(),
            full: nothingLeft && refund === last,
            reason: refund.metadata?.reason || body.reason,
            // Written by a later request than the one that made the refund.
            auditedLate: true,
          },
        });
      }
    } catch (err) {
      logger.error('RA_BILLING', 'refused refund: earlier refunds could not be checked for their audit rows', { adminId, userId: body.userId, error: errorText(err) });
    }
  }

  /** Refund rows, newest first, 50 a page: refunds, withdrawals, disputes and manual CN records. */
  async listRefunds(query: AdminRefundListQuery): Promise<AdminRefundListResponse> {
    const db = await this.db();
    const before = parseRefundCursor(query.cursor);
    const rows = await db.rABillingRefund.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ADMIN_REFUND_PAGE_SIZE + 1,
      select: REFUND_ROW_SELECT,
    });
    const page = rows.slice(0, ADMIN_REFUND_PAGE_SIZE);
    const items: AdminRefundRow[] = page.map((row) => ({
      id: row.id,
      userId: row.userId,
      brand: row.brand,
      rail: row.rail,
      kind: row.kind as AdminRefundKind,
      amountMinor: row.amountMinor,
      currency: row.currency,
      full: row.full,
      entitlementReversed: row.entitlementReversed,
      reason: row.reason ?? null,
      actor: row.actor ?? null,
      invoiceId: row.invoiceId ?? null,
      checkoutSessionId: row.checkoutSessionId ?? null,
      alipayOrderId: row.alipayOrderId ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
    return { items, cursor: rows.length > ADMIN_REFUND_PAGE_SIZE ? refundCursor(page[page.length - 1]!) : null };
  }

  // ── CN orders ───────────────────────────────────────────────────────────

  /** The completed seeker orders of a user on the CN rails, newest first, each with its refunded marker. */
  async cnOrders(userId: string): Promise<AdminCnOrdersResponse> {
    const db = await this.db();
    const orders: CnOrder[] = await db.alipayOrder.findMany({
      where: { userId, tier: { startsWith: SEEKER_ORDER_PREFIX }, status: 'completed' },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: CN_ORDERS_LIMIT,
      select: CN_ORDER_SELECT,
    });
    const refunds = orders.length
      ? await db.rABillingRefund.findMany({ where: { alipayOrderId: { in: orders.map((o) => o.id) } }, select: { alipayOrderId: true, kind: true, full: true } })
      : [];
    return {
      items: orders.map((order) => ({
        id: order.id,
        outTradeNo: order.outTradeNo,
        planKey: cnPlanKey(order),
        channel: cnChannel(order),
        amountMinor: cnAmountMinor(order),
        completedAt: (order.completedAt ?? order.createdAt).toISOString(),
        refunded: refundedMarkOf(refunds.filter((r) => r.alipayOrderId === order.id)),
      })),
    };
  }

  /**
   * Record that a CN order was refunded in the merchant console, and reverse
   * what it bought when the whole amount went back. One record per order: a
   * second call answers `already_recorded` and changes nothing. It finishes
   * the reversal only when the call that recorded the order could not: that
   * call failed (the row says so), or it has not come back for
   * `CN_REVERSAL_HANDOVER_MS`. A second call that arrives while the first is
   * still at work is a double click and leaves the reversal, and its audit
   * row, to the first.
   *
   * Throws 404 `not_found` (no such order, or a recruiter order), 409
   * `order_not_completed`, 422 `invalid_request` (an amount above the order).
   */
  async recordCnRefund(adminId: string, orderId: string, body: RecordCnRefundBody): Promise<RecordCnRefundResponse> {
    const db = await this.db();
    const order: CnOrder | null = await db.alipayOrder.findUnique({ where: { id: orderId }, select: CN_ORDER_SELECT });
    // Recruiter orders share the table (rule A3): a tier without the prefix is not ours.
    if (!order || !order.tier.startsWith(SEEKER_ORDER_PREFIX)) throw new HttpError('not_found', 'No such order.');
    if (order.status !== 'completed') throw new AdminBillingError('order_not_completed', 'This order was never paid, so there is no refund to record.', { status: order.status });

    const paidMinor = cnAmountMinor(order);
    const refundedMinor = body.refundedAmountMinor ?? paidMinor;
    if (refundedMinor > paidMinor) throw invalidRequest('refundedAmountMinor', 'The refunded amount is above what the order paid.');
    const full = refundedMinor === paidMinor;
    const rail = cnChannel(order);
    const planKey = cnPlanKey(order);
    const brand: BrandId = parseBrandId(order.brand) ?? 'roboapply';
    const externalRef = cnExternalRef(order.id);
    const now = this.d.now();

    // The claim and the row are one transaction: an order is recorded once.
    const rowSelect = { id: true, amountMinor: true, full: true, entitlementReversed: true, note: true, createdAt: true } as const;
    const { fresh, row } = await db.$transaction(async (tx) => {
      const existing = await tx.rABillingRefund.findFirst({ where: { rail, externalRef }, select: rowSelect });
      if (existing) return { fresh: false, row: existing };
      if (!(await claimBillingEvent(tx, order.userId, `refund:cn:${order.id}`, 'cn_refund', now))) return { fresh: false, row: null };
      const created = await tx.rABillingRefund.create({
        data: {
          userId: order.userId,
          brand,
          rail,
          kind: 'manual_cn',
          externalRef,
          alipayOrderId: order.id,
          planKey,
          amountMinor: refundedMinor,
          currency: 'CNY',
          full,
          entitlementReversed: false,
          reason: body.reason,
          actor: adminId,
          // The service clock, the one the handover below is measured on.
          createdAt: now,
        },
        select: rowSelect,
      });
      return { fresh: true, row: created };
    });

    // Only a full refund changes access, and the call that recorded it does
    // the reversal. Any other call leaves it alone unless that one failed or
    // is gone: two calls at the same moment would otherwise both try, and the
    // one that did not record the order could be the one that does the work.
    const mayReverse = fresh || row?.note === NOTE_NOT_REVERSED || (row ? now.getTime() - row.createdAt.getTime() >= CN_REVERSAL_HANDOVER_MS : false);
    let outcome: CnRefundEntitlement = 'none';
    let reversalFailed = false;
    try {
      if (row && row.full && !row.entitlementReversed && mayReverse) {
        outcome = await this.reverseCnEntitlement(db, order, planKey, brand);
        if (outcome !== 'none') await db.rABillingRefund.updateMany({ where: { id: row.id }, data: { entitlementReversed: true, note: `${NOTE_PREFIX}${outcome}` } });
      }
    } catch (err) {
      reversalFailed = true;
      logger.error('RA_BILLING', 'cn refund recorded, entitlement not reversed', { orderId: order.id, userId: order.userId, error: errorText(err) });
      // Said on the row, so the next request finishes the reversal without waiting for the handover.
      if (row) {
        await db.rABillingRefund
          .updateMany({ where: { id: row.id, entitlementReversed: false }, data: { note: NOTE_NOT_REVERSED } })
          .catch((markErr: unknown) => logger.error('RA_BILLING', 'cn refund: failed reversal not marked on the row', { orderId: order.id, error: errorText(markErr) }));
      }
      throw err;
    } finally {
      // The first record always, and a later call only when it finished the reversal.
      if (fresh || outcome !== 'none') {
        await this.audit({
          adminId,
          subjectUserId: order.userId,
          eventType: ADMIN_AUDIT_CN_REFUND_RECORDED,
          payload: {
            orderId: order.id,
            outTradeNo: order.outTradeNo,
            channel: rail,
            planKey,
            amountMinor: row?.amountMinor ?? refundedMinor,
            currency: 'CNY',
            full: row?.full ?? full,
            entitlement: reversalFailed ? 'not_reversed' : outcome,
            reason: body.reason,
            ...(fresh ? {} : { completesEarlierRecord: true }),
          },
        });
      }
    }
    await this.d.invalidate(order.userId);
    logger.info('RA_BILLING', 'cn refund record', { orderId: order.id, userId: order.userId, fresh, full: row?.full ?? full, outcome, actor: adminId });
    return { status: fresh ? 'recorded' : 'already_recorded', orderId: order.id, entitlement: outcome !== 'none' ? outcome : storedEntitlement(row?.note) };
  }

  /** What a fully refunded CN order takes back: the rest of its pack, or one pass length of the running pass. */
  private async reverseCnEntitlement(db: AdminBillingDb, order: CnOrder, planKey: string, brand: BrandId): Promise<CnRefundEntitlement> {
    const profile = await db.seekerProfile.findUnique({ where: { userId: order.userId }, select: { id: true } });
    if (!profile) return 'none';
    const engine: Partial<StripeRefundDeps> = { ...this.d.engineDeps, db, now: this.d.now };
    const ref = cnExternalRef(order.id);
    const source = cnChannel(order);
    const legacy = isLegacyPlanKey(planKey);
    const def = legacy ? null : planDefinitionFor(brand, planKey);
    if (def?.kind === 'pack') {
      // The grant row fulfilPass made for this order (packs.ts): same key, same id.
      return this.d.reversePackGrant({ userId: order.userId, seekerProfileId: profile.id, grantId: packGrantId(order.userId, ref), ref, source }, engine);
    }
    const passDays = legacy ? LEGACY_PASS_DAYS : def?.kind === 'pass' ? def.passDays : null;
    if (!passDays) return 'none';
    return this.d.reversePassPeriod(
      {
        userId: order.userId,
        seekerProfileId: profile.id,
        planKey,
        passDays,
        // Its own claim, taken with the row change in one transaction (not the record's claim above).
        claimKey: `reversal:cn:${order.id}`,
        claimRefType: 'cn_refund',
        source,
        // When fulfilPass activated it: a pass that was over before the run that is live now began takes nothing off the newer one.
        purchasedAt: order.completedAt ?? order.createdAt,
      },
      engine,
    );
  }

  // ── Practice cost ───────────────────────────────────────────────────────

  /** Average platform cost of the last 50 practice sessions, per brand. */
  async practiceCost(): Promise<PracticeCostResponse> {
    const [roboapply, goapply] = await Promise.all([this.practiceCostOf('roboapply'), this.practiceCostOf('goapply')]);
    return { brands: { roboapply, goapply } };
  }

  private async practiceCostOf(brand: BrandId): Promise<PracticeCost> {
    // Newest first, so a session is first seen at its newest row.
    const sessions = new Map<string, { costUsd: number; at: Date }>();
    // A usage row is added once, whatever a page hands back.
    const counted = new Set<string>();
    let before: PracticeCostPage['before'] = null;
    for (let page = 0; page < PRACTICE_MAX_PAGES; page += 1) {
      const rows = await this.d.practiceCostRows(brand, { before, take: PRACTICE_PAGE });
      for (const row of rows) {
        if (counted.has(row.id)) continue;
        counted.add(row.id);
        const cost = row.platformCostUsd;
        if (typeof cost !== 'number' || !Number.isFinite(cost)) continue; // no cost recorded: not counted
        const meta = asRecord(row.metadata);
        // Candidate practice only: not a recruiter or partner interview, not a staff session that pays no credit.
        if (typeof meta.sessionSource === 'string' && meta.sessionSource !== PRACTICE_SESSION_SOURCE) continue;
        if (meta.creditExempt === true) continue;
        const key = row.relatedEntityId?.trim() || (typeof meta.sessionId === 'string' && meta.sessionId.trim()) || `row:${row.id}`;
        const seen = sessions.get(key);
        if (seen) seen.costUsd += cost;
        else sessions.set(key, { costUsd: cost, at: row.createdAt });
      }
      const last = rows[rows.length - 1];
      if (!last || rows.length < PRACTICE_PAGE || countMetered(sessions) > PRACTICE_COST_MAX_SESSIONS) break;
      // The next page starts after the last row read, not after a number of rows.
      before = { createdAt: last.createdAt, id: last.id };
    }
    // The writer stores 0 for a session it could not meter (and for one that never ran): that is no cost reading.
    const sample = [...sessions.values()]
      .filter((s) => s.costUsd > 0)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, PRACTICE_COST_MAX_SESSIONS);
    const enough = sample.length >= PRACTICE_COST_MIN_SESSIONS;
    const total = sample.reduce((sum, s) => sum + s.costUsd, 0);
    return {
      sampleSize: sample.length,
      averageUsd: enough ? Math.round((total / sample.length) * 10_000) / 10_000 : null,
      enough,
      maxSessions: PRACTICE_COST_MAX_SESSIONS,
      minSessions: PRACTICE_COST_MIN_SESSIONS,
      oldest: sample.length ? sample[sample.length - 1]!.at.toISOString() : null,
      newest: sample.length ? sample[0]!.at.toISOString() : null,
    };
  }

  // ── Stripe health ───────────────────────────────────────────────────────

  /**
   * What staff need to see about the Stripe rail. Without a usable key (none,
   * or a live key outside production) no Stripe client is asked for and no
   * call is made. The endpoint check lists and never edits.
   *
   * With `prices`, the answer also carries the price check: every pinned price
   * against the catalog, and every synced price that was archived or differs.
   * It reads one price per pin and one list per group of lookup keys, so it is
   * made only when asked for. It reports plans and amounts, never a price id.
   */
  async stripeHealth(opts: { prices?: boolean } = {}): Promise<StripeHealthResponse> {
    const env = this.d.env();
    const key = stripeKeyUsable(env);
    let endpoint: StripeHealthResponse['endpoint'] = { checked: false, url: null, missingEvents: [] };
    let prices: StripeHealthPrices = { checked: false, pinsChecked: 0, lookupKeysChecked: 0, issues: [] };
    const stripe = key.usable ? this.d.getStripe() : null;
    if (stripe) {
      // Stripe delivers to RoboApply's public origin (GoApply has no Stripe rail).
      const check = await this.d.checkWebhookEndpoint(stripe, { origin: getBrand('roboapply').canonicalOrigin });
      endpoint = { checked: check.checked, url: endpointAddress(check.url), missingEvents: [...check.missingEvents], ...(check.reason ? { reason: check.reason } : {}) };
      if (opts.prices) {
        const found = await this.d.checkPrices(stripe, env);
        prices = {
          checked: found.checked,
          pinsChecked: found.pinsChecked,
          lookupKeysChecked: found.lookupKeysChecked,
          // Field by field: the check also knows the price id, which is not printed here.
          issues: found.issues.map((issue) => ({
            planKey: issue.planKey,
            currency: issue.currency,
            problem: issue.problem,
            expected: { amountMinor: issue.expected.amountMinor, currency: issue.expected.currency, recurring: issue.expected.recurring ? { ...issue.expected.recurring } : null },
            found: issue.found
              ? { amountMinor: issue.found.amountMinor, currency: issue.found.currency, recurring: issue.found.recurring ? { ...issue.found.recurring } : null, active: issue.found.active }
              : null,
          })),
          ...(found.reason ? { reason: found.reason } : {}),
        };
      }
    }
    return {
      keyMode: stripeKeyMode(env),
      usable: key.usable,
      refusedReason: key.reason,
      webhookSecrets: stripeWebhookSecrets(env).length,
      railReady: stripeRailReady(env),
      endpoint,
      // The plan keys only: a pinned price id is configuration, not something to print.
      pinnedPlans: getPlanCatalog('roboapply', env)
        .filter((plan) => Boolean(plan.stripePriceId || plan.twdPrice?.stripePriceId))
        .map((plan) => plan.key),
      ...(opts.prices ? { prices } : {}),
    };
  }
}

/** Where an endpoint is, without anything a URL can carry besides that (credentials, a query string, a fragment). */
function endpointAddress(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function countMetered(sessions: ReadonlyMap<string, { costUsd: number }>): number {
  let n = 0;
  for (const s of sessions.values()) if (s.costUsd > 0) n += 1;
  return n;
}

export const adminBillingService = new AdminBillingService();
