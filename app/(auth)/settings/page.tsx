'use client';

// /settings — ONE page, seven sections. Not a destination.
//
// This replaces four routes: /preferences (eight screens), /plans, /account,
// and the /account danger tail. OVERHAUL_RULINGS D2: there are exactly four
// destinations (/jobs, /resume, /applications, /practice) and everything a user
// only visits when something is wrong lives behind the avatar menu, here.
//
// Sections, in order — the left rail and the mobile section list read from the
// same SECTIONS array, so the two can never drift:
//
//   Your search      HuntSection + BlocklistSection      preferences + goal
//   Resume           ResumeSection                       preferences
//   Notifications    NotifSection                        preferences
//   Appearance       AppearanceSection                   localStorage (theme)
//   Plan and billing the /plans billing stack            billing API
//   Account          IdentitySection + DataSection + SecurityCard
//   Danger zone      DangerSection                       destructive modals
//
// Two independent write models live side by side and that is deliberate:
//
//   • The preference-backed sections share ONE draft + baseline + SaveBar,
//     inherited unchanged from /preferences. `dirty` is a structural compare of
//     { draft, seniorityIndex } against the server baseline, so Save clears it
//     and Discard restores it. On Save we fire preferences.update with the full
//     draft and goal.upsert with the seniority + salary band.
//     FIELD SPLIT NOTE (contract): `seniority` + the salary band live on
//     `goal`. The band (salaryMinK/MaxK) is ALSO kept on the prefs draft for
//     the UI and mirrored to goal on save (goal stores absolute dollars; prefs
//     stores k).
//   • Appearance, billing and security write immediately — a theme, a Stripe
//     redirect and a password change have nothing to Discard.
//
// Post-checkout return: paid CTAs pass { next:'/settings', cancelNext:'/settings' }
// so Stripe/Alipay return here; the backend appends ?billing=success|cancel,
// which we surface as a banner, refetch on, and strip.

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { usePreferences, useUpdatePreferences } from '../../../hooks/usePreferences';
import { useGoal, useGoalMutation } from '../../../hooks/useGoal';
import { useResumeList } from '../../../hooks/useResumes';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { RoboApiError } from '../../../lib/api/client';
import {
  SaveBar,
  PrefHeader,
  IdentitySection,
  HuntSection,
  ResumeSection,
  AppearanceSection,
  NotifSection,
  BlocklistSection,
  DataSection,
  DangerSection,
} from '../../../components/v3/preferences';
import {
  Panel,
  PlanCatalog,
  RegionToggle,
  CurrentPlanCard,
  CreditsCard,
  BillingHistoryLink,
  SecurityCard,
} from '../../../components/v3/account';
import { Btn } from '../../../components/v3/primitives/Btn';
import { IconCheck, IconX } from '../../../components/v3/primitives/Iconset';
import {
  useAccountProfile,
  useBillingPlan,
  useCancelPlan,
  useChangePassword,
  useCheckout,
  useAlipayCheckout,
  usePortal,
  useSignOutAll,
} from '../../../hooks/useAccount';
import type {
  RAPreferences,
  RAPreferenceOptions,
  RASeniority,
  PreferencesUpdateBody,
} from '../../../lib/api/v2';

type SectionId =
  | 'search'
  | 'resume'
  | 'notif'
  | 'appearance'
  | 'billing'
  | 'account'
  | 'danger';

const SECTIONS: { id: SectionId; danger?: boolean }[] = [
  { id: 'search' },
  { id: 'resume' },
  { id: 'notif' },
  { id: 'appearance' },
  { id: 'billing' },
  { id: 'account' },
  { id: 'danger', danger: true },
];

// Map a numeric seniority index (Intern..Principal, 0..5) ↔ the RASeniority
// enum used by `goal`. The two vocabularies don't line up 1:1 (RASeniority has
// no "intern/junior/mid" and adds manager/director/vp/cxo) — this is a
// best-effort bridge, unchanged from /preferences.
const INDEX_TO_SENIORITY: RASeniority[] = [
  'ic', // 0 Intern    → ic
  'ic', // 1 Junior    → ic
  'ic', // 2 Mid       → ic
  'senior', // 3 Senior    → senior
  'staff', // 4 Staff     → staff
  'principal', // 5 Principal → principal
];

function seniorityToIndex(s: RASeniority | null): number {
  if (!s) return 3; // default Senior
  const i = INDEX_TO_SENIORITY.indexOf(s);
  return i >= 0 ? i : 3;
}

export default function SettingsPage() {
  // One namespace, one translator. This page used to hold three (`t`, `tp`,
  // `ta`) because it was three routes — /preferences, /plans and /account —
  // each with its own namespace. Wave 5 merged them into `settings`, so the
  // aliases were three names for the same function.
  const t = useTranslations('settings');
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useAuth();

  const prefsQuery = usePreferences();
  const goalQuery = useGoal();
  const resumesQuery = useResumeList();
  const { user, profile } = useAuth();

  const updatePrefs = useUpdatePreferences();
  const upsertGoal = useGoalMutation();

  const [section, setSection] = useState<SectionId>('search');

  // ── Preference draft + its server baseline (dirty compare + discard) ──
  const [draft, setDraft] = useState<RAPreferences | null>(null);
  const [baseline, setBaseline] = useState<RAPreferences | null>(null);
  const [seniorityIndex, setSeniorityIndex] = useState(3);
  const [baselineSeniority, setBaselineSeniority] = useState(3);

  const serverPrefs = prefsQuery.data?.preferences ?? null;
  const options: RAPreferenceOptions | null = prefsQuery.data?.options ?? null;
  const goalSeniority = goalQuery.data?.goal?.seniority ?? null;

  // Hydrate the draft once the server prefs arrive (and re-sync after a save,
  // when serverPrefs.updatedAt changes).
  useEffect(() => {
    if (!serverPrefs) return;
    setDraft(structuredClone(serverPrefs));
    setBaseline(structuredClone(serverPrefs));
  }, [serverPrefs]);

  // Seniority comes from goal; seed it once goal resolves.
  useEffect(() => {
    const idx = seniorityToIndex(goalSeniority);
    setSeniorityIndex(idx);
    setBaselineSeniority(idx);
  }, [goalSeniority]);

  // Deep path-set on the draft.
  const set = (path: string, value: unknown) => {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = structuredClone(cur) as unknown as Record<string, unknown>;
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        obj[keys[i]] = { ...(obj[keys[i]] as Record<string, unknown>) };
        obj = obj[keys[i]] as Record<string, unknown>;
      }
      obj[keys[keys.length - 1]] = value;
      return next as unknown as RAPreferences;
    });
  };

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return (
      JSON.stringify(draft) !== JSON.stringify(baseline) ||
      seniorityIndex !== baselineSeniority
    );
  }, [draft, baseline, seniorityIndex, baselineSeniority]);

  const saving = updatePrefs.isPending || upsertGoal.isPending;

  const discard = () => {
    if (baseline) setDraft(structuredClone(baseline));
    setSeniorityIndex(baselineSeniority);
  };

  const save = async () => {
    if (!draft || !baseline) return;
    // Send the whole draft (the API deep-merges; only changed fields matter).
    await updatePrefs.mutateAsync(draft as unknown as PreferencesUpdateBody);

    // Split write: seniority + salary band → goal. goal.upsert requires a
    // targetTitle; reuse the existing goal's, falling back to the first role
    // title so a first save doesn't throw.
    const currentGoal = goalQuery.data?.goal ?? null;
    const targetTitle =
      currentGoal?.targetTitle || draft.roleTitles[0] || 'Untitled role';
    try {
      await upsertGoal.mutateAsync({
        targetTitle,
        seniority: INDEX_TO_SENIORITY[seniorityIndex] ?? 'senior',
        targetSalaryMin: draft.salaryMinK * 1000,
        targetSalaryMax: draft.salaryMaxK * 1000,
      });
    } catch {
      // Goal write is best-effort; prefs already persisted.
    }

    setBaseline(structuredClone(draft));
    setBaselineSeniority(seniorityIndex);
  };

  // ── Billing (loaded lazily — only the billing section reads it) ───────
  const [regionOverride, setRegionOverride] = useState<'cn' | 'other' | null>(null);
  const planQ = useBillingPlan(regionOverride);
  const checkout = useCheckout();
  const alipay = useAlipayCheckout();
  const portal = usePortal();
  const cancelPlan = useCancelPlan();
  const [checkoutError, setCheckoutError] = useState(false);

  const [billingBanner, setBillingBanner] = useState<'success' | 'cancel' | null>(null);
  useEffect(() => {
    const flag = searchParams?.get('billing');
    if (flag === 'success' || flag === 'cancel') {
      setBillingBanner(flag);
      setSection('billing');
      // On a successful return the subscription likely changed — refetch so the
      // now-current tier flips to a disabled "Current plan".
      if (flag === 'success') void planQ.refetch();
      // Strip the param so a refresh doesn't re-show the banner.
      router.replace('/settings');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const onSelectPaid = (tier: 'starter' | 'growth') => {
    setCheckoutError(false);
    const mutation = planQ.data?.region.method === 'alipay' ? alipay : checkout;
    mutation.mutate(
      { tier, next: '/settings', cancelNext: '/settings' },
      {
        onSuccess: (res) => {
          window.location.href = res.url;
        },
        // The provider was unreachable or rejected the order. Surface it
        // instead of failing silently.
        onError: () => setCheckoutError(true),
      },
    );
  };

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

  // ── Account security ─────────────────────────────────────────────────
  const profileQ = useAccountProfile();
  const changePassword = useChangePassword();
  const signOutAll = useSignOutAll();
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [securityResetKey, setSecurityResetKey] = useState(0);

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
          const raw =
            err instanceof RoboApiError
              ? (err.payload as { code?: string } | undefined)?.code
              : undefined;
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

  // ── Loading / empty guard for the preference-backed sections ─────────
  if (prefsQuery.isLoading || !draft || !options) {
    return (
      <div className="pref">
        <div className="pref-body">
          <p className="pref-sub">{t('loading')}</p>
        </div>
      </div>
    );
  }

  const name = (profile?.name as string) || user?.name || user?.email || '';
  const email = (profile?.email as string) || user?.email || '';

  return (
    <div className="pref">
      {/* Left rail — the section list. Below 760px (the breakpoint where the
       *  app sidebar gives way to MobileNav) v3-preferences.css turns it into a
       *  sticky horizontal scroller above the body, so every section — plan
       *  changes, cancellation, account deletion — stays reachable on a phone.
       *  Before this page existed a phone user could reach none of them. */}
      <aside className="pref-rail">
        <div className="pref-rail-head">
          <div className="pref-rail-title">{t('title')}</div>
        </div>
        <nav className="pref-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`pref-nav-item ${section === s.id ? 'active' : ''} ${
                s.danger ? 'danger' : ''
              }`}
              onClick={() => setSection(s.id)}
            >
              {t(`nav.${s.id}`)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="pref-body">
        {section === 'search' && (
          <>
            <HuntSection
              p={draft}
              set={set}
              options={options}
              seniorityIndex={seniorityIndex}
              setSeniorityIndex={setSeniorityIndex}
            />
            <BlocklistSection p={draft} set={set} />
          </>
        )}

        {section === 'resume' && (
          <ResumeSection
            p={draft}
            set={set}
            resumes={resumesQuery.data?.resumes ?? []}
          />
        )}

        {section === 'notif' && <NotifSection p={draft} set={set} />}

        {section === 'appearance' && <AppearanceSection />}

        {section === 'billing' && (
          <>
            <PrefHeader
              eyebrow={t('nav.billing')}
              title={t('billing.title')}
              sub={t('billing.sub')}
            />

            {billingBanner ? (
              <div
                role="status"
                className="ra-settings-banner"
                style={{
                  border: `1px solid ${billingBanner === 'success' ? 'var(--ok)' : 'var(--rule)'}`,
                  background:
                    billingBanner === 'success' ? 'var(--ok-subtle)' : 'var(--surface)',
                  color: billingBanner === 'success' ? 'var(--ok)' : 'var(--text-2)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {billingBanner === 'success' ? <IconCheck size={16} /> : <IconX size={16} />}
                  {billingBanner === 'success'
                    ? t('billing.checkout.success')
                    : t('billing.checkout.cancel')}
                </span>
                <button
                  type="button"
                  aria-label={t('billing.checkout.dismiss')}
                  onClick={() => setBillingBanner(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'grid',
                  }}
                >
                  <IconX size={15} />
                </button>
              </div>
            ) : null}

            {checkoutError ? (
              <div
                role="alert"
                className="ra-settings-banner"
                style={{
                  border: '1px solid var(--warn)',
                  background: 'var(--warn-subtle)',
                  color: 'var(--warn)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <IconX size={16} />
                  {t('billing.checkout_failed')}
                </span>
                <button
                  type="button"
                  aria-label={t('billing.checkout.dismiss')}
                  onClick={() => setCheckoutError(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'grid',
                  }}
                >
                  <IconX size={15} />
                </button>
              </div>
            ) : null}

            {planQ.isError ? (
              <Panel>
                <div role="alert" style={{ fontSize: 'var(--fs-body)', fontWeight: 600, marginBottom: 4 }}>
                  {t('error.title')}
                </div>
                <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-meta)', color: 'var(--text-2)' }}>
                  {t('error.body')}
                </p>
                <Btn variant="primary" onClick={() => void planQ.refetch()}>
                  {t('error.retry')}
                </Btn>
              </Panel>
            ) : planQ.isLoading || !planQ.data ? (
              <p className="pref-sub">{t('loading')}</p>
            ) : (
              <>
                <CurrentPlanCard
                  plan={planQ.data}
                  onManageBilling={onManageBilling}
                  onCancel={() => cancelPlan.mutate()}
                  managing={portal.isPending}
                  canceling={cancelPlan.isPending}
                />
                <div style={{ marginTop: 16 }}>
                  <CreditsCard credits={planQ.data.credits} />
                </div>

                {/* Region toggle sits right above the grid whose prices it
                 *  controls. */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22 }}>
                  <RegionToggle
                    region={planQ.data.region.market}
                    onChange={setRegionOverride}
                  />
                </div>

                {!planQ.data.stripeConfigured && !planQ.data.alipayConfigured ? (
                  <p
                    role="status"
                    style={{
                      margin: '12px 0 0',
                      fontSize: 'var(--fs-meta)',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                    }}
                  >
                    {t('billing.payments_unavailable')}
                  </p>
                ) : null}

                <PlanCatalog
                  plan={planQ.data}
                  busy={checkout.isPending || alipay.isPending || cancelPlan.isPending}
                  mode="in-app"
                  onSelectPaid={onSelectPaid}
                  onSelectFree={() => {
                    /* no-op in-app; downgrade is per-card via onCancel */
                  }}
                  onCancel={() => cancelPlan.mutate()}
                />

                <BillingHistoryLink />
              </>
            )}
          </>
        )}

        {section === 'account' && (
          <>
            <IdentitySection p={draft} set={set} name={name} email={email} />
            <DataSection p={draft} set={set} />
            {profileQ.data ? (
              <SecurityCard
                hasPassword={profileQ.data.hasPassword}
                provider={profileQ.data.provider}
                changing={changePassword.isPending}
                signingOut={signOutAll.isPending}
                passwordError={passwordError}
                passwordSuccess={passwordSuccess}
                onChangePassword={onChangePassword}
                onSignOutEverywhere={onSignOutEverywhere}
                resetKey={securityResetKey}
              />
            ) : null}
          </>
        )}

        {section === 'danger' && (
          <DangerSection onReset={discard} accountEmail={email} />
        )}
      </div>

      {/* Save bar — appears on dirty, clears on save/discard. Only the
       *  preference-backed sections can make it appear. */}
      {dirty && <SaveBar saving={saving} onDiscard={discard} onSave={save} />}
    </div>
  );
}
