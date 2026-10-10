'use client';

// components/v3/account/billing.tsx
//
// What is left of the pre-clone billing pieces: the plan pill.
//   - TierBadge   free | starter | growth (+ legacy premium*) pill
//   - tierLabel   its label from the `settings.plan.*` keys
//
// The plan grid (PlanCatalog), CurrentPlanCard, CreditsCard, CurrencyNote and
// BillingHistoryLink are gone (INT-12): /settings#billing and #credits render
// components/features/credits (WP-21b), and no route imported the old pieces.

import type { AccountTier } from '../../../lib/api/account';

// ─── TierBadge ────────────────────────────────────────────────────────────────

const TIER_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  free: { bg: 'var(--surface-2)', color: 'var(--text-2)', border: 'var(--rule)' },
  starter: { bg: 'var(--action-subtle)', color: 'var(--action)', border: 'var(--action)' },
  growth: { bg: 'var(--violet-soft)', color: 'var(--violet)', border: 'var(--violet)' },
  premium: { bg: 'var(--action-subtle)', color: 'var(--action)', border: 'var(--action)' },
  premium_plus: { bg: 'var(--violet-soft)', color: 'var(--violet)', border: 'var(--violet)' },
};

export function TierBadge({ tier, children }: { tier: AccountTier; children: React.ReactNode }) {
  const s = TIER_STYLE[tier] ?? TIER_STYLE.free;
  return (
    <span
      style={{
        fontSize: 'var(--fs-label)', fontWeight: 600, padding: '3px 9px',
        borderRadius: '99px', background: s.bg, color: s.color, border: `1px solid ${s.border}`, whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function tierLabel(t: (k: string) => string, tier: string): string {
  if (tier === 'starter') return t('plan.starter');
  if (tier === 'growth') return t('plan.growth');
  if (tier === 'premium') return t('plan.premium');
  if (tier === 'premium_plus') return t('plan.premiumPlus');
  return t('plan.free');
}
