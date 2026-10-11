// lib/api/account.ts
//
// Typed client for the RoboApply User Account + Billing surfaces. Wraps
// `roboApi` (lib/api/client.ts) which already unwraps the `{success,data}`
// envelope (returns `data`) and throws `RoboApiError` (.code / .message) on
// failure. The two backend bases:
//
//   /api/v1/roboapply/account   profile · password · sign-out-all · usage · delete · wipe-data
//   /api/v1/roboapply/billing   plan · checkout · checkout/reconcile · portal · cancel · switch · history (paged)
//   /api/v1/roboapply/credits   resume · withdrawal (the calls of that base made here; see below)
//   /api/v1/public/cancel       preview · confirm (the public cancel link, with the withdrawal choice)
//
// Stripe-redirect endpoints (checkout / portal) return `{ url }`; the caller
// is responsible for `window.location.href = url`.

import { roboApi, type RequestOptions } from './client';
import { API_BASE } from '../config';
import type { CheckoutResponse } from './contracts/credits';

// ─────────────────────────────────────────────────────────────────────
// Enums / shared
// ─────────────────────────────────────────────────────────────────────

/** Mock-interview subscription plans. Legacy premium/premium_plus kept so an
 *  existing subscriber's tier still renders. */
export type MockPlanKey = 'free' | 'starter' | 'growth';
export type AccountTier = MockPlanKey | 'premium' | 'premium_plus';

/** Tier ids that can be purchased (free is not a charge). */
export type PurchasableTier = 'starter' | 'growth';

// ─────────────────────────────────────────────────────────────────────
// Account
// ─────────────────────────────────────────────────────────────────────

export interface AccountProfile {
  id: string;
  email: string;
  name: string | null;
  provider: string;
  hasPassword: boolean;
  memberSince: string; // ISO
  readinessScore: number;
  tier: AccountTier;
  subscriptionStatus: string;
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
}

export interface UpdateNameResponse {
  name: string;
}

export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

export interface SignOutAllResponse {
  revoked: number;
}

export interface DeleteAccountResponse {
  ok: true;
  deactivated: true;
}

/** Per-table removal counts from a data-only wipe (POST /account/wipe-data).
 *  Clears application data (match history / queue / activity / pipeline);
 *  account, profile, and résumés survive. */
export interface WipeDataResponse {
  trackerEntries: number;
  matchScores: number;
  runs: number;
  digests: number;
  /** Jobright-clone application-data rows removed, per table (WP-10). */
  clone: Record<string, number>;
  /** Stored application files that could not be confirmed deleted (rows kept; retried later). */
  applicationFilesKept: number;
}

// ─────────────────────────────────────────────────────────────────────
// Usage (value framing — counts only, never cost)
// ─────────────────────────────────────────────────────────────────────

export interface AccountUsageFeature {
  key: string;
  label: string;
  count: number;
}

export interface AccountUsageDay {
  day: string; // ISO date (YYYY-MM-DD)
  count: number;
}

export interface AccountUsageResponse {
  range: { from: string; to: string; tz: string };
  tier: AccountTier;
  dailyCap: number;
  byFeature: AccountUsageFeature[];
  byDay: AccountUsageDay[];
  totalActions: number;
}

export interface AccountUsageParams {
  from?: string;
  to?: string;
  tz?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Billing
// ─────────────────────────────────────────────────────────────────────

export interface BillingRegion {
  market: 'cn' | 'other';
  currency: 'CNY' | 'USD';
  method: 'alipay' | 'stripe';
  source: string;
}

export interface BillingCurrent {
  tier: AccountTier;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  currentPeriodEnd: string | null; // ISO
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
  /** CN/Alipay one-time monthly pass → no auto-renew (manual re-purchase). */
  manualRenewal: boolean;
}

export interface BillingCredits {
  balance: number;
  periodAllotment: number | null;
  tier: string;
}

export interface BillingPlanItem {
  key: MockPlanKey;
  credits: number;
  usdMinor: number;
  cnyMinor: number;
  current: boolean;
  purchasable: boolean;
}

export interface BillingPlanResponse {
  region: BillingRegion;
  current: BillingCurrent;
  credits: BillingCredits;
  plans: BillingPlanItem[];
  stripeConfigured: boolean;
  alipayConfigured: boolean;
}

export interface CreditsResponse {
  balance: number;
  periodAllotment: number | null;
  tier: string;
  currentPeriodEnd: string | null;
  /** Minutes covered by one mock-interview credit. Optional for compatibility
   *  with an older backend during a rolling deployment. */
  creditMinutes?: number;
}

/** How a charge was paid, as the history page labels it. */
export type InvoiceChannel = 'card' | 'alipay' | 'wechatpay';
/** How much of a charge went back. */
export type InvoiceRefunded = 'full' | 'partial';

/**
 * One row of `GET /billing/history` (ST-10). `channel` and `refunded` are
 * OPTIONAL on the wire and omitted when they add nothing, so every row that
 * existed before keeps its exact shape: `channel` is sent only when `kind`
 * does not imply it (a WeChat Pay order; `kind: 'stripe'` implies a card,
 * `kind: 'alipay'` implies Alipay) and `refunded` only on a refunded row.
 * Read them through `invoiceChannel` and `invoiceRefunded`.
 */
export interface BillingInvoice {
  id: string;
  kind: 'stripe' | 'alipay';
  date: string; // ISO
  amountMinor: number;
  currency: string;
  status: string;
  description: string;
  downloadable: boolean;
  channel?: InvoiceChannel;
  refunded?: InvoiceRefunded;
}

/** One page of the history. `nextCursor` null: there is no further page. */
export interface BillingHistoryResponse {
  invoices: BillingInvoice[];
  nextCursor: string | null;
}

/** Rows asked for per page (the server's default; sent so the page size is stated, not assumed). */
export const BILLING_HISTORY_PAGE_SIZE = 20;

const INVOICE_CHANNELS: readonly InvoiceChannel[] = ['card', 'alipay', 'wechatpay'];

/** The row's payment channel: the one the server names, else the one its `kind` implies. */
export function invoiceChannel(inv: Pick<BillingInvoice, 'kind' | 'channel'>): InvoiceChannel {
  if (inv.channel && INVOICE_CHANNELS.includes(inv.channel)) return inv.channel;
  return inv.kind === 'alipay' ? 'alipay' : 'card';
}

/** `'full'` / `'partial'` for a refunded row, null for one that is not (the key is absent then). */
export function invoiceRefunded(inv: Pick<BillingInvoice, 'refunded'>): InvoiceRefunded | null {
  return inv.refunded === 'full' || inv.refunded === 'partial' ? inv.refunded : null;
}

export interface StripeRedirect {
  url: string;
}

export interface CancelPlanResponse {
  ok: true;
}

// ─────────────────────────────────────────────────────────────────────
// Clone plans (WP-21b UI over WP-21a's server; PRODUCT_PLAN.md §6.3)
//
// The `/billing` checkout endpoints take a `planKey` body (WP-21a; the old
// `{ tier }` body now answers 409) and answer the contract's `CheckoutResponse`
// (server/src/features/credits/contract.ts): one type for both sides.
// Switching is one server endpoint, adapted below.
// ─────────────────────────────────────────────────────────────────────

/**
 * POST /billing/checkout (the brand's default rail: Stripe on RoboApply) and
 * /billing/alipay (GoApply's Alipay rail) with a clone plan key. Which rails
 * can take a payment now is `checkout.rails` of GET /billing/plans.
 */
export interface PlanCheckoutBody {
  /** A `PLAN_KEYS` value from GET /billing/plans. */
  planKey: string;
  /** The unticked-by-default "renews automatically" box (consent `auto_renew_ack`); required for auto-renewing plans. */
  autoRenewAck?: boolean;
  /** EU/UK/TW "Start now" withdrawal waiver (consent `withdrawal_waiver`); optional. */
  withdrawalWaiver?: boolean;
  /** Same-origin path after a successful payment. */
  next?: string;
  /** Same-origin path when the buyer leaves the payment page. */
  cancelNext?: string;
}

/**
 * One checkout attempt (MARKET_STRATEGY §5.1 "Idempotency keys"). The plan
 * sheet makes one key per attempt and sends it as the `Idempotency-Key`
 * request header; the server turns it into the payment provider's own
 * idempotency key, so a double click opens one payment page and a second,
 * intended purchase (a new attempt, a new key) opens a new one. Without the
 * header the server falls back to a 60-second bucket. The Alipay route takes
 * the header too and ignores it today.
 */
export interface CheckoutCallOptions {
  attemptKey?: string | null;
}

/** What the server accepts as an attempt key (a UUID fits). */
export const CHECKOUT_ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const CHECKOUT_ATTEMPT_HEADER = 'Idempotency-Key';

/** Request options carrying the attempt key, or none when the key is missing or not in the accepted form. */
export function checkoutRequestOptions(opts?: CheckoutCallOptions | null): RequestOptions | undefined {
  const key = typeof opts?.attemptKey === 'string' ? opts.attemptKey.trim() : '';
  return CHECKOUT_ATTEMPT_KEY_PATTERN.test(key) ? { headers: { [CHECKOUT_ATTEMPT_HEADER]: key } } : undefined;
}

/**
 * What checkout answers, by `kind`: `redirect` (open `url`: Stripe, the Alipay
 * cashier, WeChat Pay H5), `qr` (`qrCodeUrl` is the content of a payment code,
 * e.g. a `weixin://` link — draw a QR code from it, never load it as an
 * image) or `jsapi` (parameters for the WeChat in-app cashier).
 */
export type PlanCheckoutResponse = CheckoutResponse;

// ─────────────────────────────────────────────────────────────────────
// Facts `GET /billing/plans` adds for the pricing page (market wave, D6).
//
// Written by hand from the cross-bundle contract (MARKET_TASK_PLAN.md §3.1;
// the server half is built in parallel): the fields are OPTIONAL here, read
// through `plansBillingFacts`, and anything absent or malformed is "not
// stated", so the page prints nothing instead of a made-up number or name
// (D3). No number of the refund rules is written in the web bundle.
//
//   refundPolicy: { firstPurchaseDays, shortPlanHours, paidOnlyCreditLimit,
//                   accidentalRenewalDays, withdrawalDays, packValidMonths,
//                   version }
//   checkout.collectingEntity: string | null   (GoApply only)
//   studentOffer: Array<{ key, amountMinor, studentDiscountPercent }> | null
//     (requested: the student prices for a visitor who is not sent the
//      student plans; absent until the server sends it)
// ─────────────────────────────────────────────────────────────────────

/** The numbers of the published refund rules (server `platform/billing/refunds.ts`). */
export interface RefundPolicyFacts {
  /** First purchase: refund within this many days… */
  firstPurchaseDays: number;
  /** …or this many hours for the weekly plan and the 7-day pass… */
  shortPlanHours: number;
  /** …if fewer than this many paid-only actions were used. */
  paidOnlyCreditLimit: number;
  /** A renewal charged by mistake: within this many days. */
  accidentalRenewalDays: number;
  /** Statutory withdrawal window (EU / EEA / UK / Taiwan), days. */
  withdrawalDays: number;
  /** A practice pack stays valid this many months. */
  packValidMonths: number;
  /** The policy version the server applies ('' when not stated). */
  version: string;
}

/** One student price published to a visitor (the plan itself is listed only for a verified student). */
export interface StudentOfferRow {
  key: string;
  amountMinor: number;
  studentDiscountPercent: number | null;
}

export interface PlansBillingFacts {
  /** Null → the refund lines are not printed. */
  refundPolicy: RefundPolicyFacts | null;
  /** The legal entity that collects the payment; null → the line is not printed. */
  collectingEntity: string | null;
  /** Empty → no student price is published on this response. */
  studentOffer: StudentOfferRow[];
}

const REFUND_POLICY_NUMBERS = ['firstPurchaseDays', 'shortPlanHours', 'paidOnlyCreditLimit', 'accidentalRenewalDays', 'withdrawalDays', 'packValidMonths'] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** The additive facts of a plans response, normalised. Works before and after the server sends them. */
export function plansBillingFacts(view: unknown): PlansBillingFacts {
  const root = isRecord(view) ? view : {};
  const rawPolicy = root.refundPolicy;
  const refundPolicy: RefundPolicyFacts | null =
    isRecord(rawPolicy) && REFUND_POLICY_NUMBERS.every((k) => isCount(rawPolicy[k]))
      ? {
          firstPurchaseDays: rawPolicy.firstPurchaseDays as number,
          shortPlanHours: rawPolicy.shortPlanHours as number,
          paidOnlyCreditLimit: rawPolicy.paidOnlyCreditLimit as number,
          accidentalRenewalDays: rawPolicy.accidentalRenewalDays as number,
          withdrawalDays: rawPolicy.withdrawalDays as number,
          packValidMonths: rawPolicy.packValidMonths as number,
          version: typeof rawPolicy.version === 'string' ? rawPolicy.version : '',
        }
      : null;
  const checkout = isRecord(root.checkout) ? root.checkout : {};
  const entity = typeof checkout.collectingEntity === 'string' ? checkout.collectingEntity.trim() : '';
  const studentOffer: StudentOfferRow[] = [];
  if (Array.isArray(root.studentOffer)) {
    for (const row of root.studentOffer) {
      if (!isRecord(row) || typeof row.key !== 'string' || !row.key || !isCount(row.amountMinor)) continue;
      const pct = row.studentDiscountPercent;
      studentOffer.push({ key: row.key, amountMinor: row.amountMinor, studentDiscountPercent: isCount(pct) && pct < 100 ? pct : null });
    }
  }
  return { refundPolicy, collectingEntity: entity || null, studentOffer };
}

/** POST /billing/switch/quote — what a legacy practice-plan subscriber pays to switch to Pro. Nothing is charged. */
export interface SwitchQuote {
  quoteId: string;
  planKey: string;
  currency: string;
  /** Prorated amount charged today if the user confirms. */
  amountDueTodayMinor: number;
  /** The new plan's renewal price. */
  renewalAmountMinor: number;
  /** ISO date of the next renewal at the new price. */
  nextRenewalAt: string;
}

export interface SwitchQuoteBody {
  planKey: string;
}

/** POST /billing/switch/confirm — charges only now. */
export interface SwitchConfirmBody {
  quoteId: string;
  autoRenewAck: boolean;
  withdrawalWaiver?: boolean;
}

/**
 * What a confirmed switch answers. Either the plan changed, or the bank asks
 * the buyer to confirm the payment first and the plan has NOT changed
 * (`requires_action`; MARKET_STRATEGY §5.1 "Switch"). `hostedInvoiceUrl` is
 * the payment provider's page for that confirmation, or null when the server
 * has none (the buyer then goes through Manage payment).
 */
export type SwitchConfirmResponse =
  | { status: 'switched'; planKey: string; nextRenewalAt: string | null }
  | { status: 'requires_action'; planKey: string; hostedInvoiceUrl: string | null };

// ─────────────────────────────────────────────────────────────────────
// Subscription lifecycle (market wave M2: ST-3, ST-5, ST-6, ST-7 web halves).
//
// The server routes are built in parallel, so every type below is written by
// hand from the cross-bundle contract (MARKET_TASK_PLAN.md §3.1) and every
// answer is read through a normaliser with a safe default: this file works
// before and after the server half merges. Error codes are read by the
// callers with `apiErrorCode` (lib/api/contracts/wire.ts).
//
//   POST /billing/checkout/reconcile { sessionId }
//     -> { status: 'fulfilled' | 'already_fulfilled' | 'pending',
//          mode: 'payment' | 'subscription', planKey: string | null }
//     errors 403 forbidden · 404 not_found · 422 invalid_request ·
//            429 rate_limited · 503 stripe_not_configured · 502 payment_provider_error
//   POST /billing/portal { flow?: 'payment_method_update' } -> { url }
//     errors 409 no_customer · 503 stripe_not_configured · 502 payment_provider_error
//   POST /billing/switch { planKey, confirm: true, prorationDate, autoRenewAck, withdrawalWaiver? }
//     -> { switched: true, planKey }
//      | { switched: false, requiresAction: true, hostedInvoiceUrl: string | null, planKey }
//   POST /credits/resume { autoRenewAck: true }
//     -> { status: 'resumed', planKey: string, renewsAt: string | null }
//     errors 409 nothing_to_resume · 422 auto_renew_ack_required ·
//            503 rail_not_configured · 502 payment_provider_error
// ─────────────────────────────────────────────────────────────────────

/** A Stripe Checkout Session id as the success URL carries it (`?session_id=`). */
export const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{8,200}$/;

/** `value` when it is a Checkout Session id, else null (the return page reads the query through this). */
export function checkoutSessionId(value: unknown): string | null {
  return typeof value === 'string' && CHECKOUT_SESSION_ID_PATTERN.test(value) ? value : null;
}

/**
 * The answer of the return-page reconcile. `pending`: the payment is not
 * settled yet, ask again later. `fulfilled` / `already_fulfilled`: the server
 * has run the purchase's fulfilment (now, or earlier through the webhook). It
 * is never shown as "done" by itself: the page still waits for the credit
 * summary to say so.
 */
export interface ReconcileCheckoutResponse {
  status: 'fulfilled' | 'already_fulfilled' | 'pending';
  mode: 'payment' | 'subscription' | null;
  planKey: string | null;
}

/** An answer in any other shape reads as `pending` (nothing is claimed from it). */
export function normaliseReconcile(raw: unknown): ReconcileCheckoutResponse {
  const r = isRecord(raw) ? raw : {};
  const status = r.status === 'fulfilled' || r.status === 'already_fulfilled' ? r.status : 'pending';
  const mode = r.mode === 'payment' || r.mode === 'subscription' ? r.mode : null;
  return { status, mode, planKey: typeof r.planKey === 'string' && r.planKey ? r.planKey : null };
}

/** `POST /billing/portal` body. Without `flow` the portal opens on its home page. */
export interface PortalBody {
  /** Open straight on "update payment method" (the failed-payment banner). */
  flow?: 'payment_method_update';
}

/** `POST /credits/resume` answer: renewal is back on. */
export interface ResumeSubscriptionResponse {
  status: 'resumed';
  planKey: string | null;
  /** ISO time of the next renewal, when the server states it. */
  renewsAt: string | null;
}

export function normaliseResume(raw: unknown): ResumeSubscriptionResponse {
  const r = isRecord(raw) ? raw : {};
  return {
    status: 'resumed',
    planKey: typeof r.planKey === 'string' && r.planKey ? r.planKey : null,
    renewsAt: typeof r.renewsAt === 'string' && r.renewsAt ? r.renewsAt : null,
  };
}

/** A page address the browser may open (http or https), or null. */
function pageUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

/**
 * The server's switch answer in the UI's shape. `{ switched: true }` is a
 * changed plan; `{ requiresAction: true }` is "confirm with your bank, nothing
 * changed yet". Anything else is not an answer this client may call a switch,
 * so it throws and the sheet shows its "did not go through" line.
 */
export function fromServerSwitch(raw: unknown, askedPlanKey: string): SwitchConfirmResponse {
  const r = isRecord(raw) ? raw : {};
  const planKey = typeof r.planKey === 'string' && r.planKey ? r.planKey : askedPlanKey;
  if (r.switched === true) return { status: 'switched', planKey, nextRenewalAt: null };
  if (r.requiresAction === true) return { status: 'requires_action', planKey, hostedInvoiceUrl: pageUrl(r.hostedInvoiceUrl) };
  throw new Error('Unexpected switch answer');
}

// ─────────────────────────────────────────────────────────────────────
// Billing phase B consumers (market wave M4: ST-9 and ST-10 web halves).
//
// As above: the server routes are built in parallel (MKT-4A, MKT-4B), so the
// types are written by hand from the contract (MARKET_TASK_PLAN.md §3.1) and
// every answer goes through a normaliser. Anything absent or malformed reads
// as "nothing to offer", never as an amount or a date the server did not
// state (D3).
//
//   GET  /billing/history?cursor=&limit=
//     -> { invoices: BillingInvoice[], nextCursor: string | null }
//   GET  /credits/withdrawal
//     -> { available, purchase: {…} | null, quote: {…} | null,
//          purchases?: Array<{ purchase, quote }> }   (every open purchase, the latest first)
//   POST /credits/withdrawal { purchaseId, confirm: true }
//     -> { status: 'withdrawn', refundMinor, currency, accessEnded: true }
//     errors 409 withdrawal_not_available · 429 rate_limited ·
//            503 rail_not_configured · 502 payment_provider_error
//   POST /api/v1/public/cancel/preview { token }
//     -> { planKey, accessUntil, withdrawal: { refundMinor, currency, rule, deadline } | null }
//     errors 410 cancel_token_invalid
//   POST /api/v1/public/cancel/confirm { token, withdraw?: true }
//     -> CancelResponse & { withdrawal?: { status: 'withdrawn' | 'not_available', refundMinor, currency } }
// ─────────────────────────────────────────────────────────────────────

const isMinor = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isCurrency = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim());
const isoTime = (v: unknown): string | null => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function historyQuery(cursor?: string | null): string {
  const qs = new URLSearchParams();
  if (typeof cursor === 'string' && cursor) qs.set('cursor', cursor);
  qs.set('limit', String(BILLING_HISTORY_PAGE_SIZE));
  return `?${qs.toString()}`;
}

/** One history page as the page reads it. Rows without an id are dropped; a missing `nextCursor` is the end. */
export function normaliseHistory(raw: unknown): BillingHistoryResponse {
  const r = isRecord(raw) ? raw : {};
  const invoices: BillingInvoice[] = [];
  for (const row of Array.isArray(r.invoices) ? r.invoices : []) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id) continue;
    const inv: BillingInvoice = {
      id: row.id,
      kind: row.kind === 'alipay' ? 'alipay' : 'stripe',
      date: typeof row.date === 'string' ? row.date : '',
      amountMinor: typeof row.amountMinor === 'number' && Number.isFinite(row.amountMinor) ? row.amountMinor : 0,
      currency: typeof row.currency === 'string' ? row.currency : '',
      status: typeof row.status === 'string' ? row.status : '',
      description: typeof row.description === 'string' ? row.description : '',
      downloadable: row.downloadable === true,
    };
    if (INVOICE_CHANNELS.includes(row.channel as InvoiceChannel)) inv.channel = row.channel as InvoiceChannel;
    if (row.refunded === 'full' || row.refunded === 'partial') inv.refunded = row.refunded;
    invoices.push(inv);
  }
  return { invoices, nextCursor: text(r.nextCursor) };
}

/** The two statutory withdrawal rules: the whole price, or the unused days when the buyer asked us to start at once. */
export type WithdrawalRule = 'withdrawal_14d' | 'withdrawal_14d_prorata';

/** The purchase a withdrawal is about. `id` goes back as `purchaseId`. */
export interface WithdrawalPurchase {
  source: 'stripe';
  id: string;
  planKey: string | null;
  /** When it was paid (ISO); the 14 days run from it. Null when the server did not say. */
  chargedAt: string | null;
  /** Everything paid under the purchase so far (its own charge and any renewal paid since). */
  amountMinor: number;
  currency: string;
}

/** What withdrawing from that purchase returns, and until when. */
export interface WithdrawalQuote {
  rule: WithdrawalRule;
  refundMinor: number;
  currency: string;
  /** Last moment the withdrawal is open (ISO). */
  deadline: string;
  /** Rule `withdrawal_14d_prorata` only: whole days counted as used, and the days of the period. */
  prorata: { usedDays: number; periodDays: number } | null;
  region: 'eu' | 'uk' | 'tw' | null;
}

export interface WithdrawalOption {
  purchase: WithdrawalPurchase;
  quote: WithdrawalQuote;
}

/** `GET /credits/withdrawal` as the page reads it: every purchase that can still be withdrawn, the latest first. */
export interface WithdrawalOverview {
  available: boolean;
  options: WithdrawalOption[];
}

function withdrawalRule(v: unknown): WithdrawalRule | null {
  return v === 'withdrawal_14d' || v === 'withdrawal_14d_prorata' ? v : null;
}

function withdrawalOption(rawPurchase: unknown, rawQuote: unknown): WithdrawalOption | null {
  if (!isRecord(rawPurchase) || !isRecord(rawQuote)) return null;
  const id = text(rawPurchase.id);
  const rule = withdrawalRule(rawQuote.rule);
  const deadline = isoTime(rawQuote.deadline);
  if (!id || !rule || !deadline) return null;
  if (!isMinor(rawPurchase.amountMinor) || !isCurrency(rawPurchase.currency)) return null;
  if (!isMinor(rawQuote.refundMinor) || !isCurrency(rawQuote.currency)) return null;
  const p = rawQuote.prorata;
  const prorata =
    isRecord(p) && isMinor(p.usedDays) && isMinor(p.periodDays) && p.periodDays > 0 && p.usedDays <= p.periodDays
      ? { usedDays: p.usedDays, periodDays: p.periodDays }
      : null;
  return {
    purchase: {
      source: 'stripe',
      id,
      planKey: text(rawPurchase.planKey),
      chargedAt: isoTime(rawPurchase.chargedAt),
      amountMinor: rawPurchase.amountMinor,
      currency: rawPurchase.currency.trim().toUpperCase(),
    },
    quote: {
      rule,
      refundMinor: rawQuote.refundMinor,
      currency: rawQuote.currency.trim().toUpperCase(),
      deadline,
      prorata,
      region: rawQuote.region === 'eu' || rawQuote.region === 'uk' || rawQuote.region === 'tw' ? rawQuote.region : null,
    },
  };
}

/**
 * The withdrawal answer, normalised. The contract's `purchase` / `quote` pair
 * is the latest open purchase; when the server lists every open purchase
 * (`purchases`, each `{ purchase, quote }`) all of them are read, in the
 * server's order, each once. `available: false`, an older server, or a pair
 * that does not state its amount and deadline → nothing is offered.
 */
export function normaliseWithdrawal(raw: unknown): WithdrawalOverview {
  const r = isRecord(raw) ? raw : {};
  if (r.available !== true) return { available: false, options: [] };
  const options: WithdrawalOption[] = [];
  const add = (option: WithdrawalOption | null) => {
    if (option && !options.some((o) => o.purchase.id === option.purchase.id)) options.push(option);
  };
  if (Array.isArray(r.purchases)) {
    for (const entry of r.purchases) if (isRecord(entry)) add(withdrawalOption(entry.purchase, entry.quote));
  }
  if (options.length === 0) add(withdrawalOption(r.purchase, r.quote));
  return { available: options.length > 0, options };
}

/** `POST /credits/withdrawal` answered: the purchase is withdrawn. */
export interface WithdrawResponse {
  status: 'withdrawn';
  /** What goes back, when the server states it. */
  refundMinor: number | null;
  currency: string | null;
}

/** An answer that does not say `withdrawn` is not one this client may call a withdrawal: it throws. */
export function normaliseWithdraw(raw: unknown): WithdrawResponse {
  const r = isRecord(raw) ? raw : {};
  if (r.status !== 'withdrawn') throw new Error('Unexpected withdrawal answer');
  const stated = isMinor(r.refundMinor) && isCurrency(r.currency);
  return { status: 'withdrawn', refundMinor: stated ? (r.refundMinor as number) : null, currency: stated ? (r.currency as string).trim().toUpperCase() : null };
}

/** What a public cancel link can do, read WITHOUT using the link up. */
export interface PublicCancelPreview {
  planKey: string | null;
  /** End of the paid period (ISO): access stays until then after an ordinary cancel. */
  accessUntil: string | null;
  /** Null: the link can only cancel at the end of the period. */
  withdrawal: { refundMinor: number; currency: string; rule: WithdrawalRule; deadline: string } | null;
}

export function normalisePublicCancelPreview(raw: unknown): PublicCancelPreview {
  const r = isRecord(raw) ? raw : {};
  const w = isRecord(r.withdrawal) ? r.withdrawal : null;
  const rule = w ? withdrawalRule(w.rule) : null;
  const deadline = w ? isoTime(w.deadline) : null;
  const withdrawal =
    w && rule && deadline && isMinor(w.refundMinor) && isCurrency(w.currency)
      ? { refundMinor: w.refundMinor, currency: w.currency.trim().toUpperCase(), rule, deadline }
      : null;
  return { planKey: text(r.planKey), accessUntil: isoTime(r.accessUntil), withdrawal };
}

export interface PublicCancelConfirmBody {
  token: string;
  /** Withdraw from the contract (refund now, the plan ends at once) instead of cancelling at the end of the period. */
  withdraw?: boolean;
}

/** The answer of the public cancel link. `withdrawal` is set only when a withdrawal was asked for. */
export interface PublicCancelResult {
  status: 'cancelled' | 'already_cancelled';
  accessUntil: string | null;
  withdrawal: { status: 'withdrawn' | 'not_available'; refundMinor: number | null; currency: string | null } | null;
}

export function normalisePublicCancelResult(raw: unknown): PublicCancelResult {
  const r = isRecord(raw) ? raw : {};
  const w = isRecord(r.withdrawal) ? r.withdrawal : null;
  const stated = !!w && isMinor(w.refundMinor) && isCurrency(w.currency);
  return {
    status: r.status === 'already_cancelled' ? 'already_cancelled' : 'cancelled',
    accessUntil: isoTime(r.accessUntil),
    withdrawal: w
      ? {
          // Only the server's own word makes it a withdrawal; anything else reads as "not available".
          status: w.status === 'withdrawn' ? 'withdrawn' : 'not_available',
          refundMinor: stated ? (w.refundMinor as number) : null,
          currency: stated ? (w.currency as string).trim().toUpperCase() : null,
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────

// WP-21a serves one endpoint for both steps, `POST /billing/switch`: without
// `confirm` it answers `{ quote }`; with `{ confirm: true, prorationDate }` it
// charges. The UI's opaque `quoteId` carries the plan key and the proration
// timestamp the server needs back (Wave 2 gate seam fix).
interface ServerSwitchQuote {
  planKey: string;
  currency: string;
  amountDueTodayMinor: number;
  newRenewalPriceMinor: number;
  nextRenewalDate: string;
  prorationDate: number;
}

export function fromServerQuote(q: ServerSwitchQuote): SwitchQuote {
  return {
    quoteId: `${q.planKey}:${q.prorationDate}`,
    planKey: q.planKey,
    currency: q.currency,
    amountDueTodayMinor: q.amountDueTodayMinor,
    renewalAmountMinor: q.newRenewalPriceMinor,
    nextRenewalAt: q.nextRenewalDate,
  };
}

export function parseQuoteId(quoteId: string): { planKey: string; prorationDate: number } {
  const at = quoteId.lastIndexOf(':');
  const planKey = at > 0 ? quoteId.slice(0, at) : '';
  const prorationDate = Number(at > 0 ? quoteId.slice(at + 1) : NaN);
  if (!planKey || !Number.isInteger(prorationDate) || prorationDate <= 0) throw new Error('Invalid switch quote id');
  return { planKey, prorationDate };
}

const ACCOUNT_BASE = '/api/v1/roboapply/account';
const BILLING_BASE = '/api/v1/roboapply/billing';
// The credits area's own wrappers live in lib/api/credits.ts (one per
// documented route). `resume` is added here, hand-typed, because its route is
// built in the same phase by another work package.
const CREDITS_BASE = '/api/v1/roboapply/credits';
// The public cancel link (no session). The documented wrappers of
// lib/api/credits.ts stay as they are; the preview and the withdrawal choice
// are hand-typed here for the same reason as `resume`.
const PUBLIC_CANCEL_BASE = '/api/v1/public/cancel';

function usageQuery(params?: AccountUsageParams): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.tz) qs.set('tz', params.tz);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const accountApi = {
  // account
  profile: () => roboApi.get<AccountProfile>(ACCOUNT_BASE),
  updateName: (name: string) =>
    roboApi.patch<UpdateNameResponse>(ACCOUNT_BASE, { name }),
  changePassword: (body: ChangePasswordBody) =>
    roboApi.post<{ ok: true }>(`${ACCOUNT_BASE}/password`, body),
  signOutAll: () =>
    roboApi.post<SignOutAllResponse>(`${ACCOUNT_BASE}/signout-all`),
  usage: (params?: AccountUsageParams) =>
    roboApi.get<AccountUsageResponse>(`${ACCOUNT_BASE}/usage${usageQuery(params)}`),
  deleteAccount: (confirmEmail: string) =>
    roboApi.post<DeleteAccountResponse>(`${ACCOUNT_BASE}/delete`, { confirmEmail }),
  /** Clear application data only (match history / queue / activity / pipeline).
   *  Account + résumés survive; the caller stays signed in. */
  wipeData: () =>
    roboApi.post<WipeDataResponse>(`${ACCOUNT_BASE}/wipe-data`, { confirm: true }),

  // billing
  plan: (region?: 'cn' | 'other') =>
    roboApi.get<BillingPlanResponse>(`${BILLING_BASE}/plan${region ? `?region=${region}` : ''}`),
  credits: () => roboApi.get<CreditsResponse>(`${BILLING_BASE}/credits`),
  checkout: (tier: PurchasableTier, next?: string, cancelNext?: string) =>
    roboApi.post<StripeRedirect>(`${BILLING_BASE}/checkout`, { tier, next, cancelNext }),
  alipayCheckout: (tier: PurchasableTier, next?: string) =>
    roboApi.post<StripeRedirect>(`${BILLING_BASE}/alipay`, { tier, next }),
  /**
   * The payment portal (payment method, invoices, billing details, cancel;
   * plan changes are made in the app). `{ flow: 'payment_method_update' }`
   * opens it on the payment-method step; with no flow nothing is sent.
   */
  portal: (body?: PortalBody) =>
    body?.flow === 'payment_method_update'
      ? roboApi.post<StripeRedirect>(`${BILLING_BASE}/portal`, { flow: body.flow })
      : roboApi.post<StripeRedirect>(`${BILLING_BASE}/portal`),
  cancel: () => roboApi.post<CancelPlanResponse>(`${BILLING_BASE}/cancel`),
  /**
   * One page of invoices and receipts, newest first (ST-10). No cursor = the
   * first page. An older server ignores the query, sends every row it has
   * and no `nextCursor`, which reads as "no further page".
   */
  history: async (cursor?: string | null): Promise<BillingHistoryResponse> =>
    normaliseHistory(await roboApi.get<unknown>(`${BILLING_BASE}/history${historyQuery(cursor)}`)),
  /** Clone plan checkout (Stripe, RoboApply). */
  checkoutPlan: (body: PlanCheckoutBody, opts?: CheckoutCallOptions) =>
    roboApi.post<PlanCheckoutResponse>(`${BILLING_BASE}/checkout`, body, checkoutRequestOptions(opts)),
  /**
   * Clone plan checkout through Alipay (GoApply). The rail is open whenever
   * `GET /billing/plans` lists `alipay` in `checkout.rails`; there is no
   * payments switch to turn on. Answers `rail_not_configured` (503) when the
   * rail cannot charge and `plan_not_sellable` (409) under the kill switch.
   */
  alipayCheckoutPlan: (body: PlanCheckoutBody, opts?: CheckoutCallOptions) =>
    roboApi.post<PlanCheckoutResponse>(`${BILLING_BASE}/alipay`, body, checkoutRequestOptions(opts)),
  /** A switch quote (legacy practice plan → Pro, or Pro → Pro); nothing is charged (POST /billing/switch without `confirm`). */
  switchQuote: async (body: SwitchQuoteBody): Promise<SwitchQuote> => {
    const { quote } = await roboApi.post<{ quote: ServerSwitchQuote }>(`${BILLING_BASE}/switch`, { planKey: body.planKey });
    return fromServerQuote(quote);
  },
  /**
   * Charges the quoted amount (POST /billing/switch with `confirm`): a legacy
   * practice plan → Pro, or one Pro subscription → another. The answer is
   * `switched`, or `requires_action` when the bank wants the buyer to confirm
   * the payment and the plan has not changed.
   */
  switchConfirm: async (body: SwitchConfirmBody): Promise<SwitchConfirmResponse> => {
    const { planKey, prorationDate } = parseQuoteId(body.quoteId);
    const res = await roboApi.post<unknown>(`${BILLING_BASE}/switch`, {
      planKey,
      confirm: true,
      prorationDate,
      autoRenewAck: body.autoRenewAck,
      ...(body.withdrawalWaiver !== undefined ? { withdrawalWaiver: body.withdrawalWaiver } : {}),
    });
    return fromServerSwitch(res, planKey);
  },
  /**
   * Back from the payment page: ask the server to settle this Checkout
   * Session now instead of waiting for the webhook (a one-time payment has no
   * second event). Card payments only, so only the international brand's
   * return page calls it. Refuses anything that is not a session id without
   * a request.
   */
  reconcileCheckout: async (sessionId: string): Promise<ReconcileCheckoutResponse> => {
    const id = checkoutSessionId(sessionId);
    if (!id) throw new Error('Invalid checkout session id');
    return normaliseReconcile(await roboApi.post<unknown>(`${BILLING_BASE}/checkout/reconcile`, { sessionId: id }));
  },
  /**
   * "Keep my plan": turn renewal back on for a cancelled subscription whose
   * paid period is still running. The acknowledgement is always sent as true:
   * the caller offers this only after the buyer ticked the renewal box.
   */
  resumeSubscription: async (): Promise<ResumeSubscriptionResponse> =>
    normaliseResume(await roboApi.post<unknown>(`${CREDITS_BASE}/resume`, { autoRenewAck: true })),
  /**
   * "Withdraw from contract" (ST-9): which purchases of the last 14 days can
   * still be withdrawn and what each returns. A read: nothing changes.
   */
  withdrawal: async (): Promise<WithdrawalOverview> => normaliseWithdrawal(await roboApi.get<unknown>(`${CREDITS_BASE}/withdrawal`)),
  /**
   * Withdraw from the quoted purchase: the plan ends at once and the quoted
   * amount is refunded. Sent only from the confirmation step.
   */
  withdraw: async (purchaseId: string): Promise<WithdrawResponse> => {
    const id = purchaseId.trim();
    if (!id) throw new Error('Missing purchase id');
    return normaliseWithdraw(await roboApi.post<unknown>(`${CREDITS_BASE}/withdrawal`, { purchaseId: id, confirm: true }));
  },
  /**
   * What the emailed cancel link can do. The link stays usable afterwards.
   * `signal` lets the page give up on a question that hangs (the body is
   * `{ token }` either way).
   */
  previewPublicCancel: async (token: string, opts?: Pick<RequestOptions, 'signal'>): Promise<PublicCancelPreview> =>
    normalisePublicCancelPreview(await roboApi.post<unknown>(`${PUBLIC_CANCEL_BASE}/preview`, { token }, opts?.signal ? { signal: opts.signal } : undefined)),
  /**
   * Use the emailed cancel link: cancel at the end of the period, or with
   * `withdraw` withdraw from the contract. `withdraw` is sent only when it is
   * true, so an ordinary cancel posts exactly `{ token }` as it always did.
   */
  confirmPublicCancel: async (body: PublicCancelConfirmBody): Promise<PublicCancelResult> =>
    normalisePublicCancelResult(
      await roboApi.post<unknown>(`${PUBLIC_CANCEL_BASE}/confirm`, body.withdraw === true ? { token: body.token, withdraw: true } : { token: body.token }),
    ),
  /** Absolute URL the browser opens directly — Stripe 302s to its hosted PDF,
   *  Alipay streams a generated receipt. Carries the session cookie. */
  invoiceDownloadUrl: (id: string) =>
    `${API_BASE}${BILLING_BASE}/invoices/${encodeURIComponent(id)}/download`,
};
