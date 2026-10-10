'use client';

// /settings#referrals — the invite link, a Copy button and this year's
// rewards, with a link to the full /invite page (TASK_PLAN.md WP-60; flag
// `invites`). Registered in components/features/settings/sectionComponents.ts;
// the registry shows the section when `invites` is on. Renders nothing while
// loading, when the area answers an error (the full page explains errors), or
// where the programme does not run on this brand (`useInvitesLive`).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useInvites, useInvitesLive } from '../../../hooks/growth/useInvites';
import type { SettingsSectionProps } from '../settings/sectionComponents';
import { InviteLinkBox } from './InviteLinkBox';
import styles from './invite.module.css';

export function SettingsSection(_props: SettingsSectionProps) {
  const t = useTranslations('invite.settings');
  const enabled = useInvitesLive();
  const q = useInvites({ enabled });
  if (!enabled || !q.data || q.data.eligibility === 'not_available') return null;
  const { granted, capPerYear } = q.data.rewards;
  return (
    <div className={styles.page} data-testid="invite-settings">
      <InviteLinkBox view={q.data} from="settings" compact />
      <div className={styles.row}>
        <p className={styles.body}>{t('summary', { granted, cap: capPerYear })}</p>
        <Link className={`btn ${styles.btn}`} href="/invite">
          {t('open')}
        </Link>
      </div>
    </div>
  );
}

export default SettingsSection;
