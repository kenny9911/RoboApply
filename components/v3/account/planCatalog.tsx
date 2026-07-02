'use client';

// components/v3/account/planCatalog.tsx
//
// <PlanCatalog> — the single, canonical Free / Starter / Growth plan-card grid
// for the mock-interview credit product. Consolidates the two formerly-divergent
// PlanCard implementations (the inline one in app/choose-plan/page.tsx and the
// one inside billing.tsx's PlanPicker) behind one `mode` prop:
//
//   mode="in-app"      → /plans + (history) /account upgrade surface. Honors the
//                        user's current tier: current card disabled, free card
//                        downgrades a Stripe sub, paid cards read "Upgrade to X"
//                        / "Switch to X" by rank.
//   mode="post-signup" → /choose-plan welcome moment. No current-tier branches;
//                        free card = "Start free" (advance into the product),
//                        paid card = "Choose X".
//
// PRESENTATIONAL + interaction-wiring only: it owns NO data query, NO region
// state, NO router. The host page fetches the plan (useBillingPlan), renders the
// RegionToggle, and decides Stripe-vs-Alipay + the post-checkout `next` target,
// passing handlers in. That lets the same component serve a chromeless top-level
// page and an in-shell page with zero shell logic leaking.
//
// VALUE framing: only the user's own price is shown (no cost/margin), matching
// billing.tsx. Card styling reuses the cockpit CSS var tokens + the global
// .ra-plan-grid / .ra-plan-cta classes (styles/v3-account.css).

import { useLocale, useTranslations } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { IconBolt, IconCheck } from '../primitives/Iconset';
import { tierLabel } from './billing';
import { money, fmtCredits } from './format';
import type { BillingPlanResponse, BillingPlanItem, MockPlanKey } from '../../../lib/api/account';

export type PlanCatalogMode = 'in-app' | 'post-signup';

export interface PlanCatalogProps {
  /** Already-fetched plan success state (region + current + plans[]). */
  plan: BillingPlanResponse;
  /** Any checkout / alipay / cancel mutation in flight → disables every CTA. */
  busy: boolean;
  mode: PlanCatalogMode;
  /** Caller routes to Stripe vs Alipay (by region.method) and sets `next`. */
  onSelectPaid: (tier: 'starter' | 'growth') => void;
  /** post-signup: advance into the product. in-app: unused (no-op). */
  onSelectFree: () => void;
  /** in-app: downgrade an active Stripe sub to Free (cancel-at-period-end). */
  onCancel: () => void;
}

// Render order + tier rank (rank drives the in-app "Upgrade / Switch" copy).
// Legacy premium/premium_plus map onto the starter/growth ranks so a legacy
// subscriber still gets sensible labels (they have no current card in the grid).
const PLAN_ORDER: MockPlanKey[] = ['free', 'starter', 'growth'];
const RANK: Record<string, number> = { free: 0, starter: 1, premium: 1, growth: 2, premium_plus: 2 };

function planFeatures(t: (k: string, v?: any) => string, key: MockPlanKey, credits: number): string[] {
  if (key === 'free') {
    return [t('plan.feature.creditsMonthly', { n: credits }), t('plan.feature.mockInterviews'), t('plan.feature.resumeTailors')];
  }
  if (key === 'starter') {
    return [t('plan.feature.creditsMonthly', { n: credits }), t('plan.feature.everythingFree'), t('plan.feature.fullReports'), t('plan.feature.allInterviewTypes')];
  }
  return [t('plan.feature.creditsMonthly', { n: credits }), t('plan.feature.everythingStarter'), t('plan.feature.toneSteering'), t('plan.feature.prioritySupport')];
}

function PlanCard({
  item, plan, busy, mode, onSelectPaid, onSelectFree, onCancel,
}: {
  item: BillingPlanItem;
  plan: BillingPlanResponse;
  busy: boolean;
  mode: PlanCatalogMode;
  onSelectPaid: (t: 'starter' | 'growth') => void;
  onSelectFree: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('account');
  const tp = useTranslations('plans');
  const tc = useTranslations('choosePlan');
  const locale = useLocale();
  const { region, current } = plan;

  const isFree = item.key === 'free';
  const recommended = item.key === 'growth';
  const isCurrent = mode === 'in-app' && item.current;
  const blocked = !isFree && !item.purchasable;
  const amountMinor = region.currency === 'CNY' ? item.cnyMinor : item.usdMinor;
  const price = isFree ? t('plan.freePrice') : money(locale, amountMinor, region.currency);
  const features = planFeatures(t, item.key, item.credits);

  const accent =
    item.key === 'starter'
      ? { color: 'var(--accent-text)', bg: 'var(--accent-soft)', border: 'var(--accent-text)' }
      : item.key === 'growth'
        ? { color: 'var(--violet)', bg: 'var(--violet-soft)', border: 'var(--violet)' }
        : { color: 'var(--text-2)', bg: 'var(--surface-2)', border: 'var(--rule)' };

  const cta = buildCta();

  return (
    <div
      style={{
        border: `1px solid ${isCurrent ? 'var(--accent-text)' : recommended ? 'var(--violet)' : 'var(--rule)'}`,
        background: 'var(--surface)', borderRadius: 16, padding: '24px 22px', display: 'flex',
        flexDirection: 'column', position: 'relative', minHeight: 360,
        boxShadow: isCurrent ? 'var(--shadow-ring)' : undefined,
      }}
      aria-label={recommended ? `${tierLabel(t, item.key)} · ${t('plan.mostPopular')}` : undefined}
    >
      {recommended ? (
        <span
          className="ra-plan-pop"
          style={{
            position: 'absolute', top: -10, right: 18, fontFamily: 'var(--mono)', fontSize: '9.5px',
            fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: '#fff', padding: '4px 10px', borderRadius: '99px', boxShadow: '0 4px 14px -4px var(--violet-glow)',
          }}
        >{t('plan.mostPopular')}</span>
      ) : null}

      <div style={{ fontSize: '18px', fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 14 }}>{tierLabel(t, item.key)}</div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, fontFamily: 'var(--mono)' }}>
        <span style={{ fontSize: '36px', fontWeight: 600, letterSpacing: '-0.04em', color: 'var(--text)' }}>{price}</span>
        {!isFree ? <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{t('plan.perMonth')}</span> : null}
      </div>

      <div style={{
        fontFamily: 'var(--mono)', fontSize: '12px', borderRadius: 9, padding: '8px 12px', margin: '18px 0',
        textAlign: 'center', fontWeight: 600, ...accent, border: `1px solid ${accent.border}`,
      }}>
        {t('plan.creditsCap', { n: fmtCredits(item.credits) })}
      </div>

      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 22, flex: 1, padding: 0 }}>
        {features.map((f, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: '13px', color: 'var(--text-2)' }}>
            <span style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent-text)' }}><IconCheck size={15} /></span>
            {f}
          </li>
        ))}
      </ul>
      {cta}
    </div>
  );

  function buildCta(): React.ReactNode {
    // Paid tier not yet sellable → "Coming soon" overrides everything.
    if (!isFree && blocked) {
      return <Btn className="ra-plan-cta" variant="primary" disabled title={t('plan.comingSoon')}>{t('plan.comingSoon')}</Btn>;
    }

    // The user's active tier (in-app only). Free shows "Your plan", paid "Current plan".
    if (isCurrent) {
      return <Btn className="ra-plan-cta" disabled>{isFree ? tp('cta.yourFreePlan') : t('plan.current')}</Btn>;
    }

    // ── Post-signup welcome moment: no current-tier logic ──
    if (mode === 'post-signup') {
      if (isFree) {
        return <Btn className="ra-plan-cta" variant="ghost" disabled={busy} onClick={onSelectFree}>{tc('selectFree')}</Btn>;
      }
      const label = region.method === 'alipay' ? t('plan.subscribeAlipay') : tc('selectPaid', { plan: tierLabel(t, item.key) });
      return (
        <Btn className="ra-plan-cta" variant={recommended ? 'violet' : 'primary'} disabled={busy}
          onClick={() => onSelectPaid(item.key as 'starter' | 'growth')} icon={<IconBolt size={15} />}>
          {label}
        </Btn>
      );
    }

    // ── In-app (/plans, /account upgrade) ──
    if (isFree) {
      // Not current → the user is on a paid tier. Stripe auto-renew → "Downgrade"
      // (cancel-at-period-end); Alipay one-time pass just lapses (no action).
      const paidStripe = current.tier !== 'free' && current.hasStripeCustomer;
      return paidStripe
        ? <Btn className="ra-plan-cta" variant="ghost" disabled={busy} onClick={onCancel}>{t('plan.downgrade')}</Btn>
        : <Btn className="ra-plan-cta" variant="ghost" disabled>{t('plan.freePrice')}</Btn>;
    }

    const currentRank = RANK[current.tier] ?? 1;
    const targetRank = RANK[item.key] ?? 1;
    const isDowngrade = targetRank < currentRank;

    // Alipay = a one-time monthly pass; every paid pick is just a new purchase.
    if (region.method === 'alipay') {
      return (
        <Btn className="ra-plan-cta" variant={recommended ? 'violet' : 'primary'} disabled={busy}
          title={isDowngrade ? tp('cta.alipaySwitchNote') : undefined}
          onClick={() => onSelectPaid(item.key as 'starter' | 'growth')} icon={<IconBolt size={15} />}>
          {t('plan.subscribeAlipay')}
        </Btn>
      );
    }

    const label =
      targetRank > currentRank
        ? tp('cta.upgradeTo', { plan: tierLabel(t, item.key) })
        : isDowngrade
          ? tp('cta.switchTo', { plan: tierLabel(t, item.key) })
          : t('plan.subscribe');
    return (
      <Btn className="ra-plan-cta" variant={isDowngrade ? 'ghost' : recommended ? 'violet' : 'primary'} disabled={busy}
        onClick={() => onSelectPaid(item.key as 'starter' | 'growth')} icon={isDowngrade ? undefined : <IconBolt size={15} />}>
        {label}
      </Btn>
    );
  }
}

export function PlanCatalog({ plan, busy, mode, onSelectPaid, onSelectFree, onCancel }: PlanCatalogProps) {
  const ordered = [...plan.plans].sort((a, b) => PLAN_ORDER.indexOf(a.key) - PLAN_ORDER.indexOf(b.key));
  return (
    <div className="ra-plan-grid" style={{ marginTop: 16 }}>
      {ordered.map((item) => (
        <PlanCard
          key={item.key}
          item={item}
          plan={plan}
          busy={busy}
          mode={mode}
          onSelectPaid={onSelectPaid}
          onSelectFree={onSelectFree}
          onCancel={onCancel}
        />
      ))}
    </div>
  );
}
