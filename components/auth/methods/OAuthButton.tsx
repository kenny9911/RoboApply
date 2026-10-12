'use client';

// components/auth/methods/OAuthButton.tsx — "Continue with Google / LINE"
// (WP-10; F-ACCT-01, TW-05). A full-page navigation to the API start route,
// which redirects to the provider with PKCE + state. On the signup page the
// visitor's agreements travel with it (the account is created on return);
// until "I'm 16 or older" is ticked the button explains instead of leaving.
// Inside LinkedIn / Instagram / TikTok / Facebook / WeChat webviews the
// button is replaced by "Open in your browser" (F-ONB-11).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { oauthStartUrl, type OAuthProvider } from '../../../lib/api/auth';
import { detectInAppBrowser } from '../../../lib/auth/inAppBrowser';
import { browserTimeZone } from '../../../lib/auth/entry';
import { agreementsComplete, useAuthEntry } from '../agreements';
import { InAppBrowserNotice } from '../../features/auth/InAppBrowserNotice';
import styles from '../../features/auth/auth.module.css';

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: 'Google', line: 'LINE' };

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function LineGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#06C755" />
      <path
        fill="#fff"
        d="M12 5.5c-4 0-7.2 2.6-7.2 5.8 0 2.9 2.6 5.3 6 5.7.2.1.6.2.7.4.1.2 0 .5 0 .7l-.1.6c0 .2-.1.7.6.4.7-.3 3.9-2.3 5.3-3.9 1-1.1 1.4-2.2 1.4-3.5.5-3.6-2.7-6.2-6.7-6.2z"
      />
    </svg>
  );
}

export interface OAuthButtonProps {
  provider: OAuthProvider;
  mode: 'login' | 'signup';
  next?: string | null;
}

export function OAuthButton({ provider, mode, next }: OAuthButtonProps) {
  const t = useTranslations('auth');
  const entry = useAuthEntry();
  const [inApp, setInApp] = useState<ReturnType<typeof detectInAppBrowser>>(null);
  const [needAgreements, setNeedAgreements] = useState(false);

  // Read the user agent after mount (no server/client markup mismatch).
  useEffect(() => {
    setInApp(detectInAppBrowser(typeof navigator !== 'undefined' ? navigator.userAgent : null));
  }, []);

  const name = PROVIDER_LABEL[provider];
  if (inApp) return <InAppBrowserNotice provider={name} />;

  const signup = mode === 'signup';
  const agreements = entry?.agreements ?? null;
  const ready = !signup || agreementsComplete(agreements);

  function go() {
    if (!ready) {
      setNeedAgreements(true);
      entry?.onAgreementsMissing?.();
      return;
    }
    const url = oauthStartUrl(provider, {
      next: next ?? entry?.next ?? null,
      age: signup ? agreements!.age : undefined,
      pdpa: signup ? agreements!.pdpa : undefined,
      marketing: signup ? agreements!.marketing : undefined,
      locale: entry?.locale,
      tz: browserTimeZone(),
      attribution: entry?.attribution,
    });
    window.location.assign(url);
  }

  return (
    <div>
      <button
        type="button"
        className={styles.oauthButton}
        onClick={go}
        aria-disabled={!ready}
        data-provider={provider}
      >
        {provider === 'google' ? <GoogleGlyph /> : <LineGlyph />}
        {t(provider === 'google' ? 'methods.google' : 'methods.line')}
      </button>
      {needAgreements && !ready ? (
        <p className={styles.error} role="alert" style={{ marginTop: 8 }}>
          {t('methods.needAgreements')}
        </p>
      ) : null}
    </div>
  );
}
