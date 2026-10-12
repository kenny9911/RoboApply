// lib/api/adminBilling.ts
//
// Admin billing calls of /admin/credits (market wave M4: ST-4, AL-7, PC-5 and
// ST-3 web halves): issue a refund through Stripe, list a user's refunds,
// withdrawals and disputes, record a refund of a mainland order that staff
// returned by hand, read the average cost of a practice session and the state
// of the Stripe rail.
//
// The server half (MKT-4B) is built in parallel, so nothing here is a mirrored
// contract type: the request and response shapes are written by hand from the
// contract text (MARKET_TASK_PLAN.md §3.1) and every answer goes through a
// normaliser with a safe default. Anything absent or malformed reads as "not
// stated": the console then prints a dash or "could not be checked", never a
// number the server did not send (D3). Plain `roboApi` calls on purpose: this
// file is not one of the documented wrapper files that
// __tests__/contracts/fixtures.test.ts checks against the server mount table.
//
//   POST /api/v1/roboapply/admin/credits/refunds
//        { userId, target: { invoiceId } | { checkoutSessionId }, amountMinor?, reason, attemptKey? }
//     -> { refundId, amountMinor, currency, full }
//     errors 404 not_found · 409 refund_not_available · 503 rail_not_configured · 502 payment_provider_error
//   GET  …/refunds?userId=&cursor=
//     -> { items: AdminRefundRow[], cursor: string | null }
//   GET  …/cn-orders?userId=
//     -> { items: CnOrderRow[] }   (a row carries `reversalPending: true` only when its full record stopped half
//        way; sent by the server since the M4 gate, absent otherwise)
//   POST …/cn-orders/:orderId/refund { reason, confirmMoneyReturned: true, refundedAmountMinor? }
//     -> { status: 'recorded' | 'already_recorded', orderId, entitlement }
//     errors 404 not_found · 409 order_not_completed · 422 invalid_request
//   GET  …/practice-cost  -> { brands: { roboapply: PracticeCost, goapply: PracticeCost } }
//   GET  …/stripe-health  -> StripeHealth (never a key, a secret or a price id)

import { roboApi, type RequestOptions } from './client';

const BASE = '/api/v1/roboapply/admin/credits';

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const items = (v: unknown): Rec[] => (isRecord(v) && Array.isArray(v.items) ? v.items.filter(isRecord) : []);

// ── Refund through Stripe (ST-4) ────────────────────────────────────────────

/** What a refund is made against: a paid invoice, or a one-time Checkout Session. */
export type AdminRefundTarget = { invoiceId: string } | { checkoutSessionId: string };

/** A Stripe invoice id (`in_…`) or Checkout Session id (`cs_…`) as staff paste it. */
export const STRIPE_INVOICE_ID_PATTERN = /^in_[A-Za-z0-9_]{8,200}$/;
export const STRIPE_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{8,200}$/;

/** The target a pasted id names, or null when it is neither an invoice nor a Checkout Session id. */
export function refundTargetOf(value: string | null | undefined): AdminRefundTarget | null {
  const id = (value ?? '').trim();
  if (STRIPE_INVOICE_ID_PATTERN.test(id)) return { invoiceId: id };
  if (STRIPE_SESSION_ID_PATTERN.test(id)) return { checkoutSessionId: id };
  return null;
}

/** The id inside a target, for display. */
export function refundTargetId(target: AdminRefundTarget): string {
  return 'invoiceId' in target ? target.invoiceId : target.checkoutSessionId;
}

export interface AdminRefundBody {
  userId: string;
  target: AdminRefundTarget;
  /** Minor units; omitted = everything that can still be refunded. */
  amountMinor?: number;
  /** Why, 1 to 300 characters. Kept on the refund and in the admin audit row. */
  reason: string;
  /**
   * Names ONE refund decision (waveM2-carryover MKT-4B.2a). Without it a
   * second refund of the same amount on one payment is, for the payment
   * provider, the first request again: its stored answer comes back and no
   * money moves. The console makes one value per confirmation it shows and
   * sends the same value when that confirmation is retried.
   */
  attemptKey?: string;
}

/** What the server accepts as a refund attempt key (letters, digits, `-`, `_`; a UUID fits). */
export const REFUND_ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface AdminRefundResult {
  refundId: string | null;
  /** What was refunded, when the server states it. */
  amountMinor: number | null;
  currency: string | null;
  /** Nothing of the payment is left to refund after this one (null: not stated). */
  full: boolean | null;
}

export function normaliseAdminRefund(raw: unknown): AdminRefundResult {
  const r = isRecord(raw) ? raw : {};
  const currency = text(r.currency);
  const amountMinor = count(r.amountMinor);
  const stated = amountMinor !== null && !!currency;
  return {
    refundId: text(r.refundId),
    amountMinor: stated ? amountMinor : null,
    currency: stated ? currency!.toUpperCase() : null,
    full: typeof r.full === 'boolean' ? r.full : null,
  };
}

/** The request body: the attempt key is sent only in the accepted form, an amount only when it is a positive whole number. */
export function adminRefundRequestBody(body: AdminRefundBody): Rec {
  const key = typeof body.attemptKey === 'string' ? body.attemptKey.trim() : '';
  return {
    userId: body.userId.trim(),
    target: body.target,
    ...(typeof body.amountMinor === 'number' && Number.isInteger(body.amountMinor) && body.amountMinor > 0 ? { amountMinor: body.amountMinor } : {}),
    reason: body.reason.trim(),
    ...(REFUND_ATTEMPT_KEY_PATTERN.test(key) ? { attemptKey: key } : {}),
  };
}

// ── Refunds, withdrawals and disputes of one user ───────────────────────────

export type AdminRefundKind = 'refund' | 'withdrawal' | 'dispute' | 'manual_cn';
const REFUND_KINDS: readonly AdminRefundKind[] = ['refund', 'withdrawal', 'dispute', 'manual_cn'];

export interface AdminRefundRow {
  id: string;
  userId: string | null;
  brand: string | null;
  /** 'stripe', 'alipay' or 'wechatpay' today; shown as sent. */
  rail: string | null;
  /** A kind this build does not know reads as 'other', never as a refund. */
  kind: AdminRefundKind | 'other';
  amountMinor: number | null;
  currency: string | null;
  full: boolean;
  /** The access the charge bought was taken back. */
  entitlementReversed: boolean;
  reason: string | null;
  /** An admin's user id, 'self', 'public_link' or the payment provider. */
  actor: string | null;
  invoiceId: string | null;
  checkoutSessionId: string | null;
  alipayOrderId: string | null;
  createdAt: string | null;
}

export interface AdminRefundsPage {
  items: AdminRefundRow[];
  cursor: string | null;
}

export function normaliseAdminRefunds(raw: unknown): AdminRefundsPage {
  const rows: AdminRefundRow[] = [];
  for (const r of items(raw)) {
    const id = text(r.id);
    if (!id) continue;
    const currency = text(r.currency);
    const amountMinor = count(r.amountMinor);
    rows.push({
      id,
      userId: text(r.userId),
      brand: text(r.brand),
      rail: text(r.rail),
      kind: REFUND_KINDS.includes(r.kind as AdminRefundKind) ? (r.kind as AdminRefundKind) : 'other',
      amountMinor: currency ? amountMinor : null,
      currency: amountMinor !== null && currency ? currency.toUpperCase() : null,
      full: r.full === true,
      entitlementReversed: r.entitlementReversed === true,
      reason: text(r.reason),
      actor: text(r.actor),
      invoiceId: text(r.invoiceId),
      checkoutSessionId: text(r.checkoutSessionId),
      alipayOrderId: text(r.alipayOrderId),
      createdAt: text(r.createdAt),
    });
  }
  return { items: rows, cursor: isRecord(raw) ? text(raw.cursor) : null };
}

// ── Mainland orders and the manual refund record (AL-7) ─────────────────────

export interface CnOrderRow {
  id: string;
  outTradeNo: string | null;
  planKey: string | null;
  channel: 'alipay' | 'wechatpay';
  /** Fen. */
  amountMinor: number | null;
  completedAt: string | null;
  /** A refund is already recorded for this order: all of it, or part of it. */
  refunded: 'full' | 'partial' | null;
  /**
   * A full refund is recorded but what the order bought was not taken back
   * (the record stopped half way). Optional on the wire: a server that does
   * not send it reads as false, and the console then finds the same fact in
   * the user's refunds list (`cnReversalOpen`).
   */
  reversalPending: boolean;
}

export function normaliseCnOrders(raw: unknown): { items: CnOrderRow[] } {
  const rows: CnOrderRow[] = [];
  for (const r of items(raw)) {
    const id = text(r.id);
    if (!id) continue;
    rows.push({
      id,
      outTradeNo: text(r.outTradeNo),
      planKey: text(r.planKey),
      channel: r.channel === 'wechatpay' ? 'wechatpay' : 'alipay',
      amountMinor: count(r.amountMinor),
      completedAt: text(r.completedAt),
      refunded: r.refunded === 'full' || r.refunded === 'partial' ? r.refunded : null,
      reversalPending: r.reversalPending === true,
    });
  }
  return { items: rows };
}

/**
 * The orders whose full refund is on record with no access taken back, by
 * order id, each with the reason it was recorded with. Either the record
 * stopped half way (the server finishes it on the next call for that order),
 * or nothing was left to take back (the next call then changes nothing and
 * says so). Read from the refunds the console has loaded: a row of kind
 * `manual_cn` that is `full` with `entitlementReversed: false`.
 */
export function cnReversalOpen(rows: readonly AdminRefundRow[]): Map<string, { reason: string | null }> {
  const open = new Map<string, { reason: string | null }>();
  for (const r of rows) {
    if (r.kind === 'manual_cn' && r.full && !r.entitlementReversed && r.alipayOrderId && !open.has(r.alipayOrderId)) open.set(r.alipayOrderId, { reason: r.reason });
  }
  return open;
}

/**
 * The reason sent when staff ask the server to look at an existing record
 * again and its own reason is not on the page. The server keeps a reason only
 * with a NEW record; on an existing one it goes to the audit line of the
 * finished reversal.
 */
export const CN_RECHECK_REASON = 'Check of an earlier refund record';

export interface CnRefundBody {
  /** Why, 1 to 300 characters. */
  reason: string;
  /** Staff confirm the money was returned in the merchant console. The server refuses anything but true. */
  confirmMoneyReturned: true;
  /** Fen, when less than the order was returned (a partial record changes no access). */
  refundedAmountMinor?: number;
}

export type CnRefundEntitlement = 'pass_ended' | 'pass_shortened' | 'pack_zeroed' | 'none';
const CN_ENTITLEMENTS: readonly CnRefundEntitlement[] = ['pass_ended', 'pass_shortened', 'pack_zeroed', 'none'];

export interface CnRefundResult {
  /** `already_recorded`: an earlier record stands and nothing changed now. */
  status: 'recorded' | 'already_recorded';
  orderId: string | null;
  /** What happened to the access the order bought (null: not stated). */
  entitlement: CnRefundEntitlement | null;
}

/** An answer that names neither status is not a record this client may confirm: it throws. */
export function normaliseCnRefund(raw: unknown): CnRefundResult {
  const r = isRecord(raw) ? raw : {};
  if (r.status !== 'recorded' && r.status !== 'already_recorded') throw new Error('Unexpected refund record answer');
  return {
    status: r.status,
    orderId: text(r.orderId),
    entitlement: CN_ENTITLEMENTS.includes(r.entitlement as CnRefundEntitlement) ? (r.entitlement as CnRefundEntitlement) : null,
  };
}

export function cnRefundRequestBody(body: CnRefundBody): Rec {
  return {
    reason: body.reason.trim(),
    confirmMoneyReturned: true,
    ...(typeof body.refundedAmountMinor === 'number' && Number.isInteger(body.refundedAmountMinor) && body.refundedAmountMinor > 0
      ? { refundedAmountMinor: body.refundedAmountMinor }
      : {}),
  };
}

// ── Practice-session cost (PC-5) ────────────────────────────────────────────

/** The contract's two sizes: the average covers the latest 50 sessions and needs at least 10. */
export const PRACTICE_COST_MAX_SESSIONS = 50;
export const PRACTICE_COST_MIN_SESSIONS = 10;

export interface PracticeCost {
  /** Sessions the average was taken over. */
  sampleSize: number;
  /** Average platform cost of one session in US dollars; null while there are too few sessions. */
  averageUsd: number | null;
  /** False: too few sessions, so no average is given. */
  enough: boolean;
  maxSessions: number;
  minSessions: number;
  oldest: string | null;
  newest: string | null;
}

export type PracticeCostBrand = 'roboapply' | 'goapply';
export const PRACTICE_COST_BRANDS: readonly PracticeCostBrand[] = ['roboapply', 'goapply'];

export interface PracticeCostResponse {
  /** A brand the server did not answer for is null (rendered "—"), never an empty sample. */
  brands: Record<PracticeCostBrand, PracticeCost | null>;
}

function practiceCost(raw: unknown): PracticeCost | null {
  if (!isRecord(raw)) return null;
  const sampleSize = count(raw.sampleSize);
  if (sampleSize === null) return null;
  const average = typeof raw.averageUsd === 'number' && Number.isFinite(raw.averageUsd) && raw.averageUsd >= 0 ? raw.averageUsd : null;
  // An average is shown only when the server both gives one and says the sample is large enough.
  const enough = raw.enough === true && average !== null;
  const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback);
  return {
    sampleSize,
    averageUsd: enough ? average : null,
    enough,
    maxSessions: positive(raw.maxSessions, PRACTICE_COST_MAX_SESSIONS),
    minSessions: positive(raw.minSessions, PRACTICE_COST_MIN_SESSIONS),
    oldest: text(raw.oldest),
    newest: text(raw.newest),
  };
}

export function normalisePracticeCost(raw: unknown): PracticeCostResponse {
  const brands = isRecord(raw) && isRecord(raw.brands) ? raw.brands : {};
  return { brands: { roboapply: practiceCost(brands.roboapply), goapply: practiceCost(brands.goapply) } };
}

// ── Stripe health (ST-3 "Endpoint health", ST-0 visibility) ─────────────────

export type StripeKeyMode = 'none' | 'test' | 'live';
export type StripeRefusedReason = 'missing' | 'live_key_outside_production';
export type StripeEndpointReason = 'not_found' | 'restricted_key' | 'error';

export interface StripeHealth {
  /** Null: the server did not say (never read as "no key"). */
  keyMode: StripeKeyMode | null;
  /** The key may be used on this deployment. */
  usable: boolean;
  refusedReason: StripeRefusedReason | null;
  /** How many webhook signing secrets are configured (never the secrets). */
  webhookSecrets: number | null;
  /** The rail can take a payment and fulfil it: a usable key and at least one webhook secret. */
  railReady: boolean;
  endpoint: {
    /** False: the endpoint could not be read (see `reason`), so nothing is known about its events. */
    checked: boolean;
    url: string | null;
    /** Event types the webhook endpoint is not subscribed to. Meaningful only when `checked`. */
    missingEvents: string[];
    reason: StripeEndpointReason | null;
  };
  /** Plan keys whose price is pinned by configuration (never a price id). */
  pinnedPlans: string[];
}

/** A value shaped like a key, a signing secret or a price id. The server never sends one; the console never prints one. */
export const SECRET_SHAPED = /(?:^|[^A-Za-z0-9])(?:sk|rk|pk|whsec|price)_[A-Za-z0-9]/;

const safeText = (v: unknown): string | null => {
  const s = text(v);
  return s && !SECRET_SHAPED.test(s) ? s : null;
};
const safeList = (v: unknown): string[] => (Array.isArray(v) ? v.map(safeText).filter((s): s is string => s !== null) : []);

export function normaliseStripeHealth(raw: unknown): StripeHealth {
  const r = isRecord(raw) ? raw : {};
  const e = isRecord(r.endpoint) ? r.endpoint : {};
  const checked = e.checked === true;
  return {
    keyMode: r.keyMode === 'none' || r.keyMode === 'test' || r.keyMode === 'live' ? r.keyMode : null,
    usable: r.usable === true,
    refusedReason: r.refusedReason === 'missing' || r.refusedReason === 'live_key_outside_production' ? r.refusedReason : null,
    webhookSecrets: count(r.webhookSecrets),
    railReady: r.railReady === true,
    endpoint: {
      checked,
      url: safeText(e.url),
      missingEvents: checked ? safeList(e.missingEvents) : [],
      reason: e.reason === 'not_found' || e.reason === 'restricted_key' || e.reason === 'error' ? e.reason : null,
    },
    pinnedPlans: safeList(r.pinnedPlans),
  };
}

/**
 * What is known about the events of the webhook endpoint, in one place for
 * the Stripe panel and the System view:
 *
 *   no_endpoint  no endpoint in Stripe points at this site. The server says so
 *                with `reason: 'not_found'` on a check that WAS made
 *                (`checked: true`, every event listed as missing); it is its
 *                own answer whatever `checked` says, because nothing is
 *                "missing from" an endpoint that does not exist;
 *   unchecked    the endpoint could not be read: nothing is known;
 *   complete     the endpoint sends every event the site acts on;
 *   missing      it does not send the events in `missingEvents`.
 */
export type StripeEndpointState = 'no_endpoint' | 'unchecked' | 'complete' | 'missing';

export function stripeEndpointState(h: Pick<StripeHealth, 'endpoint'>): StripeEndpointState {
  if (h.endpoint.reason === 'not_found') return 'no_endpoint';
  if (!h.endpoint.checked) return 'unchecked';
  return h.endpoint.missingEvents.length === 0 ? 'complete' : 'missing';
}

/**
 * Why the endpoint could not be read, when the readout says: the key may not
 * read endpoints, Stripe did not answer, or (no reason given and no usable
 * key) there is no key to ask with. Null: no reason is known, and none is
 * printed. A usable key is never described as "no key".
 */
export function stripeUncheckedReason(h: Pick<StripeHealth, 'endpoint' | 'usable'>): 'restricted_key' | 'error' | 'no_key' | null {
  if (h.endpoint.reason === 'restricted_key' || h.endpoint.reason === 'error') return h.endpoint.reason;
  return h.usable ? null : 'no_key';
}

// ── Calls ───────────────────────────────────────────────────────────────────

type ReadOptions = Pick<RequestOptions, 'signal'>;

function query(params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v) qs.set(k, v);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const adminBillingApi = {
  /** Refund a charge through Stripe. Access changes later, when the payment provider's event arrives. */
  issueRefund: async (body: AdminRefundBody): Promise<AdminRefundResult> =>
    normaliseAdminRefund(await roboApi.post<unknown>(`${BASE}/refunds`, adminRefundRequestBody(body))),
  /** One page of a user's refunds, withdrawals, disputes and manual mainland records, newest first. */
  listRefunds: async (userId: string, cursor?: string | null, opts?: ReadOptions): Promise<AdminRefundsPage> =>
    normaliseAdminRefunds(await roboApi.get<unknown>(`${BASE}/refunds${query({ userId: userId.trim(), cursor })}`, opts)),
  /** A user's completed mainland orders, each with its refund marker. */
  listCnOrders: async (userId: string, opts?: ReadOptions): Promise<{ items: CnOrderRow[] }> =>
    normaliseCnOrders(await roboApi.get<unknown>(`${BASE}/cn-orders${query({ userId: userId.trim() })}`, opts)),
  /** Record that an order's money was returned by hand; the server reverses the access once. */
  recordCnRefund: async (orderId: string, body: CnRefundBody): Promise<CnRefundResult> =>
    normaliseCnRefund(await roboApi.post<unknown>(`${BASE}/cn-orders/${encodeURIComponent(orderId)}/refund`, cnRefundRequestBody(body))),
  practiceCost: async (opts?: ReadOptions): Promise<PracticeCostResponse> => normalisePracticeCost(await roboApi.get<unknown>(`${BASE}/practice-cost`, opts)),
  stripeHealth: async (opts?: ReadOptions): Promise<StripeHealth> => normaliseStripeHealth(await roboApi.get<unknown>(`${BASE}/stripe-health`, opts)),
};

// ── Amounts typed by staff ──────────────────────────────────────────────────

/**
 * A money amount typed as "10", "10.5" or "10.50" → whole minor units (1000,
 * 1050, 1050). Money is never a float here: the digits are read as text.
 * Empty, zero, negative, more than two decimals or anything else → null.
 */
export function parseAmountMinor(input: string | null | undefined): number | null {
  const v = (input ?? '').trim();
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
