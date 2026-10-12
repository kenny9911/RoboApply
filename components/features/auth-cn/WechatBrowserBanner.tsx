'use client';

// WechatBrowserBanner — "在浏览器中打开" guidance (PRODUCT_PLAN.md F-MOB-03 cn;
// TASK_PLAN.md WP-11, C24). WeChat's built-in browser (`MicroMessenger`)
// blocks file downloads and cannot run the browser extension. Areas that
// offer those actions render this next to them; it shows only inside WeChat
// and never redirects.
//
//   <WechatBrowserBanner action="download" />   resume / cover-letter exports
//   <WechatBrowserBanner action="extension" />  the extension page and prompts

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { useIsWechatBrowser } from './shared';
import styles from './AuthCn.module.css';

export interface WechatBrowserBannerProps {
  action?: 'download' | 'extension' | 'general';
}

export function WechatBrowserBanner({ action = 'general' }: WechatBrowserBannerProps) {
  const t = useTranslations('authCn');
  const inWechat = useIsWechatBrowser();
  const [copied, setCopied] = useState(false);
  if (!inWechat) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const body = action === 'download' ? t('wechatBrowser.download') : action === 'extension' ? t('wechatBrowser.extension') : t('wechatBrowser.general');
  return (
    <div className={styles.banner} role="note">
      <p className={styles.bannerText}>
        <strong className={styles.bannerTitle}>{t('wechatBrowser.title')}</strong>
        {body}
      </p>
      <button type="button" className={`${styles.sendBtn} ${styles.bannerAction}`} onClick={copy} aria-live="polite">
        {copied ? t('wechatBrowser.copied') : t('wechatBrowser.copy')}
      </button>
    </div>
  );
}
