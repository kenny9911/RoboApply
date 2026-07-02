// PlanCatalog — the shared Free/Starter/Growth grid used by both /plans
// (mode="in-app") and /choose-plan (mode="post-signup"). Presentational + props
// only, so we render it against fixtures (real en.json) and assert the CTA
// matrix: current-plan disable, upgrade/switch copy, region currency + Alipay,
// coming-soon, busy, and the post-signup free/paid actions.

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { PlanCatalog } from '../../components/v3/account/planCatalog';
import type { BillingPlanResponse, MockPlanKey } from '../../lib/api/account';

interface FixtureOpts {
  market?: 'cn' | 'other';
  currency?: 'CNY' | 'USD';
  method?: 'alipay' | 'stripe';
  currentTier?: MockPlanKey;
  purchasable?: boolean;
}

function buildPlan(opts: FixtureOpts = {}): BillingPlanResponse {
  const {
    market = 'other', currency = 'USD', method = 'stripe',
    currentTier = 'free', purchasable = true,
  } = opts;
  const mk = (key: MockPlanKey, credits: number, usdMinor: number, cnyMinor: number) => ({
    key, credits, usdMinor, cnyMinor,
    current: key === currentTier,
    purchasable: key === 'free' ? true : purchasable,
  });
  const isPaidStripe = currentTier !== 'free' && method === 'stripe';
  return {
    region: { market, currency, method, source: 'test' },
    current: {
      tier: currentTier,
      status: currentTier === 'free' ? 'inactive' : 'active',
      amountMinor: null, currency: null, currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      hasStripeCustomer: isPaidStripe,
      manualRenewal: method === 'alipay',
    },
    credits: { balance: 1, periodAllotment: 1, tier: currentTier },
    plans: [mk('free', 1, 0, 0), mk('starter', 10, 1500, 1900), mk('growth', 28, 2900, 4500)],
    stripeConfigured: true,
    alipayConfigured: true,
  };
}

const noop = () => {};

function renderCatalog(plan: BillingPlanResponse, overrides: Partial<React.ComponentProps<typeof PlanCatalog>> = {}) {
  const onSelectPaid = vi.fn();
  const onSelectFree = vi.fn();
  const onCancel = vi.fn();
  const utils = renderWithProviders(
    <PlanCatalog
      plan={plan}
      busy={false}
      mode="in-app"
      onSelectPaid={onSelectPaid}
      onSelectFree={onSelectFree}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onSelectPaid, onSelectFree, onCancel };
}

describe('PlanCatalog', () => {
  it('renders all three tiers with Growth flagged "Most popular"', () => {
    renderCatalog(buildPlan());
    // "Free" is both the tier label and the price, so anchor on the unique CTAs.
    expect(screen.getByRole('button', { name: /Your plan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upgrade to Starter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upgrade to Growth/i })).toBeInTheDocument();
    expect(screen.getByText(/Most popular/i)).toBeInTheDocument();
  });

  it('never references the recruiter-only --jb-surface token (RoboApply has no such var)', () => {
    const { container } = renderCatalog(buildPlan());
    expect(container.innerHTML).not.toContain('jb-surface');
  });

  describe('mode="in-app"', () => {
    it('on Free: Free card is the disabled "Your plan", paid cards offer "Upgrade to …"', () => {
      const { onSelectPaid } = renderCatalog(buildPlan({ currentTier: 'free' }));
      expect(screen.getByRole('button', { name: /Your plan/i })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /Upgrade to Starter/i }));
      expect(onSelectPaid).toHaveBeenCalledWith('starter');
      fireEvent.click(screen.getByRole('button', { name: /Upgrade to Growth/i }));
      expect(onSelectPaid).toHaveBeenCalledWith('growth');
    });

    it('on Starter: Starter is the disabled "Current plan"; Free offers "Downgrade"; Growth "Upgrade"', () => {
      const { onCancel } = renderCatalog(buildPlan({ currentTier: 'starter' }));
      expect(screen.getByRole('button', { name: /Current plan/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Upgrade to Growth/i })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: /Downgrade/i }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('on Growth: lower-priced Starter is a "Switch to Starter" target', () => {
      const { onSelectPaid } = renderCatalog(buildPlan({ currentTier: 'growth' }));
      expect(screen.getByRole('button', { name: /Current plan/i })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /Switch to Starter/i }));
      expect(onSelectPaid).toHaveBeenCalledWith('starter');
    });

    it('uses the Alipay CTA in the RMB region', () => {
      renderCatalog(buildPlan({ market: 'cn', currency: 'CNY', method: 'alipay', currentTier: 'free' }));
      expect(screen.getAllByRole('button', { name: /Pay with Alipay/i }).length).toBe(2);
    });

    it('shows disabled "Coming soon" for non-purchasable paid tiers', () => {
      const { onSelectPaid } = renderCatalog(buildPlan({ purchasable: false }));
      const comingSoon = screen.getAllByRole('button', { name: /Coming soon/i });
      expect(comingSoon.length).toBe(2);
      comingSoon.forEach((b) => expect(b).toBeDisabled());
      fireEvent.click(comingSoon[0]);
      expect(onSelectPaid).not.toHaveBeenCalled();
    });

    it('disables every CTA while busy', () => {
      renderCatalog(buildPlan({ currentTier: 'free' }), { busy: true });
      expect(screen.getByRole('button', { name: /Upgrade to Starter/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Upgrade to Growth/i })).toBeDisabled();
    });
  });

  describe('mode="post-signup"', () => {
    it('Free card advances via onSelectFree; paid cards read "Choose …"', () => {
      const { onSelectFree, onSelectPaid } = renderCatalog(
        buildPlan({ currentTier: 'free' }),
        { mode: 'post-signup' },
      );
      fireEvent.click(screen.getByRole('button', { name: /Start free/i }));
      expect(onSelectFree).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: /Choose Starter/i }));
      expect(onSelectPaid).toHaveBeenCalledWith('starter');
    });

    it('does not show any "Current plan" / "Upgrade" copy at signup', () => {
      renderCatalog(buildPlan({ currentTier: 'free' }), { mode: 'post-signup' });
      expect(screen.queryByText(/Current plan/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Upgrade to/i)).not.toBeInTheDocument();
    });
  });
});
