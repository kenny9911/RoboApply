'use client';

// /settings — ONE page, sections chosen by the URL hash (/settings#billing).
// Not a destination of its own: Settings sits in the nav's lower group.
//
// Which sections exist, in what order and per brand, is the registry in
// components/features/settings/registry.ts (FND-6a; PRODUCT_PLAN.md §3.4):
//
//   Account        IdentitySection                       preferences (draft)
//   Sign-in and security  SecurityCard                   account API
//   Notifications  NotifSection                          preferences (draft)
//   Plan and billing  the billing stack                  billing API
//   Credits        CreditsCard                           billing API
//   Privacy and data  DataSection                        preferences (draft)
//   Appearance     AppearanceSection                     localStorage (theme)
//   Your search    HuntSection + ResumeSection + BlocklistSection
//   Danger zone    DangerSection                         destructive modals
//   (+ consents, assistant, devices, connections, referrals, sensitive:
//    rendered by their owning areas once ready)
//
// This route renders the content that predates the clone; the frame
// (<SettingsPage>) renders the section row and picks the open section. Old
// deep links keep working: #notif → Notifications, #resume → Your search.
//
// Two independent write models live side by side and that is deliberate:
//
//   • The preference-backed sections share ONE draft + baseline + SaveBar.
//     `dirty` is a structural compare of { draft, seniorityIndex } against the
//     server baseline, so Save clears it and Discard restores it. On Save we
//     fire preferences.update with the full draft and goal.upsert with the
//     seniority + salary band.
//     FIELD SPLIT NOTE (contract): `seniority` + the salary band live on
//     `goal`. The band (salaryMinK/MaxK) is ALSO kept on the prefs draft for
//     the UI and mirrored to goal on save (goal stores absolute dollars; prefs
//     stores k).
//   • Appearance, billing and security write immediately — a theme, a Stripe
//     redirect and a password change have nothing to Discard.
//
// Post-checkout return: paid CTAs pass { next:'/settings', cancelNext:'/settings' }
// so Stripe/Alipay return here; the backend appends ?billing=success|cancel,
// which we surface as a banner, refetch on, and strip (to /settings#billing,
// so the section the user paid from stays open).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { SettingsPage, settingsHref, type SettingsRenderers } from '../../../components/features/settings';
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
  CurrencyNote,
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

export default function SettingsRoute() {
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

  // A section switch is a new screen: start it at the top rather than wherever
  // the previous section's scroll left off. Plain scrollTop writes, because
  // .main is the scrollport on desktop and the document is on phones.
  const onSectionChange = useCallback(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (main) main.scrollTop = 0;
    document.documentElement.scrollTop = 0;
  }, []);

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
      // On a successful return the subscription likely changed — refetch so the
      // now-current tier flips to a disabled "Current plan".
      if (flag === 'success') void planQ.refetch();
      // Strip the param so a refresh doesn't re-show the banner; the hash
      // keeps the billing section open.
      router.replace(settingsHref('billing'));
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

  // ── Loading guard for the preference-backed sections ─────────────────
  const loading = prefsQuery.isLoading || !draft || !options;

  const name = (profile?.name as string) || user?.name || user?.email || '';
  const email = (profile?.email as string) || user?.email || '';

  const renderers: SettingsRenderers =
    loading || !draft || !options
      ? {}
      : {
          account: () => <IdentitySection p={draft} set={set} name={name} email={email} />,
          security: () =>
            profileQ.data ? (
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
            ) : profileQ.isError ? (
              <BillingError onRetry={() => void profileQ.refetch()} />
            ) : (
              <p className="pref-sub">{t('loading')}</p>
            ),
          notifications: () => <NotifSection p={draft} set={set} />,
          billing: () => (
            <>
              <PrefHeader eyebrow={t('nav.billing')} title={t('billing.title')} sub={t('billing.sub')} />
              {billingBanner ? (
                <div
                  role="status"
                  className="ra-settings-banner"
                  style={{
                    border: `1px solid ${billingBanner === 'success' ? 'var(--ok)' : 'var(--rule)'}`,
                    background: billingBanner === 'success' ? 'var(--ok-subtle)' : 'var(--surface)',
                    color: billingBanner === 'success' ? 'var(--ok)' : 'var(--text-2)',
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
              ) : null}

              {checkoutError ? (
                <div
                  role="alert"
                  className="ra-settings-banner"
                  style={{ border: '1px solid var(--warn)', background: 'var(--warn-subtle)', color: 'var(--warn)' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <IconX size={16} />
                    {t('billing.checkout_failed')}
                  </span>
                  <button
                    type="button"
                    aria-label={t('billing.checkout.dismiss')}
                    onClick={() => setCheckoutError(false)}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'grid' }}
                  >
                    <IconX size={15} />
                  </button>
                </div>
              ) : null}

              {planQ.isError ? (
                <BillingError onRetry={() => void planQ.refetch()} />
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

                  {/* Which currency is a location rule — mainland China pays
                   *  RMB by Alipay, everyone else US dollars by card — and the
                   *  API has already applied it. This names it above the grid
                   *  whose prices it explains, and offers the other market for
                   *  when the location guess is wrong. */}
                  <CurrencyNote region={planQ.data.region} onSwitch={setRegionOverride} />

                  {!planQ.data.stripeConfigured && !planQ.data.alipayConfigured ? (
                    <p
                      role="status"
                      style={{ margin: '12px 0 0', fontSize: 'var(--fs-meta)', color: 'var(--text-muted)', textAlign: 'center' }}
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
          ),
          credits: () =>
            planQ.isError ? (
              <BillingError onRetry={() => void planQ.refetch()} />
            ) : planQ.isLoading || !planQ.data ? (
              <p className="pref-sub">{t('loading')}</p>
            ) : (
              <CreditsCard credits={planQ.data.credits} />
            ),
          privacy: () => <DataSection p={draft} set={set} />,
          appearance: () => <AppearanceSection />,
          search: () => (
            <>
              <HuntSection
                p={draft}
                set={set}
                options={options}
                seniorityIndex={seniorityIndex}
                setSeniorityIndex={setSeniorityIndex}
              />
              <ResumeSection p={draft} set={set} resumes={resumesQuery.data?.resumes ?? []} />
              <BlocklistSection p={draft} set={set} />
            </>
          ),
          danger: () => <DangerSection onReset={discard} accountEmail={email} />,
        };

  return (
    <SettingsPage
      loading={loading}
      renderers={renderers}
      onSectionChange={onSectionChange}
      // Save bar — appears on dirty, clears on save/discard. Only the
      // preference-backed sections can make it appear.
      footer={dirty ? <SaveBar saving={saving} onDiscard={discard} onSave={save} /> : null}
    />
  );
}

/** The billing/account load failure: say what happened and what to do next. */
function BillingError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('settings');
  return (
    <Panel>
      <div role="alert" style={{ fontSize: 'var(--fs-body)', fontWeight: 600, marginBottom: 4 }}>
        {t('error.title')}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-meta)', color: 'var(--text-2)' }}>{t('error.body')}</p>
      <Btn variant="primary" onClick={onRetry}>
        {t('error.retry')}
      </Btn>
    </Panel>
  );
}
