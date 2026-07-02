'use client';

// components/v3/account/billing.tsx
//
// Billing centerpiece for the mock-interview credit product:
//   - TierBadge          free | starter | growth (+ legacy premium*) mono pill
//   - CreditsCard        mock-interview credit balance + monthly allotment
//   - CurrentPlanCard    tier · price (region currency) · status · renewal/expiry
//   - RegionToggle       USD ⇄ RMB (detection can be wrong; user can switch)
//   - BillingHistoryLink small link to the invoice history page
//
// The Free/Starter/Growth plan grid moved to ./planCatalog.tsx (<PlanCatalog>),
// shared by both /plans and /choose-plan. money()/fmtCredits() live in ./format.
//
// VALUE framing: the only $/¥ shown is the user's OWN price. No cost / margin.

import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { IconBolt, IconFile, IconList } from '../primitives/Iconset';
import { Panel } from './sections';
import { money, fmtCredits } from './format';
import type {
  AccountTier,
  BillingPlanResponse,
} from '../../../lib/api/account';

// ─── Formatting ───────────────────────────────────────────────────────────────
// money() + fmtCredits() are shared via ./format (also used by planCatalog.tsx).

function formatDate(locale: string, iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

// ─── TierBadge ────────────────────────────────────────────────────────────────

const TIER_STYLE: Record<string, { bg: string; color: string; border: string }> = {
  free: { bg: 'var(--surface-2)', color: 'var(--text-2)', border: 'var(--rule)' },
  starter: { bg: 'var(--accent-soft)', color: 'var(--accent-text)', border: 'var(--accent-text)' },
  growth: { bg: 'var(--violet-soft)', color: 'var(--violet)', border: 'var(--violet)' },
  premium: { bg: 'var(--accent-soft)', color: 'var(--accent-text)', border: 'var(--accent-text)' },
  premium_plus: { bg: 'var(--violet-soft)', color: 'var(--violet)', border: 'var(--violet)' },
};

export function TierBadge({ tier, children }: { tier: AccountTier; children: React.ReactNode }) {
  const s = TIER_STYLE[tier] ?? TIER_STYLE.free;
  return (
    <span
      style={{
        fontFamily: 'var(--mono)', fontSize: '10px', fontWeight: 600, padding: '3px 9px',
        borderRadius: '99px', letterSpacing: '0.02em', textTransform: 'uppercase',
        background: s.bg, color: s.color, border: `1px solid ${s.border}`, whiteSpace: 'nowrap',
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

// ─── StatusPill ───────────────────────────────────────────────────────────────

function StatusPill({ status, label }: { status: string; label: string }) {
  const s = status.toLowerCase();
  const tone =
    s === 'active' || s === 'trialing'
      ? { bg: 'var(--ok-soft)', color: 'var(--ok)' }
      : s === 'past_due' || s === 'unpaid' || s === 'incomplete'
        ? { bg: 'var(--warn-soft)', color: 'var(--warn)' }
        : { bg: 'var(--surface-2)', color: 'var(--text-2)' };
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: '10px', fontWeight: 600, padding: '3px 9px',
      borderRadius: '99px', textTransform: 'uppercase', background: tone.bg, color: tone.color,
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>
      <span aria-hidden="true">●</span>{label}
    </span>
  );
}

function statusLabel(t: (k: string) => string, status: string): string {
  const s = status.toLowerCase();
  if (s === 'past_due' || s === 'unpaid' || s === 'incomplete') return t('billing.current.status.pastDue');
  if (s === 'canceled' || s === 'cancelled') return t('billing.current.status.canceled');
  return t('billing.current.status.active');
}

// ─── CreditsCard ──────────────────────────────────────────────────────────────

export function CreditsCard({ credits }: { credits: BillingPlanResponse['credits'] }) {
  const t = useTranslations('account');
  const allot = credits.periodAllotment ?? 0;
  const pct = allot > 0 ? Math.max(0, Math.min(100, (credits.balance / allot) * 100)) : 0;
  return (
    <Panel style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--accent-text)' }}><IconBolt size={18} /></span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{t('credits.title')}</span>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text-2)' }}>
          <b style={{ color: 'var(--text)', fontSize: 26 }}>{fmtCredits(credits.balance)}</b>
          {allot > 0 ? <span> / {fmtCredits(allot)}</span> : null} {t('credits.unit')}
        </div>
      </div>
      {allot > 0 ? (
        <div style={{ height: 8, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--grad-brand)', borderRadius: 99 }} />
        </div>
      ) : null}
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>{t('credits.note')}</div>
    </Panel>
  );
}

// ─── CurrentPlanCard ──────────────────────────────────────────────────────────

interface CurrentPlanCardProps {
  plan: BillingPlanResponse;
  onManageBilling: () => void;
  onCancel: () => void;
  managing: boolean;
  canceling: boolean;
}

export function CurrentPlanCard({ plan, onManageBilling, onCancel, managing, canceling }: CurrentPlanCardProps) {
  const t = useTranslations('account');
  const locale = useLocale();
  const { current } = plan;
  const price = current.amountMinor != null && current.currency
    ? money(locale, current.amountMinor, current.currency)
    : null;
  const renewDate = formatDate(locale, current.currentPeriodEnd);
  const isPaid = current.tier !== 'free';

  return (
    <Panel style={{ position: 'relative', overflow: 'hidden', boxShadow: 'var(--shadow-lift)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      <span aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'var(--grad-brand)' }} />
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '26px', fontWeight: 600, letterSpacing: '-0.03em' }}>{tierLabel(t, current.tier)}</span>
          <StatusPill status={current.status} label={statusLabel(t, current.status)} />
        </div>
        {price ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: '15px', color: 'var(--text-2)' }}>
            <b style={{ color: 'var(--text)', fontSize: '22px' }}>{price}</b> {t('plan.perMonth')}
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--mono)', fontSize: '15px', color: 'var(--muted)' }}>{t('plan.freeForever')}</div>
        )}
        {renewDate ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--muted)', marginTop: 10 }}>
            {current.cancelAtPeriodEnd
              ? t('billing.current.cancelsAt', { date: renewDate })
              : current.manualRenewal
                ? t('billing.current.expiresAt', { date: renewDate })
                : t('billing.current.renews', { date: renewDate })}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {current.hasStripeCustomer ? (
          <Btn variant="primary" onClick={onManageBilling} disabled={managing} icon={<IconList size={15} />}>
            {t('billing.manage')}
          </Btn>
        ) : null}
        {isPaid && current.hasStripeCustomer && !current.cancelAtPeriodEnd ? (
          <Btn variant="ghost" onClick={onCancel} disabled={canceling}>{t('billing.cancel')}</Btn>
        ) : null}
      </div>
    </Panel>
  );
}

// ─── RegionToggle ─────────────────────────────────────────────────────────────

export function RegionToggle({ region, onChange }: { region: 'cn' | 'other'; onChange: (r: 'cn' | 'other') => void }) {
  const t = useTranslations('account');
  const opt = (val: 'cn' | 'other', label: string) => {
    const active = region === val;
    return (
      <button
        type="button"
        onClick={() => onChange(val)}
        aria-pressed={active}
        style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 99,
          border: `1px solid ${active ? 'var(--accent-text)' : 'var(--rule)'}`,
          background: active ? 'var(--accent-soft)' : 'transparent',
          color: active ? 'var(--accent-text)' : 'var(--text-2)', cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('region.label')}</span>
      {opt('other', t('region.intl'))}
      {opt('cn', t('region.cn'))}
    </div>
  );
}

// ─── BillingHistoryLink ───────────────────────────────────────────────────────

export function BillingHistoryLink() {
  const t = useTranslations('account');
  return (
    <Panel style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-2)', fontSize: '13px' }}>
        <span style={{ color: 'var(--muted)' }}><IconFile size={16} /></span>
        {t('billing.summaryNote')}
      </div>
      <Link href="/account/billing/history" style={{ textDecoration: 'none' }}>
        <Btn variant="ghost">{t('billing.viewHistory')} →</Btn>
      </Link>
    </Panel>
  );
}
