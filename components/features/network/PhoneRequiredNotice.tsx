'use client';

// PhoneRequiredNotice — shown when sharing or reporting a 内推码 answers
// 403 phone_binding_required (WP-11 gate; CN_TW_LAUNCH_PLAN L-8 real-name
// rule for public user content). WP-11's PhoneBindingNotice speaks about AI
// features, which is not why this is blocked, so the hub says it in its own
// words and links to the same /bind-phone flow.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import styles from './network.module.css';

export function PhoneRequiredNotice() {
  const t = useTranslations('people.referrals');
  const back = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '/referrals';
  return (
    <div className={styles.error} role="alert" data-error="phone_binding_required">
      <p className={styles.body}>{t('error.phone_binding_required')}</p>
      <Link className={styles.link} href={`/bind-phone?next=${encodeURIComponent(back)}`}>
        {t('bindPhoneCta')}
      </Link>
    </div>
  );
}

export default PhoneRequiredNotice;
