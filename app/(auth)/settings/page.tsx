'use client';

// /settings — ONE page, sections chosen by the URL hash (/settings#billing).
// Not a destination of its own: Settings sits in the nav's lower group.
//
// Which sections exist, in what order and per brand, is the registry in
// components/features/settings/registry.ts (FND-6a; PRODUCT_PLAN.md §3.4).
// What each section renders (INT-12 / WP-93 wiring):
//
//   Account               this route: IdentitySection       preferences (draft)
//                                                           + the account name
//                         + FinishSetupSettingsLine          frame (SECTION_EXTRAS)
//   Sign-in and security  this route: SecurityCard           account API
//                         + TwoFactorSettings                frame (SECTION_EXTRAS)
//                         + ChangePhoneSection on GoApply    frame (SECTION_EXTRAS)
//   Notifications         notifications SettingsSection      sectionComponents.ts
//   Plan and billing      credits SettingsSection            sectionComponents.ts
//   Credits               credits SettingsSection            sectionComponents.ts
//   Privacy and data      compliance SettingsSection         sectionComponents.ts
//   Appearance            brand SettingsSection              sectionComponents.ts
//   Consents (GoApply)    compliance SettingsSection         sectionComponents.ts
//   Your search           search SettingsSection (saved searches)
//                         + this route, around it: SearchIntro above;
//                           SearchNotes, ResumeSection, BlocklistSection
//                           below                            preferences (draft)
//   Assistant, Devices, Connections, Invite friends, Sensitive answers
//                         their areas' SettingsSection       sectionComponents.ts
//   Danger zone           this route: DangerSection          destructive modals
//
// Old deep links keep working: #notif → Notifications, #resume → Your search.
//
// THE DRAFT. The preference-backed pieces (Account, and the notes / main
// resume / blocklist under Your search) share one draft + baseline + SaveBar.
//   • `dirty` = the draft differs from the last server copy; Save clears it,
//     Discard restores it.
//   • Save sends ONLY the keys the user changed, never a search-backed key:
//     job titles, places, pay and the company filters belong to the saved
//     searches, which this page edits through their own API.
//   • The blob is refetched while the page is open (saving a saved search
//     invalidates it). A refetch never wipes unsaved edits, and a save that
//     lands after a refetch does not mistake the server's newer values for
//     edits: see `rebasePreferencesDraft` / `settlePreferencesSave` in
//     hooks/usePreferences.ts.
// This page no longer writes `goal`: level and pay are filters now, so there
// is nothing here that could change it.
//
// THE NAME. "Full name" is the sign-in account's display name (PATCH
// /account), edited in the same form and saved by the same Save bar as the
// preferences, in its own request. It is never the email address: an account
// without a name shows an empty field (the page used to put the email there,
// read-only). A LinkedIn link that is not a linkedin.com/in/ profile link is
// not saved: the field says so and Save waits for it to be fixed or cleared.
//
// Sections that do not need the preferences never wait for them: the section
// row always renders, and only the draft-backed pieces show a loading line or,
// when the blob failed to load, what happened and a retry.
//
// Security writes immediately — a password change has nothing to Discard.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { SettingsPage, type SettingsRenderers, type SettingsRouteExtras } from '../../../components/features/settings';
import {
  changedPreferenceKeys,
  rebasePreferencesDraft,
  settlePreferencesSave,
  usePreferences,
  useUpdatePreferences,
  type PreferencesDraftState,
} from '../../../hooks/usePreferences';
import { useResumeList } from '../../../hooks/useResumes';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { RoboApiError } from '../../../lib/api/client';
import {
  SaveBar,
  IdentitySection,
  SearchIntro,
  SearchNotes,
  ResumeSection,
  BlocklistSection,
  DangerSection,
} from '../../../components/v3/preferences';
import { linkedinInvalid } from '../../../components/v3/preferences/sections/IdentitySection';
import { Panel, SecurityCard } from '../../../components/v3/account';
import { clearDraftsOnSignOut, forgetPushOnSignOut, leaveSignedOut } from '../../../components/v3/shell/signOutCleanup';
import { Btn } from '../../../components/v3/primitives/Btn';
import { toast } from '../../../components/v3/primitives/Toast';
import { useAccountProfile, useChangePassword, useSignOutAll, useUpdateName } from '../../../hooks/useAccount';
import type { RAPreferences, PreferencesUpdateBody } from '../../../lib/api/v2';

export default function SettingsRoute() {
  const t = useTranslations('settings');
  const tn = useTranslations('nav.settingsNotes');
  const ta = useTranslations('accountV2.prefs.identity');
  const auth = useAuth();
  const { user, profile } = auth;

  const prefsQuery = usePreferences();
  const resumesQuery = useResumeList();
  const updatePrefs = useUpdatePreferences();

  // A section switch is a new screen: start it at the top rather than wherever
  // the previous section's scroll left off. Plain scrollTop writes, because
  // .main is the scrollport on desktop and the document is on phones.
  const onSectionChange = useCallback(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (main) main.scrollTop = 0;
    document.documentElement.scrollTop = 0;
  }, []);

  // ── Preference draft + its server baseline (dirty compare + discard) ──
  const [prefs, setPrefs] = useState<PreferencesDraftState<RAPreferences> | null>(null);
  const serverPrefs = prefsQuery.data?.preferences ?? null;

  // Every server copy (first load, a refetch, our own save landing in the
  // cache) is folded into the draft; unsaved edits survive it.
  useEffect(() => {
    if (!serverPrefs) return;
    setPrefs((cur) => rebasePreferencesDraft(cur, serverPrefs));
  }, [serverPrefs]);

  const draft = prefs?.draft ?? null;
  const baseline = prefs?.baseline ?? null;

  // Deep path-set on the draft.
  const set = useCallback((path: string, value: unknown) => {
    setPrefs((cur) => {
      if (!cur) return cur;
      const next = structuredClone(cur.draft) as unknown as Record<string, unknown>;
      const keys = path.split('.');
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        obj[keys[i]] = { ...(obj[keys[i]] as Record<string, unknown>) };
        obj = obj[keys[i]] as Record<string, unknown>;
      }
      obj[keys[keys.length - 1]] = value;
      return { draft: next as unknown as RAPreferences, baseline: cur.baseline };
    });
  }, []);

  const changed = useMemo(
    () => (draft && baseline ? (changedPreferenceKeys(draft, baseline) as PreferencesUpdateBody) : {}),
    [draft, baseline],
  );
  const prefsDirty = Object.keys(changed).length > 0;

  // ── The account name (its own request, the same Save bar) ─────────────
  const updateName = useUpdateName();
  // `email` may be the generated address of an account without one (GoApply
  // phone or WeChat sign-up). It still goes to the sections, which need it to
  // tell (IdentitySection hides it, the delete modal sends it), but it never
  // stands in for the name: no name is an empty field, not an address.
  const email = (profile?.email as string) || user?.email || '';
  const storedName = ((profile?.name as string) || user?.name || '').trim();
  const savedName = storedName && storedName.toLowerCase() === email.trim().toLowerCase() ? '' : storedName;
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const name = nameDraft ?? savedName;
  const nameDirty = nameDraft !== null && nameDraft.trim() !== savedName;

  const dirty = prefsDirty || nameDirty;
  const saving = updatePrefs.isPending || updateName.isPending;

  const discard = useCallback(() => {
    setPrefs((cur) => (cur ? { draft: structuredClone(cur.baseline), baseline: cur.baseline } : cur));
    setNameDraft(null);
  }, []);

  const save = async () => {
    if (!dirty || saving) return;
    // A link that is not a LinkedIn profile link is never stored (the field says what to change).
    if (draft && prefsDirty && 'links' in changed && linkedinInvalid(draft.links.linkedin)) {
      toast({ message: ta('linkedin_invalid'), tone: 'danger' });
      return;
    }
    if (nameDirty) {
      try {
        await updateName.mutateAsync((nameDraft ?? '').trim());
        setNameDraft(null);
        // The header and the avatar read the name from /auth/me.
        await auth.refresh?.().catch(() => null);
      } catch {
        // Not saved: the typed name stays in the field and the bar stays up.
        toast({ message: ta('name_save_failed'), tone: 'danger' });
        return;
      }
    }
    if (!draft || !prefsDirty) return;
    const sent = changed;
    try {
      const res = await updatePrefs.mutateAsync(sent);
      // What we sent is saved; anything typed while the request was in flight
      // stays unsaved.
      setPrefs((cur) => settlePreferencesSave<RAPreferences>(cur, sent, res.preferences));
    } catch {
      // Nothing was saved: the edits stay in the draft and the bar stays up.
      toast({ message: tn('save_failed'), tone: 'danger' });
    }
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

  // True from the click until the request fails (on success the page leaves).
  // It covers the push step, which runs before the mutation is pending, so the
  // button is disabled and a second click cannot start a second sign-out.
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const signOutEverywhereInFlight = useRef(false);

  const onSignOutEverywhere = async () => {
    if (signOutEverywhereInFlight.current) return;
    signOutEverywhereInFlight.current = true;
    setSigningOutEverywhere(true);
    // Forget this device's push subscription first, while the session can
    // still authorise it. It never throws. If the sign-out then fails, this
    // device's notifications stay off until the user turns them on again;
    // nothing else is lost, because the drafts are cleared only on success.
    await forgetPushOnSignOut();
    signOutAll.mutate(undefined, {
      onSuccess: () => {
        clearDraftsOnSignOut();
        auth.clear();
        // A hard navigation: it drops the TanStack cache of this account.
        leaveSignedOut();
      },
      onError: () => {
        signOutEverywhereInFlight.current = false;
        setSigningOutEverywhere(false);
        toast({ message: tn('sign_out_failed'), tone: 'danger' });
      },
    });
  };

  /**
   * A draft-backed piece: its content once the preferences are here, a
   * loading line while they load, and the failure with a retry when they did
   * not load — never a blank panel.
   */
  const withDraft = (render: (p: RAPreferences) => ReactNode) => () => {
    if (draft) return render(draft);
    if (prefsQuery.isError) return <LoadError onRetry={() => void prefsQuery.refetch()} />;
    return <p className="pref-sub">{t('loading')}</p>;
  };

  const renderers: SettingsRenderers = {
    account: withDraft((p) => <IdentitySection p={p} set={set} name={name} onNameChange={setNameDraft} email={email} />),
    security: () =>
      profileQ.data ? (
        <SecurityCard
          hasPassword={profileQ.data.hasPassword}
          provider={profileQ.data.provider}
          changing={changePassword.isPending}
          signingOut={signingOutEverywhere || signOutAll.isPending}
          passwordError={passwordError}
          passwordSuccess={passwordSuccess}
          onChangePassword={onChangePassword}
          onSignOutEverywhere={() => void onSignOutEverywhere()}
          resetKey={securityResetKey}
        />
      ) : profileQ.isError ? (
        <LoadError onRetry={() => void profileQ.refetch()} />
      ) : (
        <p className="pref-sub">{t('loading')}</p>
      ),
    danger: () => <DangerSection accountEmail={email} />,
  };

  const extras: SettingsRouteExtras = {
    search: {
      before: () => <SearchIntro />,
      after: withDraft((p) => (
        <>
          <SearchNotes p={p} set={set} />
          <ResumeSection p={p} set={set} resumes={resumesQuery.data?.resumes ?? []} />
          <BlocklistSection p={p} set={set} />
        </>
      )),
    },
  };

  return (
    <SettingsPage
      renderers={renderers}
      extras={extras}
      onSectionChange={onSectionChange}
      // Save bar — appears on dirty, clears on save/discard. Only the
      // preference-backed pieces can make it appear.
      footer={dirty ? <SaveBar saving={saving} onDiscard={discard} onSave={() => void save()} /> : null}
    />
  );
}

/** A load failure: say what happened and what to do next. */
function LoadError({ onRetry }: { onRetry: () => void }) {
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
