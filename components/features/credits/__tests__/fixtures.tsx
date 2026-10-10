// Test fixtures for the WP-21b credits/billing UI. Plans come from the real
// server catalog builder with test-mode env prices (the PRODUCT §6.3 test
// prices), so the UI is tested against the exact wire shape WP-21a sends.

import type { ReactElement } from 'react';

import { buildPlanViews } from '../../../../server/src/platform/billing/planViews';
import type { CreditsResponse } from '../../../../lib/api/contracts/credits';
import type { PlansView } from '../../../../lib/api/credits';
import type { BrandId } from '../../../../lib/brand/registry.generated';
import { BrandProvider } from '../../../../lib/brand/BrandProvider';
import { clientBrandFor } from '../../../../lib/brand/client';
import { capsFor } from '../../../../__tests__/shell/helpers';
import { renderWithProviders } from '../../../../__tests__/utils/renderWithProviders';

export const RA_ENV = {
  STRIPE_PRICE_PRO_WEEKLY: 'price_w',
  STRIPE_PRICE_PRO_WEEKLY_CENTS: '999',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_MONTHLY_CENTS: '2499',
  STRIPE_PRICE_PRO_QUARTERLY: 'price_q',
  STRIPE_PRICE_PRO_QUARTERLY_CENTS: '5999',
  STRIPE_PRICE_PRO_WEEK_PASS: 'price_p',
  STRIPE_PRICE_PRO_WEEK_PASS_CENTS: '699',
  STRIPE_PRICE_PRACTICE_PACK_5: 'price_5',
  STRIPE_PRICE_PRACTICE_PACK_5_CENTS: '999',
  STRIPE_PRICE_PRACTICE_PACK_15: 'price_15',
  STRIPE_PRICE_PRACTICE_PACK_15_CENTS: '2499',
};

export const GA_ENV = {
  CN_PRICE_PRO_WEEK_PASS_FEN: '1200',
  CN_PRICE_PRO_MONTHLY_FEN: '3900',
  CN_PRICE_PRO_QUARTERLY_FEN: '9900',
  CN_PRICE_PRACTICE_PACK_5_FEN: '2900',
  CN_PRICE_PRACTICE_PACK_15_FEN: '7900',
};

export function plansView(brand: BrandId = 'roboapply', env: Record<string, string> = brand === 'goapply' ? GA_ENV : RA_ENV, extras: Partial<PlansView> = {}): PlansView {
  // The full WP-21a `PlansResponse` (planViews.ts builds the plans the server sends).
  const { plans, defaultSelection } = buildPlanViews(brand, { env });
  return {
    plans,
    defaultSelection,
    currency: brand === 'goapply' ? 'CNY' : 'USD',
    paymentsOpen: brand !== 'goapply',
    checkout: { rails: brand === 'goapply' ? [] : ['stripe'], showWithdrawalWaiver: false, country: null, acknowledgementVersion: 'test' },
    fxReference: null,
    offers: [],
    ...extras,
  };
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
        autofill: bucket(pro ? 100 : 5),
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
