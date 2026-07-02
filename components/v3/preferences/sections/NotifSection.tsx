'use client';

// §04 Notifications — channels (email/push/sms), a per-event × per-channel
// matrix, and digest frequency. All preferences-owned. The matrix keys are the
// 5 events the proto defines: newMatch90, queueReview, appSent, response,
// interview.

import { useTranslations } from 'next-intl';
import { PrefHeader, PrefGroup, PrefRow, Toggle, Segmented } from '../controls';
import { QUEUE_REVIEW_ENABLED } from '../../../../lib/jobApplying';
import type { RAPreferences } from '../../../../lib/api/v2';

// queueReview is hidden while the /queue surface is off for launch; the stored
// preference (and its i18n keys) survive untouched for re-enable.
const EVENT_IDS = (
  ['newMatch90', 'queueReview', 'appSent', 'response', 'interview'] as const
).filter((id) => QUEUE_REVIEW_ENABLED || id !== 'queueReview');
const CHANNELS = ['email', 'push', 'sms'] as const;

export function NotifSection({
  p,
  set,
}: {
  p: RAPreferences;
  set: (path: string, value: unknown) => void;
}) {
  const t = useTranslations('preferences');

  const events = EVENT_IDS.map((id) => ({
    id,
    label: t(`notif.event_${id}_label`),
    sub: t(`notif.event_${id}_sub`),
  }));

  return (
    <>
      <PrefHeader
        eyebrow={t('notif.eyebrow')}
        title={
          <>
            {t('notif.title_before')} <em>{t('notif.title_em')}</em>
            {t('notif.title_after')}
          </>
        }
        sub={t('notif.sub')}
      />

      <PrefGroup label={t('notif.group_channels')}>
        <PrefRow label={t('notif.channel_email')} sub={t('notif.channel_email_sub')}>
          <Toggle
            value={p.channels.email}
            onChange={(v) => set('channels.email', v)}
            ariaLabel={t('notif.channel_email')}
          />
        </PrefRow>
        <PrefRow label={t('notif.channel_push')} sub={t('notif.channel_push_sub')}>
          <Toggle
            value={p.channels.push}
            onChange={(v) => set('channels.push', v)}
            ariaLabel={t('notif.channel_push')}
          />
        </PrefRow>
        <PrefRow label={t('notif.channel_sms')} sub={p.phone ?? undefined}>
          <Toggle
            value={p.channels.sms}
            onChange={(v) => set('channels.sms', v)}
            ariaLabel={t('notif.channel_sms')}
          />
        </PrefRow>
      </PrefGroup>

      <PrefGroup label={t('notif.group_matrix')}>
        <div className="pref-notif-grid">
          <div className="pref-notif-head">
            <div />
            <div className="pref-notif-col">{t('notif.col_email')}</div>
            <div className="pref-notif-col">{t('notif.col_push')}</div>
            <div className="pref-notif-col">{t('notif.col_sms')}</div>
          </div>
          {events.map((ev) => (
            <div key={ev.id} className="pref-notif-row">
              <div className="pref-notif-meta">
                <div className="pref-notif-label">{ev.label}</div>
                <div className="pref-notif-sub">{ev.sub}</div>
              </div>
              {CHANNELS.map((ch) => (
                <div key={ch} className="pref-notif-cell">
                  <Toggle
                    value={!!p.notif[ev.id]?.[ch]}
                    onChange={(v) => set(`notif.${ev.id}.${ch}`, v)}
                    ariaLabel={`${ev.label} — ${ch}`}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </PrefGroup>

      <PrefGroup label={t('notif.group_digest')}>
        <PrefRow label={t('notif.digest_label')} sub={t('notif.digest_sub')}>
          <Segmented
            value={p.digest}
            onChange={(v) => set('digest', v)}
            options={[
              { value: 'off', label: t('notif.digest_off') },
              { value: 'daily', label: t('notif.digest_daily') },
              { value: 'weekly', label: t('notif.digest_weekly') },
            ]}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
