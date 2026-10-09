// server/src/features/credits/service.ts
//
// The credits HTTP area (TASK_PLAN.md WP-21a; ARCHITECTURE.md §3.9, §7):
//   seeker   GET /credits, GET /credits/history, POST /credits/cancel
//   public   GET /billing/plans, POST /api/v1/public/cancel(+/confirm)
//   admin    caps editor (AppConfig credits.catalog.v1), entitlement
//            overrides, TWD reference rate, TW revenue monitor, refund quote
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
  BILLING_ERROR_STATUS,
  BillingError,
  CHECKOUT_ACK_PROSE_VERSION,
  getStripe as platformGetStripe,
  activeOffers,
  appOrigin,
  availableRails,
  buildPlanViews,
  computeRefund,
  computeTwRevenue,
  describePlan,
  fxAgeDays,
  getPlan,
  isFxFresh,
  isPackPlan,
  loadBillingAccount,
  paidOnlyCreditsUsed,
  planDefinitionFor,
  publicFxReference,
  readFxReference,
  saveFxReference,
  showsWithdrawalWaiver,
  twdReferenceWhole,
  type BillingAccount,
  type CancelOutcome,
  type FxReference,
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
  type CancelResponse,
  type CatalogAdminResponse,
  type CreditLedgerView,
  type CreditOverrideAdminView,
  type CreditsResponse,
  type FxReferenceAdminView,
  type PlansResponse,
  type RefundQuoteResponse,
  type TwRevenueResponse,
} from './contract.js';

export type CreditsDb = Pick<
  ExtendedPrismaClient,
  | 'rACreditLedger'
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
  };
}

/** UI-state value that records the one-time cancel alternative. */
export const ALTERNATIVE_UI_KEY = 'billing.cancelAlternativeOfferedAt';

/** Public cancel request limits: per IP and per email address. */
export const PUBLIC_CANCEL_LIMITS = {
  ip: [{ limit: 10, windowSec: 3600 }],
  email: [{ limit: 3, windowSec: 3600 }],
} as const;

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso ?? '');
    if (!id || Number.isNaN(at.getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}

function cursorWhere(c: { at: Date; id: string } | null): Record<string, unknown> {
  if (!c) return {};
  return { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] };
}

/** Buckets shown in the user's credit history (billing claims and internal rows are hidden). */
const HISTORY_BUCKETS = [...WINDOW_BUCKETS, 'practice'];

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
    const rows = await db.rACreditLedger.findMany({
      where: { userId, status: 'committed', bucket: { in: HISTORY_BUCKETS }, ...cursorWhere(decodeCursor(query.cursor)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, bucket: true, amount: true, sku: true, fromSource: true, createdAt: true, settledAt: true },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        bucket: r.bucket,
        amount: r.amount,
        sku: r.sku ?? null,
        fromSource: r.fromSource,
        at: (r.settledAt ?? r.createdAt).toISOString(),
      })),
      cursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
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

  private async runCancel(userId: string, input: { reason?: string; note?: string; source: 'in_app' | 'public_link' }) {
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
    const studentEnabled = await isEnabled('student', { userId: input.userId, brand, env }).catch(() => false);
    const { plans, defaultSelection } = buildPlanViews(brand.id, { env, currentPlanKey, studentEnabled });
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
      },
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
   * Consumes the link (single use, 30 minutes) and cancels; the cancel path
   * sends the confirmation email. The link is claimed before the provider call
   * (so two clicks cannot both run), and released again when the cancellation
   * itself fails (e.g. Stripe is down), so the person can retry the same link
   * while it is still valid instead of starting over.
   */
  async confirmPublicCancel(brand: ProductBrand, token: string): Promise<CancelResponse> {
    const db = await this.d.db();
    const now = this.d.now();
    const tokenHash = hashToken(token);
    const row = await db.rAAuthToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, brand: true, kind: true, consumedAt: true, expiresAt: true } });
    const invalid = () => new BillingError('cancel_token_invalid', 'This link has expired or was already used. Ask for a new one.');
    if (!row || row.kind !== 'billing_cancel' || row.brand !== brand.id || !row.userId || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw invalid();
    }
    const consumed = await db.rAAuthToken.updateMany({
      where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) throw invalid();
    try {
      const outcome = await this.runCancel(row.userId, { source: 'public_link' });
      return { status: outcome.status, accessUntil: outcome.accessUntil?.toISOString() ?? null, alternative: null };
    } catch (err) {
      if (err instanceof BillingError && err.code === 'no_subscription') return { status: 'already_cancelled', accessUntil: null, alternative: null };
      // Nothing was cancelled: give the link back (only if it is still our claim).
      await db.rAAuthToken
        .updateMany({ where: { id: row.id, consumedAt: now }, data: { consumedAt: null } })
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
    const db = await this.d.db();
    const row = await db.rAEntitlementOverride.findUnique({ where: { id }, select: { id: true, userId: true, key: true } });
    if (!row) throw new HttpError('not_found', 'No override with this id.');
    await db.rAEntitlementOverride.delete({ where: { id } });
    this.d.invalidateEntitlements(row.userId);
    logger.info('CREDITS', 'entitlement override deleted', { adminId, userId: row.userId, key: row.key });
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

  async refundQuote(userId: string): Promise<RefundQuoteResponse> {
    const db = await this.d.db();
    const account = await loadBillingAccount(db, userId);
    if (!account) throw new HttpError('not_found', 'No user with this id.');
    const now = this.d.now();
    const sub = account.subscription;

    type Charge = NonNullable<RefundQuoteResponse['charge']>;
    const candidates: Charge[] = [];
    const stripe = this.d.getStripe();
    if (stripe && sub?.stripeCustomerId) {
      const list = await stripe.invoices.list({ customer: sub.stripeCustomerId, status: 'paid', limit: 1 });
      const inv = list.data[0];
      if (inv && (inv.amount_paid ?? 0) > 0) {
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
    const waiver = account.seekerProfileId
      ? await db.seekerConsentRecord.findFirst({
          where: {
            seekerProfileId: account.seekerProfileId,
            consentType: 'withdrawal_waiver',
            granted: true,
            createdAt: { gte: new Date(chargedAt.getTime() - 86_400_000), lte: new Date(chargedAt.getTime() + 3_600_000) },
          },
          select: { id: true },
        })
      : null;

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

    const decision = computeRefund({
      brand: account.brand,
      planKey: charge.planKey,
      chargeKind: charge.chargeKind,
      chargedAt,
      amountMinor: charge.amountMinor,
      currency: charge.currency,
      now,
      billingCountry: sub?.billingCountry ?? null,
      withdrawalWaiver: Boolean(waiver),
      paidOnlyCreditsUsed: paidOnly,
      packCreditsUsed: packCreditsUsed ?? undefined,
    });
    return {
      charge,
      facts: { billingCountry: sub?.billingCountry ?? null, withdrawalWaiver: Boolean(waiver), paidOnlyCreditsUsed: paidOnly, packCreditsUsed },
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
