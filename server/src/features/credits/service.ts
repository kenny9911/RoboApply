// server/src/features/credits/service.ts
//
// The credits HTTP area (TASK_PLAN.md WP-21a; ARCHITECTURE.md §3.9, §7):
//   seeker   GET /credits, GET /credits/history, POST /credits/cancel,
//            POST /credits/cancel/survey (stores the optional answer only),
//            POST /credits/resume ("Keep my plan": renewal back on),
//            GET + POST /credits/withdrawal (the statutory withdrawal: quote,
//            then confirm; the rules and the Stripe calls are the refund
//            engine's, platform/billing/stripeRefunds.ts; what this service
//            adds is the instant of a confirmed withdrawal that failed at the
//            payment provider, so that sending it again finishes it as asked)
//   public   GET /billing/plans, POST /api/v1/public/cancel(+/preview, /confirm:
//            the emailed link cancels at period end or, inside the 14 days,
//            withdraws)
//   admin    caps editor (AppConfig credits.catalog.v1), entitlement
//            overrides (each create and delete on /admin/credits/overrides
//            writes one admin audit row), TWD reference rate, TW revenue
//            monitor, refund quote
//
// Every collaborator is injectable so route tests run on the in-memory fake
// Prisma with fake Stripe / email / rate limits — no network, no database.

import { createHash, randomBytes } from 'node:crypto';
import type Stripe from 'stripe';
import type { ExtendedPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../services/LoggerService.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { parseBrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { FLAG_KEYS, isEnabled, requirementsMet } from '../../platform/flags.js';
import { allocatePackRemaining } from '../../lib/mockCreditService.js';
import { HttpError } from '../../platform/http.js';
import {
  ACCIDENTAL_RENEWAL_DAYS,
  BILLING_ERROR_STATUS,
  BillingError,
  CHECKOUT_ACK_PROSE_VERSION,
  FIRST_PURCHASE_DAYS,
  PACK_VALID_MONTHS,
  PAID_ONLY_CREDIT_LIMIT,
  REFUND_POLICY_VERSION,
  SHORT_PLAN_HOURS,
  WITHDRAWAL_DAYS,
  getStripe as platformGetStripe,
  activeOffers,
  appOrigin,
  availableRails,
  billingEventClaimKey,
  buildPlanViews,
  claimBillingEvent,
  collectingEntity,
  computeRefund,
  computeTwRevenue,
  describePlan,
  fxAgeDays,
  getPlan,
  invoiceSubscriptionId,
  isFxFresh,
  isLegacyPlanKey,
  isPackPlan,
  isWithdrawalRule,
  loadBillingAccount,
  paidOnlyCreditsUsed,
  planDefinitionFor,
  publicFxReference,
  purchaseWaived,
  readFxReference,
  recordCheckoutAcknowledgements,
  resumeSubscription,
  saveFxReference,
  showsWithdrawalWaiver,
  stripePeriod,
  studentPlansListedFor,
  twdReferenceWhole,
  withdrawPurchase,
  withdrawalQuotes,
  type BillingAccount,
  type CancelOutcome,
  type FxReference,
  type StripeRefundDeps,
  type WithdrawalQuote,
  type WithdrawalResult,
} from '../../platform/billing/index.js';
import {
  CREDIT_CATALOG_CONFIG_KEY,
  CreditCatalogOverrideSchema,
  DEFAULT_CREDIT_CATALOG,
  WINDOW_BUCKETS,
  catalogFor,
  getCreditCatalog,
  entitlementService,
  invalidateCreditCatalog,
  isEntitlementKey,
  isWindowBucket,
  parseCreditCatalogOverride,
  type EntitlementSummary,
} from '../../platform/credits/index.js';
import {
  PUBLIC_CANCEL_TOKEN_MINUTES,
  type CancelSurveyReason,
  type CancelResponse,
  type CatalogAdminResponse,
  type CreditLedgerView,
  type CreditOverrideAdminView,
  type CreditsResponse,
  type FxReferenceAdminView,
  type PlansResponse,
  type PlansStudentOffer,
  type PublicCancelConfirmResponse,
  type PublicCancelPreviewResponse,
  type RefundQuoteResponse,
  type ResumeResponse,
  type TwRevenueResponse,
  type WithdrawBody,
  type WithdrawResponse,
  type WithdrawalOption,
  type WithdrawalResponse,
} from './contract.js';

export type CreditsDb = Pick<
  ExtendedPrismaClient,
  // `$transaction` and `rABillingRefund`: the refund engine runs on this database (withdrawals).
  | '$transaction'
  | 'rABillingRefund'
  | 'rACreditLedger'
  | 'mockInterviewCreditLedger'
  | 'rACreditGrant'
  | 'rAEntitlementOverride'
  | 'appConfig'
  | 'rAAuthToken'
  | 'user'
  | 'seekerProfile'
  | 'seekerSubscription'
  | 'seekerConsentRecord'
  | 'alipayOrder'
>;

/** One stored cancel-survey answer (model RACancelSurvey, schema request SR-INT-1). */
export interface CancelSurveyAnswer {
  userId: string;
  brand: ProductBrand['id'];
  reason: CancelSurveyReason | null;
  note: string | null;
  /** The subscription the answer is about, when known (reference only). */
  subscriptionId: string | null;
}

/**
 * Where cancel-survey answers go. A narrow view so the area does not depend
 * on the whole database client: `available()` is false while the client has
 * no RACancelSurvey delegate, and `record()` throws
 * `CancelSurveyStoreUnavailableError` when the table itself is missing.
 */
export interface CancelSurveyStore {
  available(): Promise<boolean>;
  record(answer: CancelSurveyAnswer): Promise<void>;
}

export class CancelSurveyStoreUnavailableError extends Error {
  constructor(message = 'SR-INT-1: the cancel-survey table is not in this database yet') {
    super(message);
    this.name = 'CancelSurveyStoreUnavailableError';
  }
}

interface CancelSurveyDelegate {
  create(args: { data: { userId: string; brand: string; reason: string | null; note: string | null; subscriptionId: string | null } }): Promise<unknown>;
}

/** Prisma error codes for "the table (or a column of it) is not in the database". */
const MISSING_TABLE_CODES = new Set(['P2021', 'P2022']);

export function createPrismaCancelSurveyStore(getDb: () => Promise<object>): CancelSurveyStore {
  const delegate = async (): Promise<CancelSurveyDelegate | null> => {
    const view = (await getDb()) as { rACancelSurvey?: CancelSurveyDelegate };
    return view.rACancelSurvey && typeof view.rACancelSurvey.create === 'function' ? view.rACancelSurvey : null;
  };
  return {
    available: async () => (await delegate()) !== null,
    async record(answer) {
      const rows = await delegate();
      if (!rows) throw new CancelSurveyStoreUnavailableError();
      try {
        await rows.create({
          data: { userId: answer.userId, brand: answer.brand, reason: answer.reason, note: answer.note, subscriptionId: answer.subscriptionId },
        });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && MISSING_TABLE_CODES.has(code)) throw new CancelSurveyStoreUnavailableError();
        throw err;
      }
    },
  };
}

/** One admin audit row for an entitlement override written through /admin/credits/overrides. */
export interface OverrideAuditEntry {
  action: 'created' | 'deleted';
  adminId: string | null;
  subjectUserId: string;
  overrideId: string;
  key: string;
  value: unknown;
  expiresAt?: string | null;
  reason?: string;
}

export interface CreditsAreaDeps {
  db: () => Promise<CreditsDb>;
  env: () => EnvSource;
  now: () => Date;
  summarize: (userId: string, brand: ProductBrand) => Promise<EntitlementSummary>;
  practiceBalance: (userId: string) => Promise<{ credits: number; periodAllotment: number | null; creditMinutes: number } | null>;
  /** One-click cancel (also sends the confirmation email). Throws a billing error code `no_subscription` when nothing renews. */
  cancel: (
    userId: string,
    input: { reason?: string; note?: string; source: 'in_app' | 'public_link' },
  ) => Promise<CancelOutcome & { account: BillingAccount }>;
  /** "Switch to the 7-day pass instead?" is shown once per user, ever. */
  alternative: { wasOffered: (userId: string) => Promise<boolean>; markOffered: (userId: string) => Promise<void> };
  sendEmail: (input: { template: string; to: string; userId: string | null; locale: string | null; brand: ProductBrand['id']; params: Record<string, unknown> }) => Promise<unknown>;
  /** Counts one hit; false when over the limit. */
  rateLimit: (key: string, windows: ReadonlyArray<{ limit: number; windowSec: number }>) => Promise<boolean>;
  getStripe: () => Stripe | null;
  invalidateEntitlements: (userId: string) => void;
  /** Practice balance unspent pack allocation (lib/mockCreditService). */
  allocatePacks: (packs: Array<{ id: string; remaining: number; expiresAt: Date | null }>, balance: number) => Map<string, number>;
  /** Cancel-survey answers (RACancelSurvey). */
  surveys: CancelSurveyStore;
  /** Writes the admin audit row for an override change (features/admin `writeAdminAudit`). */
  auditOverride: (entry: OverrideAuditEntry) => Promise<unknown>;
  /** A live school-email verification (features/account-v2 `studentService.isVerified`). */
  isStudentVerified: (userId: string) => Promise<boolean>;
}

const defaultDb = async (): Promise<CreditsDb> => (await import('../../lib/prisma.js')).default;

function defaultDeps(): CreditsAreaDeps {
  return {
    db: defaultDb,
    env: () => process.env,
    now: () => new Date(),
    summarize: async (userId, brand) => {
      const { summarizeEntitlementsForMe } = await import('../../platform/credits/index.js');
      return summarizeEntitlementsForMe(userId, { brand: brand.id });
    },
    practiceBalance: async (userId) => {
      const [{ getBalance }, { getMockPlanCatalog }] = await Promise.all([import('../../lib/mockCreditService.js'), import('../../lib/mockInterviewPlans.js')]);
      const [b, cat] = await Promise.all([getBalance(userId), getMockPlanCatalog()]);
      if (b.ephemeral) return null;
      return { credits: b.credits, periodAllotment: b.periodAllotment, creditMinutes: cat.creditMinutes };
    },
    cancel: async (userId, input) => {
      const { cancelPlan } = await import('../../roboapply/services/RoboApplyBillingService.js');
      return cancelPlan(userId, input);
    },
    alternative: {
      wasOffered: async (userId) => {
        const { uiStateService } = await import('../uistate/index.js');
        const state = await uiStateService.get(userId);
        return state.state.values?.[ALTERNATIVE_UI_KEY] !== undefined;
      },
      markOffered: async (userId) => {
        const { uiStateService } = await import('../uistate/index.js');
        await uiStateService.patch(userId, { values: { [ALTERNATIVE_UI_KEY]: new Date().toISOString() } });
      },
    },
    sendEmail: async (input) => {
      await import('../../platform/email/templates/billing/index.js');
      const { sendEmail } = await import('../../platform/email/index.js');
      return sendEmail(input);
    },
    rateLimit: async (key, windows) => {
      const { consumeRateLimit } = await import('../../platform/ratelimit/index.js');
      try {
        const res = await consumeRateLimit({ key, windows });
        return res.allowed;
      } catch (err) {
        logger.warn('CREDITS', 'rate limit check failed; allowing', { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    },
    getStripe: () => platformGetStripe(),
    invalidateEntitlements: (userId) => entitlementService.invalidate(userId),
    allocatePacks: (packs, balance) => allocatePackRemaining(packs, balance),
    surveys: createPrismaCancelSurveyStore(defaultDb),
    auditOverride: async (entry) => {
      const { ADMIN_AUDIT_EVENTS, createPrismaAuditStore, writeAdminAudit } = await import('../admin/index.js');
      return writeAdminAudit(createPrismaAuditStore(), {
        adminId: entry.adminId ?? 'unknown',
        subjectUserId: entry.subjectUserId,
        eventType: entry.action === 'created' ? ADMIN_AUDIT_EVENTS.overrideCreated : ADMIN_AUDIT_EVENTS.overrideDeleted,
        payload: {
          overrideId: entry.overrideId,
          key: entry.key,
          value: entry.value,
          ...(entry.action === 'created' ? { expiresAt: entry.expiresAt ?? null, reason: entry.reason ?? null } : {}),
          via: 'admin_credits',
        },
      });
    },
    isStudentVerified: async (userId) => {
      const { studentService } = await import('../account-v2/index.js');
      return studentService.isVerified(userId);
    },
  };
}

/** UI-state value that records the one-time cancel alternative. */
export const ALTERNATIVE_UI_KEY = 'billing.cancelAlternativeOfferedAt';

/** Cancel-survey answers one user may send (it is one optional form after a cancel). */
export const CANCEL_SURVEY_LIMIT = [{ limit: 5, windowSec: 3600 }] as const;

/** Public cancel request limits: per IP and per email address. */
export const PUBLIC_CANCEL_LIMITS = {
  ip: [{ limit: 10, windowSec: 3600 }],
  email: [{ limit: 3, windowSec: 3600 }],
} as const;

/**
 * How often one emailed link may ask the payment provider for its withdrawal
 * quote (the link lives 30 minutes; the page asks once). Past it the preview
 * still answers, with the ordinary cancellation only.
 */
export const PUBLIC_CANCEL_PREVIEW_LIMIT = [{ limit: 20, windowSec: PUBLIC_CANCEL_TOKEN_MINUTES * 60 }] as const;

/** Withdrawals one user may send: one for the plan, one for a pack, one more. */
export const WITHDRAWAL_LIMIT = [{ limit: 3, windowSec: 3600 }] as const;

/**
 * Sending a declared withdrawal again (see "A withdrawal that was declared
 * and could not be completed" below). Counted apart from `WITHDRAWAL_LIMIT`,
 * so a payment provider that fails three times in a row does not lock the
 * buyer out of finishing; still bounded, because every attempt reads the
 * purchases at the provider.
 */
export const WITHDRAWAL_RETRY_LIMIT = [{ limit: 10, windowSec: 3600 }] as const;

/**
 * How long a declared withdrawal keeps its instant: 14 days, the time a seller
 * has to pay a withdrawal back. After that it is a case for staff (an admin
 * refund), not for a button: a buyer whose subscription was never ended at the
 * provider would otherwise keep a withdrawal at an old amount for as long as
 * they liked.
 */
export const WITHDRAWAL_DECLARATION_DAYS = WITHDRAWAL_DAYS;

const DAY_MS = 86_400_000;
/** `refType` of a declaration claim. The engine's completion claim is `stripe_withdrawal`. */
const WITHDRAWAL_DECLARED_REF = 'stripe_withdrawal_declared';
/** `refType` and key prefix of the engine's completion claim (`withdrawPurchase`, platform/billing/stripeRefunds.ts). */
const WITHDRAWAL_DONE_REF = 'stripe_withdrawal';
const WITHDRAWAL_DONE_KEY = 'withdraw:';
/** Declarations of one user that a read looks at (a buyer has one or two open purchases). */
const DECLARATIONS_READ = 5;

function declarationKey(purchaseId: string): string {
  return `withdraw-declared:${purchaseId}`;
}

/** One open withdrawal as this service handles it: the wire entry, and the instant it is decided at when the buyer already declared it. */
interface OpenForBuyer {
  option: WithdrawalOption;
  declaredAt: Date | null;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** The brand takes card payments through Stripe. GoApply never does (rule A11): its withdrawal routes answer without a Stripe call. */
function soldThroughStripe(brand: ProductBrand): boolean {
  return brand.paymentRails.includes('stripe');
}

/**
 * Stripe serves this account: it is RoboApply's and so is its plan row (or the
 * row names no brand). The same rule as `stripeServesAccount` in
 * RoboApplyBillingService and `isRoboApplyAccount` in the refund engine;
 * neither is exported.
 */
function stripeServesAccount(account: Pick<BillingAccount, 'brand' | 'subscription'>): boolean {
  const rowBrand = account.subscription?.brand ?? null;
  return account.brand === 'roboapply' && (rowBrand === null || rowBrand === 'roboapply');
}

/** The engine's quote as the wire shape (carry-over MKT-4A.1). An open withdrawal always has its rule, deadline and region. */
function toWithdrawalOption(open: WithdrawalQuote): WithdrawalOption[] {
  const d = open.decision;
  if (!d.eligible || !isWithdrawalRule(d.rule) || !d.deadline || !d.withdrawalRegion) return [];
  return [
    {
      purchase: { ...open.purchase },
      quote: { rule: d.rule, refundMinor: d.amountMinor, currency: d.currency, deadline: d.deadline, prorata: d.prorata, endsAccess: true, region: d.withdrawalRegion },
    },
  ];
}

/**
 * The purchase started a plan that renews: what a cancel link is about. Never
 * a pass or a pack (those cannot be cancelled, so the link does not offer to
 * withdraw from them; the signed-in page lists every purchase).
 */
function startedRenewingPlan(planKey: string): boolean {
  const def = planDefinitionFor('roboapply', planKey);
  return def ? def.autoRenews : isLegacyPlanKey(planKey);
}

/**
 * The period a subscription invoice paid for: the period of its subscription
 * line, never a proration line. Not the subscription's own "current period":
 * Stripe moves that on when it drafts the renewal, before it collects. The
 * same reading as `invoicePaidPeriod` in the refund engine, which is not
 * exported.
 */
function invoiceLinePeriod(invoice: Stripe.Invoice): { start: Date; end: Date } | null {
  for (const line of invoice.lines?.data ?? []) {
    const item = line.parent?.subscription_item_details ?? null;
    const legacy = line as unknown as { type?: string; proration?: boolean };
    if (!item && legacy.type !== 'subscription') continue;
    if (item?.proration ?? legacy.proration ?? false) continue;
    const start = line.period?.start;
    const end = line.period?.end;
    if (typeof start === 'number' && typeof end === 'number' && end > start) return { start: new Date(start * 1000), end: new Date(end * 1000) };
  }
  return null;
}

/** `details.reason` of a 409 `withdrawal_not_available`: the subscription was ended, and the provider refused the refund. */
const REFUND_REFUSED = 'refund_refused';

/**
 * Is this refusal of a withdrawal's refund the end of the matter? Only when
 * nothing more CAN go back: our rows say the payment is refunded already
 * (`already_refunded`, `amount_above_refundable`), or the provider says so
 * itself (`charge_already_refunded`). The engine reports every other request
 * the provider rejects under the same `refund_not_available` /
 * `refused_by_provider`; those are not final (the refund was never made).
 */
function refundRefusalIsFinal(err: BillingError): boolean {
  const reason = err.details?.reason;
  if (reason === 'already_refunded' || reason === 'amount_above_refundable') return true;
  return reason === 'refused_by_provider' && err.details?.providerCode === 'charge_already_refunded';
}

function cancelLinkInvalid(): BillingError {
  return new BillingError('cancel_token_invalid', 'This link has expired or was already used. Ask for a new one.');
}

/** `practice` marks a "Recent use" cursor that stopped on a practice-interview row (see `historyCursorWhere`). */
function encodeCursor(at: Date, id: string, practice = false): string {
  return Buffer.from(`${at.toISOString()}|${id}${practice ? '|p' : ''}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string; practice: boolean } | null {
  if (!cursor) return null;
  try {
    const [iso, id, source] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso ?? '');
    if (!id || Number.isNaN(at.getTime())) return null;
    return { at, id, practice: source === 'p' };
  } catch {
    return null;
  }
}

function cursorWhere(c: { at: Date; id: string } | null): Record<string, unknown> {
  if (!c) return {};
  return { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] };
}

/**
 * Buckets of RACreditLedger shown in the user's credit history ("Recent
 * use"): the metered actions. Billing claims and internal rows are hidden,
 * and so is 'practice': in that ledger a 'practice' row is never a use. It is
 * the idempotency claim of a practice-credit GRANT (platform/credits/
 * practice.ts: sign-up, verification, checklist, referral, pack purchase), so
 * listing it showed "Practice interviews: 1 used" on an account that had not
 * practised yet.
 */
const HISTORY_BUCKETS: string[] = [...WINDOW_BUCKETS];

/**
 * A practice interview IS a use, and it is recorded somewhere else: the
 * practice-credit ledger (MockInterviewCreditLedger, written by
 * mockCreditService.debitForSession when a session ends). Only its
 * `debit_interview` rows that took something are uses; grants, expiries and
 * admin adjustments are balance changes. Without them an account whose only
 * use was a practice interview read "Nothing used yet." under a practice
 * balance of 0.
 */
const PRACTICE_USE_REASON = 'debit_interview';

/**
 * "Recent use" reads two tables as one list, newest first; where both have a
 * row at the same instant the metered action comes first. The page cursor is
 * the last row shown, so each table continues strictly after it in that
 * order: its own table by (createdAt, id), the other by time alone. Ids are
 * never compared across tables.
 */
function historyCursorWhere(c: { at: Date; id: string; practice: boolean } | null, table: 'ledger' | 'practice'): Record<string, unknown> {
  if (!c) return {};
  if ((table === 'practice') === c.practice) return cursorWhere(c);
  return table === 'practice' ? { createdAt: { lte: c.at } } : { createdAt: { lt: c.at } };
}

/** Practice credits are pro-rated to hundredths (mockInterviewPlans.roundCreditsUp); show what was taken, not a rounded-up 1. */
/**
 * The refund policy label that may be published. The stored version of a
 * brand can carry an internal review note after the rule set's own name
 * (GoApply: `...-pending-counsel`); `GET /billing/plans` is public and the
 * pricing page writes this value into its HTML, so the note is cut off here.
 * Refund decisions keep the full value (`computeRefund`, platform/billing/refunds.ts).
 */
export function publicRefundPolicyVersion(version: string): string {
  return version.replace(/-pending\b.*$/i, '');
}

function practiceCreditsUsed(delta: number): number {
  return Math.round(Math.abs(delta) * 100) / 100;
}

export class CreditsAreaService {
  private readonly d: CreditsAreaDeps;

  constructor(deps: Partial<CreditsAreaDeps> = {}) {
    this.d = { ...defaultDeps(), ...deps };
  }

  // ── Seeker ──────────────────────────────────────────────────────────────

  async getCredits(userId: string, brand: ProductBrand): Promise<CreditsResponse> {
    const [summary, practice] = await Promise.all([this.d.summarize(userId, brand), this.d.practiceBalance(userId)]);
    return {
      summary,
      practice: practice ? { balance: practice.credits, periodAllotment: practice.periodAllotment, creditMinutes: practice.creditMinutes } : null,
    };
  }

  async history(userId: string, query: { cursor?: string; limit?: number }): Promise<{ items: CreditLedgerView[]; cursor: string | null }> {
    const db = await this.d.db();
    const limit = query.limit ?? 30;
    const after = decodeCursor(query.cursor);
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    // limit + 1 from each table: the first `limit` of the two together are then the page.
    const [ledger, practice] = await Promise.all([
      db.rACreditLedger.findMany({
        where: { userId, status: 'committed', bucket: { in: HISTORY_BUCKETS }, ...historyCursorWhere(after, 'ledger') },
        orderBy,
        take: limit + 1,
        select: { id: true, bucket: true, amount: true, sku: true, fromSource: true, createdAt: true, settledAt: true },
      }),
      db.mockInterviewCreditLedger.findMany({
        where: { userId, reason: PRACTICE_USE_REASON, delta: { lt: 0 }, ...historyCursorWhere(after, 'practice') },
        orderBy,
        take: limit + 1,
        select: { id: true, delta: true, createdAt: true },
      }),
    ]);

    type Entry = { view: CreditLedgerView; createdAt: Date; practice: boolean };
    const merged: Entry[] = [];
    let l = 0;
    let p = 0;
    while (merged.length <= limit && (l < ledger.length || p < practice.length)) {
      const ledgerNext = p >= practice.length || (l < ledger.length && ledger[l].createdAt.getTime() >= practice[p].createdAt.getTime());
      if (ledgerNext) {
        const r = ledger[l++];
        merged.push({
          view: { id: r.id, bucket: r.bucket, amount: r.amount, sku: r.sku ?? null, fromSource: r.fromSource, at: (r.settledAt ?? r.createdAt).toISOString() },
          createdAt: r.createdAt,
          practice: false,
        });
      } else {
        const r = practice[p++];
        merged.push({
          view: { id: r.id, bucket: 'practice', amount: practiceCreditsUsed(Number(r.delta)), sku: null, fromSource: 'mock_credit', at: r.createdAt.toISOString() },
          createdAt: r.createdAt,
          practice: true,
        });
      }
    }
    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((e) => e.view),
      cursor: merged.length > limit && last ? encodeCursor(last.createdAt, last.view.id, last.practice) : null,
    };
  }

  async cancel(userId: string, brand: ProductBrand, body: { reason?: string; note?: string }): Promise<CancelResponse> {
    const outcome = await this.runCancel(userId, { ...body, source: 'in_app' });
    let alternative: CancelResponse['alternative'] = null;
    if (outcome.status === 'cancelled' && outcome.changed && getPlan(brand.id, 'pro_week_pass', this.d.env())?.sellable) {
      try {
        if (!(await this.d.alternative.wasOffered(userId))) {
          await this.d.alternative.markOffered(userId);
          alternative = { planKey: 'pro_week_pass' };
        }
      } catch (err) {
        logger.warn('CREDITS', 'cancel alternative check failed; not offering', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { status: outcome.status, accessUntil: outcome.accessUntil?.toISOString() ?? null, alternative };
  }

  /**
   * "Keep my plan": turns auto-renewal back on for a cancelled plan that is
   * still running (platform/billing `resumeSubscription` holds the rules).
   * The acknowledgement is stored as an `auto_renew_ack` consent record for
   * the plan at the price that is charged, before Stripe is asked; a failed
   * Stripe call leaves the plan cancelled (the record stays and proves what
   * was agreed to, like an abandoned checkout).
   */
  async resume(
    userId: string,
    brand: ProductBrand,
    body: { autoRenewAck: boolean },
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<ResumeResponse> {
    const db = await this.d.db();
    const account = await loadBillingAccount(db, userId);
    const seekerProfileId = account?.seekerProfileId ?? null;
    // No account, no profile, or a plan of the other site: nothing here to resume.
    if (!account || !seekerProfileId || account.brand !== brand.id) {
      throw new BillingError('nothing_to_resume', 'There is no cancelled plan to keep');
    }
    const outcome = await resumeSubscription(
      account,
      { getStripe: this.d.getStripe, db, now: this.d.now, env: this.d.env() },
      {
        autoRenewAck: body.autoRenewAck === true,
        record: (charged) =>
          recordCheckoutAcknowledgements(db, {
            seekerProfileId,
            plan: { requiresAutoRenewAck: true, interval: charged.interval, amountMinor: charged.amountMinor, currency: charged.currency },
            autoRenewAck: true,
            withdrawalWaiver: false,
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
          }),
      },
    );
    this.d.invalidateEntitlements(userId);
    return { status: 'resumed', planKey: outcome.planKey, renewsAt: outcome.renewsAt?.toISOString() ?? null };
  }

  // ── Seeker: statutory withdrawal (MARKET_STRATEGY §4.4) ─────────────────

  /**
   * The refund engine on this service's database, clock, Stripe client, mail
   * and entitlement cache. The engine holds every rule (who may withdraw, how
   * much goes back, cancel before refund, the claims); nothing here decides.
   * `decidedAt` is the instant of a withdrawal the buyer already declared: the
   * engine then decides, and dates its confirmation, at that instant.
   */
  private refundEngine(db: CreditsDb, decidedAt: Date | null = null): Partial<StripeRefundDeps> {
    return {
      db,
      getStripe: this.d.getStripe,
      now: decidedAt ? () => decidedAt : this.d.now,
      sendEmail: (input) =>
        this.d.sendEmail({
          template: input.template,
          to: input.to,
          userId: input.userId ?? null,
          locale: input.locale ?? null,
          brand: input.brand ?? 'roboapply',
          params: { ...input.params },
        }),
      invalidate: (userId) => this.d.invalidateEntitlements(userId),
    };
  }

  // ── A withdrawal that was declared and could not be completed ───────────
  //
  // The buyer exercises the right the moment they confirm. When the payment
  // provider then fails (the purchase cannot be read, the subscription cannot
  // be ended, or it is ended and the refund does not go through), that instant
  // must not be lost: sent again after the 14th day the withdrawal would be
  // refused with the subscription already ended and nothing refunded, and
  // sent again on a later day it would refund fewer unused days than quoted.
  //
  // So a failed attempt writes one claim, `billing:withdraw-declared:<purchase>`
  // (the billing claims of the credit ledger; `settledAt` is the instant).
  // While it holds (`WITHDRAWAL_DECLARATION_DAYS`), every read and every
  // attempt for that purchase is decided AT that instant: the same
  // eligibility, the same amount, the same Stripe idempotency keys. The
  // engine's own claim `billing:withdraw:<purchase>` closes the purchase when
  // the withdrawal completes. A declaration without that claim is a withdrawal
  // that still has to be finished.

  private declarationHolds(at: Date, now: Date): boolean {
    const age = now.getTime() - at.getTime();
    return age >= 0 && age <= WITHDRAWAL_DECLARATION_DAYS * DAY_MS;
  }

  /** When this user declared the withdrawal of this purchase, while that still holds; null otherwise. */
  private async declaredAt(db: CreditsDb, userId: string, purchaseId: string): Promise<Date | null> {
    const row = await db.rACreditLedger.findUnique({
      where: { idempotencyKey: billingEventClaimKey(declarationKey(purchaseId)) },
      select: { userId: true, settledAt: true },
    });
    const at = row && row.userId === userId ? row.settledAt : null;
    return at && this.declarationHolds(at, this.d.now()) ? at : null;
  }

  /** The user's declarations that still hold and are not completed, the latest first. */
  private async pendingDeclarations(db: CreditsDb, userId: string): Promise<Array<{ purchaseId: string; at: Date }>> {
    const now = this.d.now();
    const rows = await db.rACreditLedger.findMany({
      where: { userId, bucket: 'billing_event', refType: WITHDRAWAL_DECLARED_REF, settledAt: { gte: new Date(now.getTime() - WITHDRAWAL_DECLARATION_DAYS * DAY_MS) } },
      orderBy: { settledAt: 'desc' },
      take: DECLARATIONS_READ,
      select: { refId: true, settledAt: true },
    });
    const prefix = declarationKey('');
    const declared = rows.flatMap((row) =>
      row.refId?.startsWith(prefix) && row.settledAt && this.declarationHolds(row.settledAt, now) ? [{ purchaseId: row.refId.slice(prefix.length), at: row.settledAt }] : [],
    );
    if (declared.length === 0) return [];
    const done = await db.rACreditLedger.findMany({
      where: { idempotencyKey: { in: declared.map((d) => billingEventClaimKey(`${WITHDRAWAL_DONE_KEY}${d.purchaseId}`)) } },
      select: { idempotencyKey: true },
    });
    const completed = new Set(done.map((row) => row.idempotencyKey));
    return declared.filter((d) => !completed.has(billingEventClaimKey(`${WITHDRAWAL_DONE_KEY}${d.purchaseId}`)));
  }

  /** Keep the instant of a withdrawal that failed at the provider. The first instant stays (a claim is written once). */
  private async declareWithdrawal(db: CreditsDb, userId: string, purchaseId: string, actor: string): Promise<void> {
    try {
      const now = this.d.now();
      const first = await claimBillingEvent(db, userId, declarationKey(purchaseId), WITHDRAWAL_DECLARED_REF, now);
      // Until its completion claim exists this is a withdrawal somebody still has to finish: the buyer, or staff with an admin refund.
      if (first) logger.warn('CREDITS', 'withdrawal: failed at the payment provider; declared and not completed', { userId, purchaseId, actor, declaredAt: now.toISOString() });
    } catch (err) {
      logger.error('CREDITS', 'withdrawal: the declaration could not be recorded; sent again later it is decided at that later time', {
        userId,
        purchaseId,
        actor,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Every withdrawal open for the user, the latest purchase first; empty on a
   * brand Stripe does not serve (no database read, no Stripe call). A purchase
   * whose withdrawal the buyer already declared is listed as it stood at that
   * instant, which is how sending it again decides.
   */
  private async openWithdrawals(db: CreditsDb, userId: string, brand: ProductBrand): Promise<OpenForBuyer[]> {
    if (!soldThroughStripe(brand)) return [];
    const declared = await this.pendingDeclarations(db, userId);
    const open = new Map<string, OpenForBuyer>();
    for (const option of (await withdrawalQuotes(userId, this.refundEngine(db))).flatMap(toWithdrawalOption)) open.set(option.purchase.id, { option, declaredAt: null });
    for (const { purchaseId, at } of declared) {
      const then = (await withdrawalQuotes(userId, this.refundEngine(db, at))).flatMap(toWithdrawalOption).find((option) => option.purchase.id === purchaseId);
      // Open until the declaration stops holding: that, and no longer the purchase's own 14th day, is its last moment.
      const until = new Date(at.getTime() + WITHDRAWAL_DECLARATION_DAYS * DAY_MS).toISOString();
      if (then) open.set(purchaseId, { option: { ...then, quote: { ...then.quote, deadline: until } }, declaredAt: at });
      else open.delete(purchaseId);
    }
    return [...open.values()].sort((a, b) => Date.parse(b.option.purchase.chargedAt) - Date.parse(a.option.purchase.chargedAt));
  }

  /**
   * What the signed-in buyer can withdraw from now: every open purchase, the
   * latest first. Reads only; nothing changes at Stripe or in the database.
   */
  async withdrawalQuote(userId: string, brand: ProductBrand): Promise<WithdrawalResponse> {
    const purchases = (await this.openWithdrawals(await this.d.db(), userId, brand)).map((open) => open.option);
    const first = purchases[0];
    return first ? { available: true, purchase: first.purchase, quote: first.quote, purchases } : { available: false, purchase: null, quote: null, purchases: [] };
  }

  /**
   * One withdrawal through the engine, decided at `declaredAt` when the buyer
   * declared it before. The engine drops the cached plan when it completes.
   * The two refusals that come before any Stripe write
   * (`withdrawal_not_available`, `rail_not_configured`) change nothing; any
   * other failure can come after the subscription was already cancelled at
   * Stripe, so the cache is dropped then too.
   *
   * One of those failures is the refund being refused after the subscription
   * was ended because the money already went back (the payment was refunded
   * by hand a moment ago, say: `refundRefusalIsFinal`). Nothing more can go
   * back, so it is answered as "not open" with the reason `refund_refused`:
   * the page reads the plan again and finds it ended. Every other one is the
   * provider (or our database) failing, or the provider rejecting the refund
   * request for another reason: the instant is kept and the answer is 502, so
   * the same request sent again finishes what the buyer asked for and the
   * declaration is there for staff. (The engine resolves each payment BEFORE
   * it ends the subscription, so a purchase it cannot refund at all is refused
   * with nothing changed.)
   */
  private async runWithdrawal(db: CreditsDb, userId: string, purchaseId: string, actor: 'self' | 'public_link', declaredAt: Date | null): Promise<WithdrawalResult> {
    try {
      return await withdrawPurchase({ userId, purchaseId, actor }, this.refundEngine(db, declaredAt));
    } catch (err) {
      const nothingHappened = err instanceof BillingError && (err.code === 'withdrawal_not_available' || err.code === 'rail_not_configured');
      if (nothingHappened) throw err;
      this.d.invalidateEntitlements(userId);
      if (err instanceof BillingError && err.code === 'refund_not_available') {
        logger.error('CREDITS', 'withdrawal: the refund was refused after the subscription was ended', { userId, purchaseId, actor, details: err.details ?? null });
        if (refundRefusalIsFinal(err)) throw new BillingError('withdrawal_not_available', 'A withdrawal is not open for this purchase', { reason: REFUND_REFUSED });
        // Any other refusal (a request the provider rejects, a payment that could not be resolved a second time) is
        // not "the money already went back": the buyer has no plan and no refund. It is kept like a provider
        // failure, so the purchase stays listed at the quoted amount and staff can find the declaration.
        if (!declaredAt) await this.declareWithdrawal(db, userId, purchaseId, actor);
        throw new BillingError('payment_provider_error', 'The refund could not be sent to the payment provider. Try again.', { provider: 'stripe' });
      }
      if (!declaredAt) await this.declareWithdrawal(db, userId, purchaseId, actor);
      throw err;
    }
  }

  /**
   * Withdraw from the purchase the buyer chose: the subscription ends at once,
   * the quoted amount is refunded, one confirmation mail goes out. A stale id,
   * a purchase past its 14 days and a second request all answer 409
   * `withdrawal_not_available` and change nothing. A request that failed at
   * the payment provider can be sent again: it is decided at the instant of
   * the first one and counted under `WITHDRAWAL_RETRY_LIMIT`.
   */
  async withdraw(userId: string, brand: ProductBrand, body: WithdrawBody): Promise<WithdrawResponse> {
    if (!soldThroughStripe(brand)) throw new BillingError('withdrawal_not_available', 'A withdrawal is not open for this purchase');
    const db = await this.d.db();
    const declaredAt = await this.declaredAt(db, userId, body.purchaseId);
    const limit = declaredAt ? WITHDRAWAL_RETRY_LIMIT : WITHDRAWAL_LIMIT;
    if (!(await this.d.rateLimit(`rl:${brand.id}:withdrawal:${declaredAt ? 'retry:' : ''}user:${userId}`, limit))) {
      throw new HttpError('rate_limited', undefined, { retryAfterSec: limit[0].windowSec });
    }
    const result = await this.runWithdrawal(db, userId, body.purchaseId, 'self', declaredAt);
    return { status: 'withdrawn', refundMinor: result.refundMinor, currency: result.currency, accessEnded: true };
  }

  /**
   * Stores the optional "why did you cancel?" answer and does nothing else:
   * no cancel, no email, no product event (the cancel already did its own).
   * The note is the person's own words and is never logged.
   */
  async recordCancelSurvey(userId: string, brand: ProductBrand, body: { reason?: CancelSurveyReason; note?: string }): Promise<void> {
    const unavailable = () => new HttpError('storage_unavailable', 'We cannot save this answer right now.', { reason: 'storage_unavailable' });
    if (!(await this.d.surveys.available())) throw unavailable();
    if (!(await this.d.rateLimit(`rl:${brand.id}:cancelSurvey:user:${userId}`, CANCEL_SURVEY_LIMIT))) {
      throw new HttpError('rate_limited', undefined, { retryAfterSec: CANCEL_SURVEY_LIMIT[0].windowSec });
    }
    let subscriptionId: string | null = null;
    try {
      subscriptionId = (await loadBillingAccount(await this.d.db(), userId))?.subscription?.id ?? null;
    } catch (err) {
      // The answer is still worth keeping without the reference.
      logger.warn('CREDITS', 'cancel survey: subscription lookup failed', { error: err instanceof Error ? err.message : String(err) });
    }
    const note = body.note?.trim() ? body.note.trim() : null;
    try {
      await this.d.surveys.record({ userId, brand: brand.id, reason: body.reason ?? null, note, subscriptionId });
    } catch (err) {
      if (err instanceof CancelSurveyStoreUnavailableError) throw unavailable();
      throw err;
    }
  }

  /**
   * A completed withdrawal already ended the subscription that this account's
   * plan row still shows as running. The row ends when the provider's
   * `customer.subscription.deleted` is processed, usually seconds later; in
   * between, an ordinary cancellation would ask the provider to change a
   * subscription that no longer exists there (and fail), where the truth is
   * "there is nothing left to cancel".
   *
   * The tie is the subscription itself: the purchase of a completed
   * withdrawal (claim `billing:withdraw:<invoice>`) started the subscription
   * the row names. A withdrawn pack or pass never matches, so a plan that
   * still renews is still cancelled. One database read when nothing was
   * withdrawn lately; a read at the provider only when something was. A
   * failure here never stands in the way of a cancellation.
   */
  private async endedByWithdrawal(userId: string): Promise<boolean> {
    try {
      const db = await this.d.db();
      // A withdrawal that was declared earlier is dated at its declaration: look back over both periods.
      const since = new Date(this.d.now().getTime() - (WITHDRAWAL_DAYS + WITHDRAWAL_DECLARATION_DAYS) * DAY_MS);
      const done = await db.rACreditLedger.findMany({
        where: { userId, bucket: 'billing_event', refType: WITHDRAWAL_DONE_REF, settledAt: { gte: since } },
        orderBy: { settledAt: 'desc' },
        take: DECLARATIONS_READ,
        select: { refId: true },
      });
      const purchases = done.flatMap((row) => (row.refId?.startsWith(WITHDRAWAL_DONE_KEY) ? [row.refId.slice(WITHDRAWAL_DONE_KEY.length)] : []));
      if (purchases.length === 0) return false;
      const account = await loadBillingAccount(db, userId);
      const subscriptionId = account?.subscription?.stripeSubscriptionId ?? null;
      if (!account || !subscriptionId || !stripeServesAccount(account)) return false;
      const stripe = this.d.getStripe();
      if (!stripe) return false;
      for (const purchaseId of purchases) {
        if (invoiceSubscriptionId(await stripe.invoices.retrieve(purchaseId)) === subscriptionId) return true;
      }
      return false;
    } catch (err) {
      logger.warn('CREDITS', 'cancel: could not check for a completed withdrawal; cancelling as usual', { userId, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private async runCancel(userId: string, input: { reason?: string; note?: string; source: 'in_app' | 'public_link' }) {
    // The same answer the cancel path gives once the row has ended.
    if (await this.endedByWithdrawal(userId)) throw new BillingError('no_subscription', 'There is no paid plan to cancel');
    try {
      return await this.d.cancel(userId, input);
    } catch (err) {
      if (err instanceof BillingError) throw err;
      // RoboApplyBillingError carries the same codes; keep its code on the wire.
      const code = (err as { code?: unknown })?.code;
      if (typeof code === 'string' && code in BILLING_ERROR_STATUS) {
        throw new BillingError(code as keyof typeof BILLING_ERROR_STATUS, (err as Error).message);
      }
      throw err;
    }
  }

  // ── Public: plans ───────────────────────────────────────────────────────

  async plans(brand: ProductBrand, input: { userId: string | null; country: string | null }): Promise<PlansResponse> {
    const env = this.d.env();
    const now = this.d.now();
    let currentPlanKey: string | null = null;
    if (input.userId) {
      const db = await this.d.db();
      const account = await loadBillingAccount(db, input.userId);
      if (account) {
        const status = describePlan(account, now);
        currentPlanKey = status.live ? status.planKey : 'free';
      }
    }
    // GoApply (GOAPPLY_PARITY_PLAN §3.8, §7 step 6): the student passes are
    // listed only for a signed-in, verified student, the rule that decides
    // who may buy one (platform/billing/studentPlans).
    // RoboApply lists its student plans as it did before the parity wave,
    // whenever the `student` capability is on (the public /pricing page
    // states the student price and the "verify to get it" path starts from
    // the list); buying one still needs the verification
    // (`studentVerifiedForPlan` at checkout, `assertStudentOrder` in the rail).
    // One rule for both brands is an owner decision, not a default (P7).
    const studentCapability = await isEnabled('student', { userId: input.userId, brand, env }).catch(() => false);
    const studentEnabled =
      brand.market === 'cn'
        ? await studentPlansListedFor(input.userId, brand, {
            studentEnabled: (userId, b) => isEnabled('student', { userId, brand: b, env }),
            isStudentVerified: this.d.isStudentVerified,
          })
        : studentCapability;
    // The buyer's country picks the Taiwan price where one is configured
    // (`localPrice`); checkout applies the same rule to the same header.
    const { plans, defaultSelection } = buildPlanViews(brand.id, { env, currentPlanKey, studentEnabled, country: input.country });
    // The published student rule (MARKET_STRATEGY §4.2: one public price for
    // every buyer plus a published student rule; carry-over of the parity
    // wave). Where the caller is NOT sent the student plans themselves (on
    // GoApply they reach a verified student only), this is the price list
    // they may still read: amounts and the computed percentage, while the
    // `student` capability is on. Null when the plans are in the list above
    // (nothing to add) or the capability is off. Nothing here can be bought with.
    const studentOffer: PlansStudentOffer[] | null =
      studentCapability && !studentEnabled
        ? buildPlanViews(brand.id, { env, studentEnabled: true, country: input.country }).plans.flatMap((p) =>
            (p.key === 'student_monthly' || p.key === 'student_quarterly') && p.amountMinor !== null
              ? [{ key: p.key, amountMinor: p.amountMinor, studentDiscountPercent: p.studentDiscountPercent }]
              : [],
          )
        : null;
    const rails = availableRails(brand, env);
    let fx: PlansResponse['fxReference'] = null;
    if (brand.currency === 'USD' && requirementsMet('fx.reference', brand, env)) {
      const ref = publicFxReference(await this.readFx(), now);
      if (ref) {
        const amounts: Record<string, number> = {};
        for (const p of plans) if (p.amountMinor !== null && p.amountMinor > 0) amounts[p.key] = twdReferenceWhole(p.amountMinor, ref.ratePerUsd);
        fx = { ...ref, amounts };
      }
    }
    return {
      plans,
      defaultSelection,
      currency: brand.currency,
      paymentsOpen: rails.length > 0 && plans.some((p) => p.sellable),
      checkout: {
        rails,
        showWithdrawalWaiver: showsWithdrawalWaiver(input.country),
        country: input.country,
        acknowledgementVersion: CHECKOUT_ACK_PROSE_VERSION,
        // GoApply only, and only when one is configured: never a made-up name (D3).
        collectingEntity: brand.market === 'cn' ? (collectingEntity(brand, env)?.trim() || null) : null,
      },
      // The numbers /pricing prints, from the constants the refund rules use.
      refundPolicy: {
        firstPurchaseDays: FIRST_PURCHASE_DAYS,
        shortPlanHours: SHORT_PLAN_HOURS,
        paidOnlyCreditLimit: PAID_ONLY_CREDIT_LIMIT,
        accidentalRenewalDays: ACCIDENTAL_RENEWAL_DAYS,
        withdrawalDays: WITHDRAWAL_DAYS,
        packValidMonths: PACK_VALID_MONTHS,
        // The public label: never the internal review note of a brand's version.
        version: publicRefundPolicyVersion(REFUND_POLICY_VERSION[brand.id]),
      },
      studentOffer,
      fxReference: fx,
      offers: activeOffers({ brand: brand.id, userId: input.userId, signedUpAt: null, now }) as never[],
    };
  }

  private async readFx(): Promise<FxReference | null> {
    try {
      return await readFxReference(await this.d.db());
    } catch (err) {
      logger.warn('CREDITS', 'fx reference lookup failed; hiding the line', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ── Public: cancel without signing in ──────────────────────────────────

  /** Always resolves (no account enumeration). Emails a single-use 30-minute link when there is a plan to cancel. */
  async requestPublicCancel(brand: ProductBrand, email: string, ip: string): Promise<void> {
    if (!(await this.d.rateLimit(`rl:${brand.id}:publicCancel:ip:${hashToken(ip).slice(0, 32)}`, PUBLIC_CANCEL_LIMITS.ip))) {
      throw new HttpError('rate_limited', undefined, { retryAfterSec: 3600 });
    }
    if (!(await this.d.rateLimit(`rl:${brand.id}:publicCancel:email:${hashToken(email).slice(0, 32)}`, PUBLIC_CANCEL_LIMITS.email))) return;

    const db = await this.d.db();
    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, brand: true } });
    if (!user || (parseBrandId(user.brand) ?? 'roboapply') !== brand.id) return;
    const account = await loadBillingAccount(db, user.id);
    if (!account) return;
    const now = this.d.now();
    const status = describePlan(account, now);
    if (!status.live || !status.autoRenews || !account.subscription) {
      await this.d.sendEmail({ template: 'billing.cancel_none', to: account.email, userId: account.userId, locale: account.locale, brand: brand.id, params: {} });
      return;
    }
    const raw = randomBytes(32).toString('base64url');
    await db.rAAuthToken.create({
      data: {
        userId: account.userId,
        brand: brand.id,
        kind: 'billing_cancel',
        tokenHash: hashToken(raw),
        payload: { subscriptionId: account.subscription.id },
        expiresAt: new Date(now.getTime() + PUBLIC_CANCEL_TOKEN_MINUTES * 60_000),
      },
    });
    await this.d.sendEmail({
      template: 'billing.cancel_link',
      to: account.email,
      userId: account.userId,
      locale: account.locale,
      brand: brand.id,
      params: { url: `${appOrigin(brand, this.d.env())}/cancel?token=${raw}`, expiresMinutes: PUBLIC_CANCEL_TOKEN_MINUTES },
    });
  }

  /**
   * The emailed link, if it can still be used: the right kind, this brand, not
   * used, not expired. Reads only (the link is claimed by `confirmPublicCancel`).
   */
  private async usableCancelLink(db: CreditsDb, brand: ProductBrand, token: string, now: Date): Promise<{ id: string; userId: string }> {
    const row = await db.rAAuthToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, brand: true, kind: true, consumedAt: true, expiresAt: true },
    });
    if (!row || row.kind !== 'billing_cancel' || row.brand !== brand.id || !row.userId || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw cancelLinkInvalid();
    }
    return { id: row.id, userId: row.userId };
  }

  /**
   * The withdrawal a cancel link offers: the latest open purchase of a plan
   * that renews. A pack or a pass bought alongside is a purchase of its own
   * and is not what this link cancels.
   */
  private async linkWithdrawal(db: CreditsDb, userId: string, brand: ProductBrand): Promise<OpenForBuyer | null> {
    return (await this.openWithdrawals(db, userId, brand)).find((open) => startedRenewingPlan(open.option.purchase.planKey)) ?? null;
  }

  /**
   * What the emailed link can do, without using it up: the plan it cancels,
   * where an ordinary cancellation leaves access, and the statutory
   * withdrawal when one is open for that plan. The link is validated exactly
   * as `confirmPublicCancel` validates it.
   */
  async previewPublicCancel(brand: ProductBrand, token: string): Promise<PublicCancelPreviewResponse> {
    const db = await this.d.db();
    const now = this.d.now();
    const link = await this.usableCancelLink(db, brand, token, now);
    const account = await loadBillingAccount(db, link.userId);
    if (!account) throw cancelLinkInvalid();
    const status = describePlan(account, now);
    let withdrawal: PublicCancelPreviewResponse['withdrawal'] = null;
    // The quote is a read at the payment provider, on a route without sign-in: one link may ask a
    // bounded number of times. Cancelling must never depend on that read, so past the bound, and when
    // the read fails, the page offers the ordinary cancellation only (the link itself still withdraws).
    if (await this.d.rateLimit(`rl:${brand.id}:publicCancel:preview:${link.id}`, PUBLIC_CANCEL_PREVIEW_LIMIT)) {
      try {
        const quote = (await this.linkWithdrawal(db, link.userId, brand))?.option.quote;
        if (quote) withdrawal = { refundMinor: quote.refundMinor, currency: quote.currency, rule: quote.rule, deadline: quote.deadline };
      } catch (err) {
        logger.warn('CREDITS', 'cancel link preview: the withdrawal could not be read; offering the cancellation only', {
          userId: link.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { planKey: status.planKey, accessUntil: status.accessUntil?.toISOString() ?? null, withdrawal };
  }

  /** The ordinary cancellation of a link: at the end of the paid period; the cancel path sends the confirmation email. */
  private async cancelThroughLink(userId: string): Promise<CancelResponse> {
    try {
      const outcome = await this.runCancel(userId, { source: 'public_link' });
      return { status: outcome.status, accessUntil: outcome.accessUntil?.toISOString() ?? null, alternative: null };
    } catch (err) {
      if (err instanceof BillingError && err.code === 'no_subscription') return { status: 'already_cancelled', accessUntil: null, alternative: null };
      throw err;
    }
  }

  /**
   * The withdrawal of a link, or null when none is open (any more) for the
   * plan. A provider failure is thrown; from the moment the plan's purchase is
   * known it also keeps the instant, so the same link, or the signed-in page
   * once the link has expired, finishes the withdrawal as it was asked for.
   */
  private async withdrawThroughLink(db: CreditsDb, userId: string, brand: ProductBrand): Promise<WithdrawalResult | null> {
    const open = await this.linkWithdrawal(db, userId, brand);
    if (!open) return null;
    try {
      return await this.runWithdrawal(db, userId, open.option.purchase.id, 'public_link', open.declaredAt);
    } catch (err) {
      // Closed between the read and the call (the deadline, a refund by staff, another tab): nothing
      // happened, so the ordinary cancellation takes its place. A refund the provider refused is not
      // that: the subscription is ended by then and there is nothing left to cancel.
      const closed = err instanceof BillingError && err.code === 'withdrawal_not_available' && err.details?.reason !== REFUND_REFUSED;
      if (closed) return null;
      throw err;
    }
  }

  /**
   * Consumes the link (single use, 30 minutes). Without `withdraw` it cancels
   * at the end of the paid period; the cancel path sends the confirmation
   * email. With `withdraw` it withdraws from the plan's purchase instead (the
   * subscription ends at once, the quoted amount is refunded, the withdrawal
   * mail goes out), and falls back to the ordinary cancellation, saying so,
   * when no withdrawal is open any more.
   *
   * The link is claimed before the provider call (so two clicks cannot both
   * run), and released again when the provider call itself fails (e.g. Stripe
   * is down), so the person can retry the same link while it is still valid
   * instead of starting over. A withdrawal that failed half way is finished by
   * that retry: the engine repeats the same Stripe calls with the same keys,
   * decided at the instant of the first attempt (see "A withdrawal that was
   * declared and could not be completed"). A plan that a withdrawal made
   * elsewhere already ended answers `already_cancelled` (`endedByWithdrawal`).
   */
  async confirmPublicCancel(brand: ProductBrand, token: string, options: { withdraw?: boolean } = {}): Promise<PublicCancelConfirmResponse> {
    const db = await this.d.db();
    const now = this.d.now();
    const link = await this.usableCancelLink(db, brand, token, now);
    const consumed = await db.rAAuthToken.updateMany({
      where: { id: link.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) throw cancelLinkInvalid();
    try {
      if (options.withdraw !== true) return await this.cancelThroughLink(link.userId);
      const withdrawn = await this.withdrawThroughLink(db, link.userId, brand);
      if (withdrawn) {
        // Access ended now: there is no "until".
        return { status: 'cancelled', accessUntil: null, alternative: null, withdrawal: { status: 'withdrawn', refundMinor: withdrawn.refundMinor, currency: withdrawn.currency } };
      }
      return { ...(await this.cancelThroughLink(link.userId)), withdrawal: { status: 'not_available', refundMinor: null, currency: null } };
    } catch (err) {
      // Nothing was completed: give the link back (only if it is still our claim).
      await db.rAAuthToken
        .updateMany({ where: { id: link.id, consumedAt: now }, data: { consumedAt: null } })
        .catch((releaseErr: unknown) =>
          logger.warn('CREDITS', 'could not release the cancel link after a failed cancel', {
            error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
          }),
        );
      throw err;
    }
  }

  // ── Admin: caps ─────────────────────────────────────────────────────────

  async getCatalog(): Promise<CatalogAdminResponse> {
    const db = await this.d.db();
    const row = await db.appConfig.findUnique({ where: { key: CREDIT_CATALOG_CONFIG_KEY }, select: { value: true, updatedAt: true, updatedBy: true } });
    const parsed = parseCreditCatalogOverride(row?.value);
    return {
      override: parsed.override,
      error: parsed.error,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
      defaults: DEFAULT_CREDIT_CATALOG,
      effective: { roboapply: catalogFor('roboapply', parsed.override), goapply: catalogFor('goapply', parsed.override) },
    };
  }

  async putCatalog(override: unknown, adminId: string | null): Promise<CatalogAdminResponse> {
    const parsed = CreditCatalogOverrideSchema.safeParse(override);
    if (!parsed.success) {
      throw new HttpError(
        'invalid_request',
        'The caps are not valid.',
        parsed.error.issues.map((i) => ({ path: ['override', ...i.path].join('.'), message: i.message })),
      );
    }
    const db = await this.d.db();
    const value = JSON.stringify(parsed.data);
    await db.appConfig.upsert({
      where: { key: CREDIT_CATALOG_CONFIG_KEY },
      update: { value, updatedBy: adminId },
      create: { key: CREDIT_CATALOG_CONFIG_KEY, value, updatedBy: adminId },
    });
    invalidateCreditCatalog();
    logger.info('CREDITS', 'credit catalog override saved', { adminId });
    return this.getCatalog();
  }

  // ── Admin: entitlement overrides ────────────────────────────────────────

  async listOverrides(query: { userId?: string; cursor?: string }): Promise<{ items: CreditOverrideAdminView[]; cursor: string | null }> {
    const db = await this.d.db();
    const limit = 50;
    const rows = await db.rAEntitlementOverride.findMany({
      where: { ...(query.userId ? { userId: query.userId } : {}), ...cursorWhere(decodeCursor(query.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toOverrideView), cursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  async createOverride(
    body: { userId: string; key: string; value: number | boolean | 'off' | 'deeplinks_only' | 'on'; expiresAt?: string; reason: string },
    adminId: string | null,
  ): Promise<CreditOverrideAdminView> {
    const problem = overrideProblem(body.key, body.value);
    if (problem) throw new HttpError('invalid_request', problem, [{ path: 'value', message: problem }]);
    if (body.expiresAt && Date.parse(body.expiresAt) <= this.d.now().getTime()) {
      throw new HttpError('invalid_request', 'The end date is in the past.', [{ path: 'expiresAt', message: 'In the past' }]);
    }
    const db = await this.d.db();
    const user = await db.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (!user) throw new HttpError('not_found', 'No user with this id.');
    const row = await db.rAEntitlementOverride.create({
      data: {
        userId: body.userId,
        key: body.key,
        value: body.value,
        reason: body.reason,
        adminId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });
    this.d.invalidateEntitlements(body.userId);
    logger.info('CREDITS', 'entitlement override created', { adminId, userId: body.userId, key: body.key });
    return toOverrideView(row);
  }

  async deleteOverride(id: string, adminId: string | null): Promise<void> {
    await this.removeOverride(id, adminId);
  }

  private async removeOverride(id: string, adminId: string | null): Promise<{ id: string; userId: string; key: string; value: unknown }> {
    const db = await this.d.db();
    const row = await db.rAEntitlementOverride.findUnique({ where: { id }, select: { id: true, userId: true, key: true, value: true } });
    if (!row) throw new HttpError('not_found', 'No override with this id.');
    await db.rAEntitlementOverride.delete({ where: { id } });
    this.d.invalidateEntitlements(row.userId);
    logger.info('CREDITS', 'entitlement override deleted', { adminId, userId: row.userId, key: row.key });
    return row;
  }

  /**
   * `createOverride` plus one admin audit row — what POST
   * /admin/credits/overrides runs. (The admin console's own
   * /admin/overrides routes call `createOverride` / `deleteOverride` and write
   * the same row themselves, so neither path audits twice.)
   */
  async createOverrideAudited(body: Parameters<CreditsAreaService['createOverride']>[0], adminId: string | null): Promise<CreditOverrideAdminView> {
    const row = await this.createOverride(body, adminId);
    await this.audit({ action: 'created', adminId, subjectUserId: row.userId, overrideId: row.id, key: row.key, value: row.value, expiresAt: row.expiresAt, reason: row.reason });
    return row;
  }

  /** `deleteOverride` plus one admin audit row — what DELETE /admin/credits/overrides/:id runs. */
  async deleteOverrideAudited(id: string, adminId: string | null): Promise<void> {
    const row = await this.removeOverride(id, adminId);
    await this.audit({ action: 'deleted', adminId, subjectUserId: row.userId, overrideId: row.id, key: row.key, value: row.value });
  }

  /** The change already happened; a failed audit write is logged and never undoes or fails it. */
  private async audit(entry: OverrideAuditEntry): Promise<void> {
    try {
      await this.d.auditOverride(entry);
    } catch (err) {
      logger.error('CREDITS', 'override audit row failed', {
        action: entry.action,
        adminId: entry.adminId,
        subjectUserId: entry.subjectUserId,
        overrideId: entry.overrideId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Admin: TWD reference + TW revenue monitor ──────────────────────────

  async getFx(): Promise<FxReferenceAdminView | null> {
    const ref = await readFxReference(await this.d.db());
    if (!ref) return null;
    const now = this.d.now();
    return { ...ref, ageDays: fxAgeDays(ref, now), fresh: isFxFresh(ref, now) };
  }

  async putFx(body: { ratePerUsd: number; source: string; asOf: string }, adminId: string | null): Promise<FxReferenceAdminView> {
    const now = this.d.now();
    if (Number.isNaN(Date.parse(`${body.asOf}T00:00:00.000Z`)) || fxAgeDays(body, now) < 0) {
      throw new HttpError('invalid_request', 'The as-of date cannot be in the future.', [{ path: 'asOf', message: 'In the future' }]);
    }
    const ref = await saveFxReference(await this.d.db(), body, adminId, now);
    return { ...ref, ageDays: fxAgeDays(ref, now), fresh: isFxFresh(ref, now) };
  }

  async twRevenue(): Promise<TwRevenueResponse> {
    const stripe = this.d.getStripe();
    if (!stripe) throw new HttpError('provider_not_configured', 'Stripe is not configured on this deployment.');
    return computeTwRevenue({ stripe: stripe as unknown as Parameters<typeof computeTwRevenue>[0]['stripe'], fx: await this.readFx(), now: this.d.now() });
  }

  // ── Admin: refund quote (F-BILL-08) ────────────────────────────────────

  /**
   * The period bounds of a Stripe subscription, for an invoice that carries no
   * subscription line. A failed read gives no bounds (the rules that need none
   * decide), never a failed quote.
   */
  private async subscriptionPeriod(stripe: Stripe, subscriptionId: string): Promise<{ start: Date | null; end: Date | null }> {
    try {
      return stripePeriod(await stripe.subscriptions.retrieve(subscriptionId));
    } catch (err) {
      logger.warn('CREDITS', 'refund quote: the subscription period could not be read; quoting without it', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { start: null, end: null };
    }
  }

  /**
   * The refund rules applied to the user's latest charge (quote only). For a
   * subscription charge the paid period goes into the calculation, so a buyer
   * in a withdrawal country who ticked the waiver is quoted the unused days
   * (rule 1b), the amount their own "Withdraw from contract" entry shows.
   */
  async refundQuote(userId: string): Promise<RefundQuoteResponse> {
    const db = await this.d.db();
    const account = await loadBillingAccount(db, userId);
    if (!account) throw new HttpError('not_found', 'No user with this id.');
    const now = this.d.now();
    const sub = account.subscription;

    type Charge = NonNullable<RefundQuoteResponse['charge']>;
    const candidates: Charge[] = [];
    // Rule A11: only an account Stripe serves has anything there; no other account makes the server ask.
    const stripe = stripeServesAccount(account) ? this.d.getStripe() : null;
    let invoice: Stripe.Invoice | null = null;
    if (stripe && sub?.stripeCustomerId) {
      const list = await stripe.invoices.list({ customer: sub.stripeCustomerId, status: 'paid', limit: 1 });
      const inv = list.data[0];
      if (inv && (inv.amount_paid ?? 0) > 0) {
        invoice = inv;
        const paidAt = inv.status_transitions?.paid_at ?? inv.created;
        const metaKey = (inv.metadata?.planKey as string | undefined) ?? null;
        candidates.push({
          source: 'stripe',
          id: inv.id as string,
          chargedAt: new Date(paidAt * 1000).toISOString(),
          amountMinor: inv.amount_paid,
          currency: (inv.currency ?? 'usd').toUpperCase(),
          planKey: metaKey ?? sub.planKey ?? sub.tier,
          chargeKind: inv.billing_reason === 'subscription_cycle' ? 'renewal' : 'first_purchase',
        });
      }
    }
    const order = await db.alipayOrder.findFirst({
      where: { userId, status: 'completed', tier: { startsWith: 'ra_' } },
      orderBy: { completedAt: 'desc' },
    });
    if (order) {
      candidates.push({
        source: 'cn',
        id: order.id,
        chargedAt: (order.completedAt ?? order.createdAt).toISOString(),
        amountMinor: order.amountMinor ?? Math.round(order.amount * 100),
        currency: 'CNY',
        planKey: order.planKey ?? order.tier.replace(/^ra_/, ''),
        chargeKind: 'first_purchase',
      });
    }
    const charge = candidates.sort((a, b) => Date.parse(b.chargedAt) - Date.parse(a.chargedAt))[0] ?? null;
    if (!charge) return { charge: null, facts: null, decision: null };

    const chargedAt = new Date(charge.chargedAt);
    // The waiver box of this charge: the Stripe purchase's own checkout stamp, else the consent window (the engine's
    // one reading, `purchaseWaived`; a mainland order and a renewal carry no stamp).
    const waiver = await purchaseWaived(db, account.seekerProfileId, charge.source === 'stripe' ? invoice : null, chargedAt);

    const usage = await db.rACreditLedger.findMany({
      where: { userId, status: 'committed', fromSource: 'window', bucket: { in: [...WINDOW_BUCKETS] }, createdAt: { gte: chargedAt } },
      select: { bucket: true, windowKey: true, amount: true },
    });
    const catalog = await getCreditCatalog(account.brand);
    const freeCaps: Record<string, number> = {};
    for (const b of WINDOW_BUCKETS) freeCaps[b] = catalog.buckets[b].caps.free.cap;
    const paidOnly = paidOnlyCreditsUsed(
      usage.map((u) => ({ bucket: u.bucket, windowKey: u.windowKey, units: u.amount })),
      freeCaps,
    );

    let packCreditsUsed: number | null = null;
    if (isPackPlan(charge.planKey)) {
      const def = planDefinitionFor(account.brand, charge.planKey);
      const packs = await db.rACreditGrant.findMany({
        where: { userId, bucket: 'practice' },
        select: { id: true, amount: true, remaining: true, expiresAt: true, createdAt: true },
      });
      const pack = packs
        .filter((p) => p.createdAt.getTime() >= chargedAt.getTime() - 60_000)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      const balance = (await this.d.practiceBalance(userId))?.credits ?? 0;
      if (pack) {
        const alloc = this.d.allocatePacks(packs.filter((p) => p.remaining > 0), balance);
        packCreditsUsed = Math.max(0, pack.amount - (alloc.get(pack.id) ?? 0));
      } else {
        packCreditsUsed = def?.practice?.credits ?? null;
      }
    }

    // A Stripe charge: the period it paid for is on the invoice's own
    // subscription line (the subscription shows the NEXT period before the
    // renewal is paid, so it is read only for an invoice without a line), and
    // the buyer's country is on the invoice when the account holds none.
    const stripeInvoice = charge.source === 'stripe' ? invoice : null;
    let period: { start: Date | null; end: Date | null } = { start: null, end: null };
    if (stripe && stripeInvoice) {
      const subscriptionId = invoiceSubscriptionId(stripeInvoice);
      if (subscriptionId) period = invoiceLinePeriod(stripeInvoice) ?? (await this.subscriptionPeriod(stripe, subscriptionId));
    }
    const billingCountry = sub?.billingCountry ?? stripeInvoice?.customer_address?.country ?? null;

    const decision = computeRefund({
      brand: account.brand,
      planKey: charge.planKey,
      chargeKind: charge.chargeKind,
      chargedAt,
      amountMinor: charge.amountMinor,
      currency: charge.currency,
      now,
      billingCountry,
      withdrawalWaiver: waiver,
      paidOnlyCreditsUsed: paidOnly,
      packCreditsUsed: packCreditsUsed ?? undefined,
      periodStart: period.start,
      periodEnd: period.end,
    });
    return {
      charge,
      facts: { billingCountry, withdrawalWaiver: waiver, paidOnlyCreditsUsed: paidOnly, packCreditsUsed },
      decision,
    };
  }
}

function toOverrideView(row: { id: string; userId: string; key: string; value: unknown; reason: string; adminId: string | null; expiresAt: Date | null; createdAt: Date }): CreditOverrideAdminView {
  return {
    id: row.id,
    userId: row.userId,
    key: row.key,
    value: row.value,
    reason: row.reason,
    adminId: row.adminId ?? null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Semantic check of an override key/value pair; null when valid. */
export function overrideProblem(key: string, value: unknown): string | null {
  const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'bucket') {
    if (!isWindowBucket(name)) return `Unknown credit bucket "${name}".`;
    if (name === 'contact_lookup') return 'Contact lookup stays off until a licensed provider exists.';
    if (typeof value !== 'number') return 'A credit cap must be a number.';
    return null;
  }
  if (kind === 'entitlement') {
    if (!isEntitlementKey(name)) return `Unknown entitlement "${name}".`;
    if (name === 'competitivenessFull') return typeof value === 'boolean' ? null : 'This entitlement is on or off.';
    return typeof value === 'number' ? null : 'This entitlement is a number.';
  }
  if (kind === 'flag') {
    if (name === 'hiringContacts') return value === 'off' || value === 'deeplinks_only' || value === 'on' ? null : 'Use off, deeplinks_only or on.';
    if (!(FLAG_KEYS as readonly string[]).includes(name)) return `Unknown flag "${name}".`;
    return typeof value === 'boolean' ? null : 'A flag is on or off.';
  }
  return 'Unknown override kind.';
}

export const creditsAreaService = new CreditsAreaService();
