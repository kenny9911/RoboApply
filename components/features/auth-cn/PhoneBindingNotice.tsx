'use client';

// PhoneBindingNotice — what an AI action shows when the server answers
// `403 phone_binding_required` (a GoApply WeChat account without a verified
// number; CN-L-08). Renders nothing for any other error, so callers can drop
// it next to their own error handling:
//
//   {error ? <PhoneBindingNotice error={error} /> : null}

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { isPhoneBindingRequired } from './shared';
import styles from './AuthCn.module.css';

export interface PhoneBindingNoticeProps {
  error: unknown;
  /** Where to return after binding (defaults to the current path). */
  next?: string;
}

export function PhoneBindingNotice({ error, next }: PhoneBindingNoticeProps) {
  const t = useTranslations('authCn');
  if (!isPhoneBindingRequired(error)) return null;
  const back = next ?? (typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '/');
  return (
    <div className={styles.banner} role="alert">
      <p className={styles.bannerText}>{t('bindNotice.body')}</p>
      <Link href={`/bind-phone?next=${encodeURIComponent(back)}`} className={`${styles.wechatBtn} ${styles.bannerAction}`}>
        {t('bindNotice.cta')}
      </Link>
    </div>
  );
}
