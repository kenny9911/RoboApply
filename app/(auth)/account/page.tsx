'use client';

// /account — User Account + Billing (Page B of the admin/billing spec).
//
// A single scrolling page with a sticky SectionNav pill row:
//   Profile · Billing · Usage · Security  (+ a Danger zone tail).
//
// State order mirrors app/(auth)/activity/page.tsx: header always first, then
// error → loading skeleton → success. The shell (Sidebar + Topbar +
// .main-inner) is provided by (auth)/layout.tsx — this renders inner content.
//
// Data: TanStack Query via hooks/useAccount.ts. Stripe redirects set
// window.location.href from the returned { url }. The ?billing=success|cancel
// return is surfaced as a dismissable banner, then the param is stripped.

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import Link from 'next/link';

import { PageHeader } from '../../../components/v3/primitives/PageHeader';
import { Btn } from '../../../components/v3/primitives/Btn';
import { Modal } from '../../../components/v3/primitives/Modal';
import { IconCheck, IconX } from '../../../components/v3/primitives/Iconset';
import {
  SectionNav,
  SecLabel,
  Panel,
  ProfileCard,
  CurrentPlanCard,
  CreditsCard,
  BillingHistoryLink,
  ActivityHeatmap,
  UsageMeter,
  RecentActivityList,
  SecurityCard,
  DangerZone,
  type AccountSectionId,
  type RecentActivityItem,
} from '../../../components/v3/account';
import {
  useAccountProfile,
  useAccountUsage,
  useBillingPlan,
  useCancelPlan,
  useChangePassword,
  useDeleteAccount,
  usePortal,
  useSignOutAll,
  useUpdateName,
} from '../../../hooks/useAccount';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import type { AccountTier } from '../../../lib/api/account';

// Local UTC tz for the usage call so the heatmap day buckets line up with the
// "Resets daily at midnight UTC" copy. (Provider pins next-intl timeZone=UTC.)
const USAGE_TZ = 'UTC';

export default function AccountPage() {
  const t = useTranslations('account');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();

  const profileQ = useAccountProfile();
  // Region is resolved by the backend here (no toggle on /account); price/plan
  // changes live on the dedicated /plans page. null → backend resolves region.
  const planQ = useBillingPlan(null);
  const usageQ = useAccountUsage({ tz: USAGE_TZ });

  const updateName = useUpdateName();
  const changePassword = useChangePassword();
  const signOutAll = useSignOutAll();
  const deleteAccount = useDeleteAccount();
  const portal = usePortal();
  const cancelPlan = useCancelPlan();

  // ── Stripe-return banner (?billing=success|cancel) ─────────────────
  const [billingBanner, setBillingBanner] = useState<'success' | 'cancel' | null>(null);
  useEffect(() => {
    const flag = searchParams?.get('billing');
    if (flag === 'success' || flag === 'cancel') {
      setBillingBanner(flag);
      // On a successful return, the subscription likely changed — refetch.
      if (flag === 'success') {
        void planQ.refetch();
        void profileQ.refetch();
      }
      // Strip the param so a refresh doesn't re-show the banner.
      router.replace('/account');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Password form error/success (mapped from RoboApiError.code) ────
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [securityResetKey, setSecurityResetKey] = useState(0);

  // ── Delete-account modal ───────────────────────────────────────────
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const labels: Record<AccountSectionId, string> = {
    profile: t('nav.profile'),
    billing: t('nav.billing'),
    usage: t('nav.usage'),
    security: t('nav.security'),
  };

  // ── Header (always first; stable frame across all states) ──────────
  const header = (
    <PageHeader
      eyebrow={t('eyebrow')}
      title={t('title')}
      accentWord={t('titleAccent')}
    />
  );

  const banner = billingBanner ? (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        marginBottom: 20,
        padding: '12px 16px',
        borderRadius: 'var(--r-md)',
        border: `1px solid ${billingBanner === 'success' ? 'var(--ok)' : 'var(--rule)'}`,
        background: billingBanner === 'success' ? 'var(--ok-soft)' : 'var(--surface)',
        color: billingBanner === 'success' ? 'var(--ok)' : 'var(--text-2)',
        fontSize: '13.5px',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {billingBanner === 'success' ? <IconCheck size={16} /> : <IconX size={16} />}
        {billingBanner === 'success' ? t('billing.checkout.success') : t('billing.checkout.cancel')}
      </span>
      <button
        type="button"
        aria-label={t('billing.checkout.dismiss')}
        onClick={() => setBillingBanner(null)}
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'grid' }}
      >
        <IconX size={15} />
      </button>
    </div>
  ) : null;

  // ── Error (any of the three core queries failed) ───────────────────
  const isError = profileQ.isError || planQ.isError || usageQ.isError;
  if (isError) {
    return (
      <>
        {header}
        <div
          role="alert"
          className="flex flex-col items-center gap-4 text-center"
          style={{
            border: '1px solid var(--rule)',
            background: 'var(--surface)',
            borderRadius: 'var(--r-xl)',
            padding: '52px 32px',
          }}
        >
          <p style={{ fontFamily: 'var(--sans)', fontSize: '18px', fontWeight: 600, color: 'var(--text)', margin: 0 }}>
            {t('error.title')}
          </p>
          <p style={{ color: 'var(--text-2)', fontSize: '14px', maxWidth: 420, margin: 0 }}>
            {t('error.body')}
          </p>
          <Btn
            variant="primary"
            onClick={() => {
              void profileQ.refetch();
              void planQ.refetch();
              void usageQ.refetch();
            }}
          >
            {t('error.retry')}
          </Btn>
        </div>
      </>
    );
  }

  // ── Loading skeleton (match final footprint) ───────────────────────
  if (profileQ.isLoading || planQ.isLoading || usageQ.isLoading || !profileQ.data || !planQ.data || !usageQ.data) {
    return (
      <>
        {header}
        <AccountSkeleton label={t('loading')} />
      </>
    );
  }

  const profile = profileQ.data;
  const plan = planQ.data;
  const usage = usageQ.data;

  // ── Handlers ───────────────────────────────────────────────────────
  const onManageBilling = () => {
    portal.mutate(undefined, {
      onSuccess: (res) => {
        window.location.href = res.url;
      },
      onError: (err) => {
        // 409 no_customer — gracefully do nothing visible beyond logging.
        if (err instanceof RoboApiError && err.code === 'not_found') return;
      },
    });
  };

  const onChangePassword = (currentPassword: string, newPassword: string) => {
    setPasswordError(null);
    setPasswordSuccess(false);
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setPasswordSuccess(true);
          setSecurityResetKey((k) => k + 1);
        },
        onError: (err) => {
          const code = err instanceof RoboApiError ? err.code : undefined;
          // Backend-specific codes arrive on err.payload.code in some shapes;
          // RoboApiError normalizes known ones, so match on message too.
          const raw = err instanceof RoboApiError ? (err.payload as any)?.code : undefined;
          if (raw === 'wrong_password') setPasswordError(t('security.error.wrongPassword'));
          else if (raw === 'no_password') setPasswordError(t('security.error.noPassword'));
          else if (raw === 'weak_password') setPasswordError(t('security.error.weakPassword'));
          else if (code === 'rate_limited') setPasswordError(t('security.error.rateLimited'));
          else setPasswordError(t('security.error.generic'));
        },
      },
    );
  };

  const onSignOutEverywhere = () => {
    signOutAll.mutate(undefined, {
      onSuccess: () => {
        auth.clear();
        router.replace('/login');
      },
    });
  };

  const onConfirmDelete = () => {
    setDeleteError(null);
    if (deleteConfirmEmail.trim().toLowerCase() !== profile.email.trim().toLowerCase()) {
      setDeleteError(t('danger.error.mismatch'));
      return;
    }
    if (!deleteReason.trim()) {
      setDeleteError(t('danger.error.reasonRequired'));
      return;
    }
    deleteAccount.mutate(deleteConfirmEmail.trim(), {
      onSuccess: () => {
        auth.clear();
        setDeleteOpen(false);
        router.replace('/login');
      },
      onError: (err) => {
        const raw = err instanceof RoboApiError ? (err.payload as any)?.code : undefined;
        if (raw === 'confirm_email_mismatch') setDeleteError(t('danger.error.mismatch'));
        else setDeleteError(t('danger.error.generic'));
      },
    });
  };

  // ── Derived display values ──────────────────────────────────────────
  const memberSinceLabel = formatMemberSince(locale, profile.memberSince, t);
  const tierLabelText = tierLabel(t, usage.tier);
  const recentItems = buildRecentItems(usage.byFeature, t);

  // ── Success ──────────────────────────────────────────────────────────
  return (
    <>
      {header}
      {banner}

      <SectionNav labels={labels} />

      {/* ── PROFILE ── */}
      <SecLabel id="profile">{t('profile.title')}</SecLabel>
      <ProfileCard
        name={profile.name}
        email={profile.email}
        provider={profile.provider}
        memberSinceLabel={memberSinceLabel}
        // The contract exposes no explicit email-verified flag; an
        // authenticated account (OAuth or confirmed-email signup) is treated
        // as verified, matching the mockup's unconditional "verified" tag.
        verified={true}
        saving={updateName.isPending}
        onSaveName={(name) => updateName.mutate(name)}
      />

      {/* ── BILLING ── */}
      <SecLabel id="billing">{t('billing.title')}</SecLabel>
      <CurrentPlanCard
        plan={plan}
        onManageBilling={onManageBilling}
        onCancel={() => cancelPlan.mutate()}
        managing={portal.isPending}
        canceling={cancelPlan.isPending}
      />
      <div style={{ marginTop: 16 }}>
        <CreditsCard credits={plan.credits} />
      </div>
      {/* Pricing + plan changes live on the dedicated /plans page now. This is a
       *  compact, tier-aware nudge into it (replaces the inline plan grid). */}
      {(() => {
        const isMax = plan.current.tier === 'growth';
        const k = (base: string) => `billing.explore.${base}${isMax ? 'Max' : ''}`;
        return (
          <Panel style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 3 }}>{t(k('title'))}</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{t(k('sub'))}</div>
            </div>
            <Link href="/plans" style={{ textDecoration: 'none' }}>
              <Btn variant="primary">{t(k('cta'))}</Btn>
            </Link>
          </Panel>
        );
      })()}
      <BillingHistoryLink />

      {/* ── USAGE ── */}
      <SecLabel id="usage">{t('usage.title')}</SecLabel>
      <div className="ra-usage-grid">
        <ActivityHeatmap days={usage.byDay} totalActions={usage.totalActions} />
        <UsageMeter
          features={usage.byFeature}
          cap={usage.dailyCap}
          tier={usage.tier}
          tierLabelText={tierLabelText}
        />
      </div>
      {recentItems.length > 0 ? <RecentActivityList items={recentItems} /> : null}

      {/* ── SECURITY ── */}
      <SecLabel id="security">{t('security.title')}</SecLabel>
      <SecurityCard
        hasPassword={profile.hasPassword}
        provider={profile.provider}
        changing={changePassword.isPending}
        signingOut={signOutAll.isPending}
        passwordError={passwordError}
        passwordSuccess={passwordSuccess}
        onChangePassword={onChangePassword}
        onSignOutEverywhere={onSignOutEverywhere}
        resetKey={securityResetKey}
      />

      {/* ── DANGER ZONE ── */}
      <SecLabel>{t('danger.title')}</SecLabel>
      <DangerZone onRequestDelete={() => setDeleteOpen(true)} />

      {/* ── Delete-account confirm modal ── */}
      <Modal
        open={deleteOpen}
        onClose={() => {
          if (!deleteAccount.isPending) setDeleteOpen(false);
        }}
        title={t('danger.deleteAccount')}
        description={t('danger.deleteDescription')}
        maxWidth="md"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleteAccount.isPending}>
              {t('danger.cancel')}
            </Btn>
            <Btn
              className="ra-btn-danger"
              onClick={onConfirmDelete}
              disabled={deleteAccount.isPending}
            >
              {t('danger.delete')}
            </Btn>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
              }}
            >
              {t('danger.confirmEmailLabel')}
            </label>
            <p style={{ fontSize: '12.5px', color: 'var(--text-2)', margin: 0 }}>
              {t('danger.confirmEmailHint', { email: profile.email })}
            </p>
            <input
              value={deleteConfirmEmail}
              onChange={(e) => setDeleteConfirmEmail(e.target.value)}
              autoComplete="off"
              className="ra-account-input"
              placeholder={profile.email}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--rule)',
                borderRadius: 9,
                padding: '10px 12px',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                fontSize: '13px',
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label
              style={{
                fontFamily: 'var(--mono)',
                fontSize: '11px',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
              }}
            >
              {t('danger.reasonLabel')}
            </label>
            <textarea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              rows={3}
              className="ra-account-input"
              placeholder={t('danger.reasonPlaceholder')}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--rule)',
                borderRadius: 9,
                padding: '10px 12px',
                color: 'var(--text)',
                fontFamily: 'var(--sans)',
                fontSize: '13px',
                resize: 'vertical',
              }}
            />
          </div>

          {deleteError ? (
            <p role="alert" style={{ color: 'var(--danger)', fontSize: '12.5px', margin: 0 }}>
              {deleteError}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function tierLabel(t: (k: string) => string, tier: AccountTier): string {
  if (tier === 'starter') return t('plan.starter');
  if (tier === 'growth') return t('plan.growth');
  if (tier === 'premium') return t('plan.premium');
  if (tier === 'premium_plus') return t('plan.premiumPlus');
  return t('plan.free');
}

function formatMemberSince(
  locale: string,
  iso: string,
  t: (k: string, v?: Record<string, string>) => string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let when = '';
  try {
    when = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(d);
  } catch {
    when = d.toLocaleDateString();
  }
  return t('profile.memberSince', { date: when });
}

/** Derive a short, positively-framed recent-activity list from the feature
 *  counts (the usage contract has no per-action feed). Top features first. */
function buildRecentItems(
  byFeature: { key: string; label: string; count: number }[],
  t: (k: string, v?: Record<string, string>) => string,
): RecentActivityItem[] {
  return byFeature
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((f) => ({
      id: f.key,
      time: String(f.count),
      body: <span>{t('usage.recentItem', { count: String(f.count), feature: f.label })}</span>,
    }));
}

// ─────────────────────────────────────────────────────────────────────
// Skeleton — shimmer footprint matching the final layout.
// ─────────────────────────────────────────────────────────────────────

function shimmer(): React.CSSProperties {
  return { background: 'var(--surface-2)', borderRadius: 8 };
}

function AccountSkeleton({ label }: { label: string }) {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label={label}>
      {/* nav pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 30 }}>
        {[64, 60, 58, 72].map((w, i) => (
          <div key={i} style={{ ...shimmer(), width: w, height: 30, borderRadius: 99 }} />
        ))}
      </div>
      {/* profile */}
      <div style={{ ...shimmer(), height: 108, marginBottom: 36 }} />
      {/* current plan */}
      <div style={{ ...shimmer(), height: 120, marginBottom: 16 }} />
      {/* credits card + "explore plans" strip (replaces the inline plan grid) */}
      <div style={{ ...shimmer(), height: 96, marginBottom: 16 }} />
      <div style={{ ...shimmer(), height: 72, marginBottom: 16 }} />
      {/* usage */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ ...shimmer(), height: 220 }} />
        <div style={{ ...shimmer(), height: 220 }} />
      </div>
    </div>
  );
}
