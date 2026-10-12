'use client';

// /settings#referrals — the invite link, a Copy button and this year's
// rewards, with a link to the full /invite page (TASK_PLAN.md WP-60; flag
// `invites`). Registered in components/features/settings/sectionComponents.ts;
// the registry shows the section when `invites` is on.
//
// The section always says where it is: a loading line while the invites load,
// what happened and a "Try again" button when they could not be loaded, and a
// plain sentence where the programme does not run for this account. It used
// to render nothing in all three cases, so a request slower than the Settings
// frame's blank-panel wait (1.5 s) showed "This section did not load. Reload
// the page" with no way to retry. Nothing renders only when the capability is
// off (the registry hides the section then).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useInvites, useInvitesLive } from '../../../hooks/growth/useInvites';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import { Btn } from '../../v3/primitives';
import { InviteLinkBox } from './InviteLinkBox';
import styles from './invite.module.css';

export function SettingsSection(_props: SettingsSectionProps) {
  const t = useTranslations('invite');
  const tc = useTranslations('accountV2.common');
  const enabled = useInvitesLive();
  const q = useInvites({ enabled });
  if (!enabled) return null;

  if (!q.data) {
    if (q.isError) {
      return (
        <div className={styles.page} data-testid="invite-settings-error">
          <p className={styles.error} role="alert">
            {t('page.loadError')}
          </p>
          <div className={styles.actions}>
            <Btn className={styles.btn} onClick={() => void q.refetch()} disabled={q.isFetching}>
              {t('page.retry')}
            </Btn>
          </div>
        </div>
      );
    }
    return (
      <p className={styles.body} role="status" data-testid="invite-settings-loading">
        {tc('loading')}
      </p>
    );
  }

  if (q.data.eligibility === 'not_available') {
    return (
      <p className={styles.body} data-testid="invite-settings-unavailable">
        {t('page.unavailable')}
      </p>
    );
  }

  const { granted, capPerYear } = q.data.rewards;
  return (
    <div className={styles.page} data-testid="invite-settings">
      <InviteLinkBox view={q.data} from="settings" compact />
      <div className={styles.row}>
        <p className={styles.body}>{t('settings.summary', { granted, cap: capPerYear })}</p>
        <Link className={`btn ${styles.btn}`} href="/invite">
          {t('settings.open')}
        </Link>
      </div>
    </div>
  );
}

export default SettingsSection;
