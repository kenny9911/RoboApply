'use client';

// InAppBrowserNotice — F-ONB-11. Inside a social app's webview, provider
// sign-in is replaced by "Open in your browser" plus a copy-link button.
// Email sign-up keeps working in place.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import styles from './auth.module.css';

export function InAppBrowserNotice({ provider }: { provider: string }) {
  const t = useTranslations('auth');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.notice} role="note" data-testid="in-app-browser-notice">
      <p className={styles.noticeTitle}>{t('inApp.title', { provider })}</p>
      <p>{t('inApp.body', { provider })}</p>
      <button type="button" className={styles.oauthButton} onClick={copy}>
        {copied ? t('inApp.copied') : t('inApp.copy')}
      </button>
    </div>
  );
}
