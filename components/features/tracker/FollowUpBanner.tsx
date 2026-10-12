'use client';

// FollowUpBanner — the "needs your attention" row on /applications (ruling
// C11: a fact plus an action, never a prediction). Lists every follow-up fact
// the server computed; each opens the application's details.

import { useTranslations } from 'next-intl';

import { useFollowUps } from '../../../hooks/tracker/useTracker';
import type { FollowUpView } from '../../../lib/api/contracts/tracker';
import styles from './tracker.module.css';

export interface FollowUpBannerProps {
  onOpen: (entryId: string) => void;
}

export function FollowUpBanner({ onOpen }: FollowUpBannerProps) {
  const t = useTranslations('applications');
  const { data } = useFollowUps();
  if (!data || data.length === 0) return null;

  const noReply = data.filter((f) => f.reason === 'no_reply_10d').length;
  const label = (f: FollowUpView) => {
    const name = f.companyName || f.title || t('follow_ups.unnamed');
    switch (f.reason) {
      case 'no_reply_10d':
        return t('follow_ups.no_reply_item', { name, days: f.days ?? 10 });
      case 'follow_up_due':
        return t('follow_ups.follow_up_due_item', { name });
      case 'interview_tomorrow':
        return t('follow_ups.interview_item', { name });
      case 'deadline_soon':
        return t('follow_ups.deadline_item', { name, days: f.days ?? 0 });
    }
  };

  return (
    <section className={styles.followUps} aria-labelledby="applications-follow-ups">
      <h2 id="applications-follow-ups" className={styles.followUpsTitle}>
        {t('follow_ups.title')}
      </h2>
      {noReply > 0 ? <p className={styles.followUpsRow}>{t('follow_up.row', { count: noReply })}</p> : null}
      <ul className={styles.plainList}>
        {data.map((f) => (
          <li key={`${f.entryId}-${f.reason}`}>
            <button type="button" className={styles.linkButton} onClick={() => onOpen(f.entryId)}>
              {label(f)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
