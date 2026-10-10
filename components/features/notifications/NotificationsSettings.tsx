'use client';

// NotificationsSettings — /settings#notifications (TASK_PLAN.md WP-39b;
// PRODUCT_PLAN.md §7.1, F-NOTIF-01/02/04).
//
//   Job alerts            per saved search: instant alerts (up to the plan's
//                         `instant_alerts`; "As they arrive" on Pro, never
//                         "unlimited") and the email summary — one
//                         PATCH /search-profiles/:id with baseVersion (WP-20).
//                         Only while `jobs.alerts` is on (both brands by
//                         default; CN_RECRUITMENT_INFO_MODE=off turns GoApply's
//                         off). The email summary is hidden while the brand
//                         sends no email (`emailUnavailableReason` is
//                         'not_offered').
//   Where messages go     per category, one switch per channel the account can
//                         use (email needs a real address and the `notify.email`
//                         capability; "This device" with web push, WeChat with
//                         its capability). The inbox is always on.
//   Alerts on this device right under the switches while `webPush` is on for the
//                         brand (both brands, D5; the flag alone decides): the
//                         one place that asks the
//                         browser for permission, and only on a click (WP-61
//                         `PushOptIn`). It adds "This device" to the job-alert
//                         and reminder rows above. Hidden when the flag is off,
//                         so there is no entry for a missing capability.
//   Tips and reminders    the consent switch, described by the exact consent text
//                         the record hashes, with the regional default named
//                         (off for EEA/UK/CH/CA visitors and GoApply).
//   Always sent           account, security and billing messages.
// Every change saves at once and confirms with a toast (F-NOTIF-06).

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import { PrefHeader } from '../../v3/preferences/controls';
import { Btn } from '../../v3/primitives/Btn';
import { toast } from '../../v3/primitives/Toast';
import { useProfileLabel } from '../filters';
import { PushOptIn } from '../pwa';
import { useFlag } from '../../../lib/flags';
import {
  useSearchProfiles,
  useUpdateSearchProfile,
  type SearchProfile,
  type SearchProfileList,
} from '../../../hooks/search';
import {
  useNotificationPreferences,
  usePatchNotificationPreferences,
  type NotificationPreferencesPatch,
  type NotificationPreferencesView,
} from '../../../hooks/notifications';
import type { NotificationCategory, NotificationChannel } from '../../../lib/api/contracts/notifications';
import styles from './notifications.module.css';

const INSTANT_OPTIONS = [0, 1, 2, 5, 100] as const;
type InstantOption = (typeof INSTANT_OPTIONS)[number];

function useSave() {
  const t = useTranslations('inbox.settings');
  const patch = usePatchNotificationPreferences();
  const save = (body: NotificationPreferencesPatch) =>
    patch.mutate(body, {
      onSuccess: () => toast({ message: t('saved'), tone: 'ok' }),
      onError: () => toast({ message: t('saveFailed'), tone: 'danger' }),
    });
  return { save, pending: patch.isPending };
}

function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  ariaLabel?: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <label className={styles.switch}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

// ── Job alerts (per saved search) ───────────────────────────────────────

function SearchAlertRow({ profile, list, emailOffered }: { profile: SearchProfile; list: SearchProfileList; emailOffered: boolean }) {
  const t = useTranslations('inbox.settings');
  const label = useProfileLabel(list.profiles)(profile);
  const update = useUpdateSearchProfile();
  const patch = (body: { alertInstantMax?: InstantOption; alertDigest?: 'daily' | 'weekly' | null }) =>
    update.mutate(
      { id: profile.id, body: { ...body, baseVersion: profile.version } },
      {
        onSuccess: () => toast({ message: t('saved'), tone: 'ok' }),
        // A 409 puts the server's current search in the cache, so a retry uses the right version.
        onError: () => toast({ message: t('saveFailed'), tone: 'danger' }),
      },
    );
  const instantId = `alert-instant-${profile.id}`;
  const digestId = `alert-digest-${profile.id}`;
  return (
    <div className={styles.searchRow}>
      <p className={styles.rowLabel}>{label}</p>
      <div className={styles.selects}>
        <label className={styles.selectLabel} htmlFor={instantId}>
          {t('instant')}
          <select
            id={instantId}
            className={styles.select}
            value={profile.alertInstantMax}
            disabled={update.isPending}
            onChange={(e) => patch({ alertInstantMax: Number(e.target.value) as InstantOption })}
          >
            {INSTANT_OPTIONS.map((n) => (
              <option key={n} value={n} disabled={n > list.maxInstantAlerts}>
                {t(`instantOptions.${n}`)}
              </option>
            ))}
          </select>
        </label>
        {/* The summary is an email: no control for it while this brand sends no email (it would never arrive). */}
        {emailOffered ? (
          <label className={styles.selectLabel} htmlFor={digestId}>
            {t('digest')}
            <select
              id={digestId}
              className={styles.select}
              value={profile.alertDigest ?? 'none'}
              disabled={update.isPending}
              onChange={(e) => patch({ alertDigest: e.target.value === 'none' ? null : (e.target.value as 'daily' | 'weekly') })}
            >
              {(['none', 'daily', 'weekly'] as const).map((d) => (
                <option key={d} value={d}>
                  {t(`digestOptions.${d}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
}

function AlertsGroup({ emailOffered }: { emailOffered: boolean }) {
  const t = useTranslations('inbox.settings');
  const q = useSearchProfiles();
  return (
    <section className={styles.group} aria-labelledby="notif-alerts">
      <h2 id="notif-alerts" className={styles.groupTitle}>
        {t('alertsGroup')}
      </h2>
      <p className={styles.help}>{t('alertsSub')}</p>
      {q.isLoading ? (
        <p className={styles.status}>{t('loading')}</p>
      ) : q.isError || !q.data ? (
        <p className={styles.error} role="alert">
          {t('alertsLoadFailed')}
        </p>
      ) : q.data.profiles.length === 0 ? (
        <p className={styles.help}>{t('alertsNone')}</p>
      ) : (
        <>
          {q.data.profiles.map((p) => (
            <SearchAlertRow key={p.id} profile={p} list={q.data!} emailOffered={emailOffered} />
          ))}
          {q.data.upgradable && q.data.maxInstantAlerts < 100 ? <p className={styles.help}>{t('alertsProNote')}</p> : null}
        </>
      )}
    </section>
  );
}

// ── Channels ────────────────────────────────────────────────────────────

const ROW_KEYS: Partial<Record<NotificationCategory, { label: string; sub?: string }>> = {
  alert: { label: 'rows.alert', sub: 'rows.alertSub' },
  reminder: { label: 'rows.reminder', sub: 'rows.reminderSub' },
  // The tips row is described by the consent text from the server, not a bundle string.
  tips: { label: 'rows.tips' },
  invitation: { label: 'rows.invitation', sub: 'rows.invitationSub' },
};

function CategoryRow({ view, category, save, pending }: { view: NotificationPreferencesView; category: NotificationCategory; save: (b: NotificationPreferencesPatch) => void; pending: boolean }) {
  const t = useTranslations('inbox.settings');
  const consentId = useId();
  const keys = ROW_KEYS[category];
  if (!keys) return null;
  const label = t(keys.label);
  const current = view.channels[category] ?? ['in_app'];
  const extra = view.availableChannels.filter((c): c is Exclude<NotificationChannel, 'in_app'> => c !== 'in_app');
  const tipsOff = category === 'tips' && !view.tipsReminders;

  const toggle = (channel: NotificationChannel, on: boolean) => {
    const next = on ? [...new Set([...current, channel])] : current.filter((c) => c !== channel);
    save({ channels: { [category]: next } });
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <p className={styles.rowLabel}>{label}</p>
        {category === 'tips' ? (
          // The exact text the consent record hashes (its language may differ from the page's until WP-13 adds a translation).
          <p id={consentId} className={styles.help} lang={view.tipsRemindersConsent.locale}>
            {view.tipsRemindersConsent.text}
          </p>
        ) : keys.sub ? (
          <p className={styles.help}>{t(keys.sub)}</p>
        ) : null}
        {category === 'tips' ? (
          <p className={styles.help}>
            {view.tipsRemindersSource === 'user' ? t('tipsChosen') : null} {view.tipsRemindersDefault ? t('tipsDefaultOn') : t('tipsDefaultOff')}
            {tipsOff ? ` ${t('tipsOffNote')}` : null}
          </p>
        ) : null}
      </div>
      <div className={styles.rowControls}>
        {category === 'tips' ? (
          <Switch
            checked={view.tipsReminders}
            onChange={(v) => save({ tipsReminders: v, tipsRemindersProseVersion: view.tipsRemindersConsent.version })}
            label={t('tipsToggle')}
            describedBy={consentId}
            disabled={pending}
          />
        ) : null}
        <span className={styles.fixed}>{t('inboxAlways')}</span>
        {extra.map((ch) => (
          <Switch
            key={ch}
            checked={current.includes(ch)}
            disabled={pending || tipsOff}
            onChange={(v) => toggle(ch, v)}
            label={t(`channels.${ch}`)}
            ariaLabel={t('channelToggle', { category: label, channel: t(`channels.${ch}`) })}
          />
        ))}
      </div>
    </div>
  );
}

function ChannelsGroup({ view }: { view: NotificationPreferencesView }) {
  const t = useTranslations('inbox.settings');
  const { save, pending } = useSave();
  // No push entry while web push is off for the brand: the flag alone decides, on both brands
  // (PushOptIn also checks the browser and the server keys).
  const webPush = useFlag('webPush');
  return (
    <section className={styles.group} aria-labelledby="notif-channels">
      <h2 id="notif-channels" className={styles.groupTitle}>
        {t('channelsGroup')}
      </h2>
      {view.emailUnavailableReason === 'no_address' ? <p className={styles.help}>{t('emailUnavailable')}</p> : null}
      {view.configurableCategories.map((c) => (
        <CategoryRow key={c} view={view} category={c} save={save} pending={pending} />
      ))}
      {webPush ? <PushOptIn className={styles.pushOptIn} /> : null}
      <p className={styles.help}>{t('lockedNote')}</p>
      <p className={styles.help}>{t('quietNote', { start: view.quietHours.start, end: view.quietHours.end })}</p>
    </section>
  );
}

export function NotificationsSettings() {
  const t = useTranslations('inbox.settings');
  const prefs = useNotificationPreferences();
  // No alert controls while alerts are off for this brand (they would never
  // arrive). On by default on both brands; CN_RECRUITMENT_INFO_MODE=off turns
  // GoApply's off.
  const alertsOn = useFlag('jobs.alerts');
  // The server's answer, so the rule is one for both brands: 'not_offered'
  // means this brand sends no email now (no email key, or
  // CN_EMAIL_TRANSPORT=none on GoApply). Shown until the answer is in.
  const emailOffered = prefs.data?.emailUnavailableReason !== 'not_offered';
  return (
    <div className={styles.settings} data-testid="notifications-settings">
      <PrefHeader eyebrow={t('eyebrow')} title={t('title')} sub={t('sub')} />
      {alertsOn ? <AlertsGroup emailOffered={emailOffered} /> : null}
      {prefs.isLoading ? (
        <p className={styles.status}>{t('loading')}</p>
      ) : prefs.isError || !prefs.data ? (
        <div role="alert" className={styles.group}>
          <p className={styles.error}>{t('loadFailed')}</p>
          <div>
            <Btn onClick={() => void prefs.refetch()}>{t('retry')}</Btn>
          </div>
        </div>
      ) : (
        <ChannelsGroup view={prefs.data} />
      )}
    </div>
  );
}

export default NotificationsSettings;
