// Test fixtures for the credits / billing UI. Plans come from the real server
// catalog builder, so the UI is tested against the exact wire shape
// `GET /billing/plans` sends.
//
// The default fixtures ARE the catalog of MARKET_STRATEGY.md §4 (the amounts a
// deployment shows with no price variable set):
//   RoboApply (USD cents): weekly 999, monthly 2499, quarterly 5499, 7-day
//     pass 999, packs 999 / 2499, student 1749 / 3799.
//   GoApply (fen): 周卡 1200, 月卡 3900, 季卡 9900, packs 2900 / 7900, student
//     2900 / 6900.
// RoboApply's amounts are stated here through the override variables on
// purpose, together with a card rail that is ready (a test key and a webhook
// secret): the fixture then means "these amounts, on sale" whichever way the
// catalog resolves a default, and a test that wants another state (no amount,
// payments closed) builds it explicitly with the helpers below instead of
// relying on what an empty environment happens to give.

import type { ReactElement } from 'react';
import { expect } from 'vitest';

import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import {
  ACCIDENTAL_RENEWAL_DAYS,
  FIRST_PURCHASE_DAYS,
  PACK_VALID_MONTHS,
  PAID_ONLY_CREDIT_LIMIT,
  REFUND_POLICY_VERSION,
  SHORT_PLAN_HOURS,
  WITHDRAWAL_DAYS,
} from '../../../../server/src/platform/billing/refunds';
import type { CreditsResponse } from '../../../../lib/api/contracts/credits';
import type { PlansBillingFacts, RefundPolicyFacts } from '../../../../lib/api/account';
import type { PlansView } from '../../../../lib/api/credits';
import type { BrandId } from '../../../../lib/brand/registry.generated';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';

/** A card rail that can charge and fulfil: a test-mode key and a webhook secret (placeholders, never real values). */
export const RA_RAIL_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
};

export const RA_ENV = {
  ...RA_RAIL_ENV,
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5499',
  STRIPE_PRICE_PRO_WEEK_PASS: 'price_p',
  STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '999',
  STRIPE_PRICE_PRACTICE_PACK_5: 'price_5',
  STRIPE_PRICE_PRACTICE_PACK_5_CENTS: '999',
  STRIPE_PRICE_PRACTICE_PACK_15: 'price_15',
  STRIPE_PRICE_PRACTICE_PACK_15_CENTS: '2499',
};

/** RA_ENV plus the two student plans at their catalog amounts (the server lists them only when asked to: `studentEnabled`). */
export const RA_STUDENT_ENV = {
  ...RA_ENV,
  STRIPE_PRICE_STUDENT_MONTHLY: 'price_sm',
  STRIPE_PRICE_STUDENT_MONTHLY_CENTS: '1749',
  STRIPE_PRICE_STUDENT_QUARTERLY: 'price_sq',
  STRIPE_PRICE_STUDENT_QUARTERLY_CENTS: '3799',
};

/**
 * GoApply needs no price or payments variable: the catalog carries the CNY
 * amounts (¥12 / ¥39 / ¥99, packs ¥29 / ¥79, student passes ¥29 / ¥69) and
 * plans are on sale by default (D5, D6).
 */
export const GA_ENV: Record<string, string> = {};

/**
 * The refund numbers as `GET /billing/plans` sends them (`refundPolicy`): the
 * server's own constants (`platform/billing/refunds.ts`), so the fixture is
 * what a deployment answers and no test restates a number the server owns.
 */
export function refundPolicyFor(brand: BrandId = 'roboapply'): RefundPolicyFacts {
  return {
    firstPurchaseDays: FIRST_PURCHASE_DAYS,
    shortPlanHours: SHORT_PLAN_HOURS,
    paidOnlyCreditLimit: PAID_ONLY_CREDIT_LIMIT,
    accidentalRenewalDays: ACCIDENTAL_RENEWAL_DAYS,
    withdrawalDays: WITHDRAWAL_DAYS,
    packValidMonths: PACK_VALID_MONTHS,
    version: REFUND_POLICY_VERSION[brand],
  };
}
export const REFUND_POLICY: RefundPolicyFacts = refundPolicyFor('roboapply');

type Rail = PlansView['checkout']['rails'][number];

/**
 * The `checkout` block of a plans response. Use it wherever a test states the
 * rails or the country: it carries `collectingEntity` (null unless given), a
 * field of the cross-bundle contract that the mirrored type gains when the
 * server half merges, so one helper is right before and after that merge.
 */
export function checkoutOf(
  rails: readonly Rail[],
  over: { showWithdrawalWaiver?: boolean; country?: string | null; acknowledgementVersion?: string; collectingEntity?: string | null } = {},
): PlansView['checkout'] {
  return {
    rails: [...rails],
    showWithdrawalWaiver: over.showWithdrawalWaiver ?? false,
    country: over.country ?? null,
    acknowledgementVersion: over.acknowledgementVersion ?? 'test',
    collectingEntity: over.collectingEntity ?? null,
  } as PlansView['checkout'];
}

/**
 * A plans response as the server sends it: the plans, the rails, and the
 * facts the pricing page prints (`refundPolicy`; `checkout.collectingEntity`
 * and `studentOffer`, both null here). Every response built in this file
 * carries all three, so the server contract may make them required members
 * (waveM1-carryover MKT-2E.1).
 *
 * `plansView('goapply')` is a GoApply deployment with NO rail credential: the
 * plans list with prices and are on sale, but no rail can charge, so payments
 * are not open (`paymentsOpen: false`, `checkout.rails: []`). Pass `extras`
 * (or use a test's own helper) for a deployment whose rails can charge.
 */
export function plansView(brand: BrandId = 'roboapply', env: Record<string, string> = brand === 'goapply' ? GA_ENV : RA_ENV, extras: Partial<PlansView> = {}): PlansView {
  // The full `PlansResponse` (planViews.ts builds the plans the server sends).
  const { plans, defaultSelection } = buildPlanViews(brand, { env });
  return {
    plans,
    defaultSelection,
    currency: brand === 'goapply' ? 'CNY' : 'USD',
    paymentsOpen: brand !== 'goapply',
    checkout: checkoutOf(brand === 'goapply' ? [] : ['stripe']),
    fxReference: null,
    offers: [],
    refundPolicy: refundPolicyFor(brand),
    // No student price is published on this response (the server sends the
    // prices here only to a caller who is not sent the student plans).
    studentOffer: null,
    ...extras,
  } as PlansView;
}

/** The brand's plans as a signed-in, verified student receives them (the two student plans included). */
export function studentPlansView(brand: BrandId = 'roboapply', extras: Partial<PlansView> = {}): PlansView {
  const { plans, defaultSelection } = buildPlanViews(brand, { env: brand === 'goapply' ? GA_ENV : RA_STUDENT_ENV, studentEnabled: true });
  return { ...plansView(brand, undefined, extras), plans, defaultSelection };
}

/**
 * A response whose plans carry NO amount (a plan added to the catalog without
 * a default: the guard state). Built explicitly: with the catalog defaults an
 * empty environment no longer means "no price".
 */
export function unpricedPlansView(brand: BrandId = 'roboapply', extras: Partial<PlansView> = {}): PlansView {
  const view = plansView(brand);
  return {
    ...view,
    defaultSelection: null,
    paymentsOpen: false,
    plans: view.plans.map((p) =>
      p.kind === 'free'
        ? p
        : { ...p, amountMinor: null, stripePriceId: null, twdPrice: null, localPrice: null, sellable: false, unsellableReason: 'price_unset' as const, isDefaultSelection: false, savingsPercent: null, monthlyEquivalentMinor: null, studentDiscountPercent: null, promotionCodes: false },
    ),
    ...extras,
  };
}

/**
 * RoboApply with a card rail that is NOT ready (the key or the webhook secret
 * is missing): every plan lists its amount, none is on sale
 * (`payments_disabled`), no rail can charge and payments are not open.
 */
export function railNotReadyPlansView(extras: Partial<PlansView> = {}): PlansView {
  const view = plansView('roboapply');
  return {
    ...view,
    defaultSelection: null,
    paymentsOpen: false,
    checkout: { ...view.checkout, rails: [] },
    plans: view.plans.map((p) => (p.kind === 'free' ? p : { ...p, sellable: false, unsellableReason: 'payments_disabled' as const, isDefaultSelection: false, promotionCodes: false })),
    ...extras,
  };
}

/**
 * The same response with other facts: other refund numbers (merged over the
 * server's), a collecting entity, or published student prices.
 */
export function withBillingFacts<T extends PlansView>(
  view: T,
  facts: { refundPolicy?: Partial<RefundPolicyFacts>; collectingEntity?: string | null; studentOffer?: PlansBillingFacts['studentOffer'] | null } = {},
): T {
  const base = (view as { refundPolicy?: RefundPolicyFacts }).refundPolicy ?? REFUND_POLICY;
  return {
    ...view,
    refundPolicy: { ...base, ...(facts.refundPolicy ?? {}) },
    ...(facts.studentOffer !== undefined ? { studentOffer: facts.studentOffer } : {}),
    checkout: { ...view.checkout, collectingEntity: facts.collectingEntity ?? null },
  };
}

/** A response from a server that does not send the pricing facts yet (no `refundPolicy`, no `collectingEntity`). */
export function withoutBillingFacts<T extends PlansView>(view: T): T {
  const { refundPolicy: _policy, studentOffer: _offer, ...rest } = view as T & { refundPolicy?: unknown; studentOffer?: unknown };
  const { collectingEntity: _entity, ...checkout } = view.checkout as T['checkout'] & { collectingEntity?: unknown };
  return { ...rest, checkout } as unknown as T;
}

const bucket = (cap: number, used = 0, window: 'day' | 'week' = 'day', pro?: { proCap: number; proWindow: 'day' | 'week' }) => ({
  cap,
  window,
  used,
  remaining: cap - used,
  grantRemaining: 0,
  resetsAt: '2026-10-11T07:00:00.000Z',
  // The server sends what Pro would give only where that is more than `cap`.
  ...(pro && pro.proCap > cap ? pro : {}),
});

export function creditsResponse(over: Partial<CreditsResponse['summary']> = {}, practice: CreditsResponse['practice'] = { balance: 1 }): CreditsResponse {
  const pro = over.planProfile === 'pro';
  return {
    summary: {
      planKey: 'free',
      planProfile: 'free',
      legacyPlan: false,
      interval: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      timezone: 'UTC',
      upgradable: true,
      buckets: {
        fit_analysis: bucket(pro ? 200 : 10),
        tailor: bucket(pro ? 50 : 2, 1),
        cover_letter: bucket(pro ? 50 : 2),
        resume_check: bucket(pro ? 20 : 1),
        rewrite: bucket(pro ? 300 : 20),
        outreach: bucket(pro ? 50 : 3),
        assistant: bucket(pro ? 300 : 30),
        autofill: bucket(pro ? 100 : 20),
        ai_answer: bucket(pro ? 200 : 10),
        job_import: bucket(pro ? 50 : 10),
        ready_kits: bucket(pro ? 30 : 3, 0, 'week', { proCap: 30, proWindow: 'week' }),
        competitiveness: bucket(pro ? 3 : 1, 0, 'week'),
        contact_lookup: bucket(0),
      },
      entitlements: { saved_searches: pro ? 10 : 1, instant_alerts: 1, competitivenessFull: pro },
      ...over,
    } as CreditsResponse['summary'],
    practice,
  };
}

/** A checkout attempt key as the plan sheet makes it: a version 4 UUID (it also fits the server's `Idempotency-Key` pattern). */
export const ATTEMPT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Matches the second argument of a checkout call: this attempt's key. */
export function anAttempt(): unknown {
  return { attemptKey: expect.stringMatching(ATTEMPT_KEY_RE) };
}

/** The attempt keys a mocked checkout call received, in call order. */
export function attemptKeys(fn: { mock: { calls: unknown[][] } }): string[] {
  return fn.mock.calls.map((call) => (call[1] as { attemptKey: string }).attemptKey);
}

/** The brand wrapper renderUi adds (use it again for `rerender`). */
export function withBrand(ui: ReactElement, opts: { brand?: BrandId; flags?: Record<string, boolean> } = {}): ReactElement {
  const brand = opts.brand ?? 'roboapply';
  return (
    <BrandProvider brand={clientBrandFor(brand)} initialCapabilities={capsFor(brand, opts.flags ?? {})}>
      {ui}
    </BrandProvider>
  );
}

export function renderUi(ui: ReactElement, opts: { brand?: BrandId; locale?: string; flags?: Record<string, boolean> } = {}) {
  return renderWithProviders(withBrand(ui, opts), { intlLocale: opts.locale });
}

/** Phone width for the 375 px acceptance. */
export function atPhoneWidth(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
  window.dispatchEvent(new Event('resize'));
}
