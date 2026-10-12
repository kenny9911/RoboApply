'use client';

// OtherBrandNotice — "This account belongs to {otherBrand}. Continue there."
// (PRODUCT_PLAN.md §3.1). Shown only after the password (or the provider)
// proved the account, so it never reveals which emails hold an account.

import { useTranslations } from 'next-intl';
import styles from './auth.module.css';

export function OtherBrandNotice({ url }: { url: string | null }) {
  const t = useTranslations('auth');
  return (
    <div className={styles.notice} role="alert" data-testid="other-brand-notice">
      <p className={styles.noticeTitle}>{t('otherBrand.title')}</p>
      <p>{t('otherBrand.body')}</p>
      {url ? (
        <a className={styles.oauthButton} href={url}>
          {t('otherBrand.cta')}
        </a>
      ) : null}
    </div>
  );
}

/** The other brand's sign-in URL from a 409 `account_other_brand` payload. */
export function otherBrandUrlOf(payload: unknown): string | null {
  const url = (payload as { details?: { otherBrandUrl?: unknown } } | null)?.details?.otherBrandUrl;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
}
