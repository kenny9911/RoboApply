'use client';

// /verify-email/[token] (WP-10; F-ACCT-02). Confirms the address (which
// unlocks the free practice interview) — or, for a LINE sign-up that had no
// email, creates the account and signs the user in. When that address
// already has an account, nothing is created or linked (`account_exists`) and
// the page says so. Verification never blocks onboarding; this page only
// reports what the link did.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { verifyEmail } from '../../../lib/api/auth';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { isTwoFactorRequired, twoFactorHref } from '../../../lib/auth/twoFactor';
import { AuthBrandMark } from '../../auth/AuthShell';
import { Btn } from '../../v3/primitives/Btn';
import styles from './auth.module.css';

type State =
  | { kind: 'working' }
  | { kind: 'verified'; next: string }
  | { kind: 'account_exists'; next: string }
  | { kind: 'failed'; reason: 'invalid' | 'expired' | 'other_brand' | 'network' };

export function VerifyEmailView({ token }: { token: string }) {
  const t = useTranslations('auth');
  const router = useRouter();
  const { refresh } = useAuth();
  const [state, setState] = useState<State>({ kind: 'working' });
  const ran = useRef(false);

  useEffect(() => {
    // The link is single-use: never fire it twice (React strict mode).
    if (ran.current) return;
    ran.current = true;
    verifyEmail(token)
      .then(async (res) => {
        if (res.status === 'signed_in') {
          await refresh();
          router.replace(res.next);
          return;
        }
        if (res.status === 'account_exists') {
          setState({ kind: 'account_exists', next: res.next });
          return;
        }
        setState({ kind: 'verified', next: res.next });
        void refresh();
      })
      .catch((err) => {
        // The link would sign in an account with two-step sign-in on: the code page is next.
        if (isTwoFactorRequired(err)) {
          router.replace(twoFactorHref(err));
          return;
        }
        const code = err instanceof RoboApiError ? ((err.payload as { code?: string } | undefined)?.code ?? err.code) : undefined;
        setState({
          kind: 'failed',
          reason: code === 'token_expired' ? 'expired' : code === 'account_other_brand' ? 'other_brand' : code === 'token_invalid' ? 'invalid' : 'network',
        });
      });
  }, [token, refresh, router]);

  return (
    <div className="auth-card">
      <AuthBrandMark className="auth-card__brand" />
      {state.kind === 'working' ? (
        <p className="auth-subtitle" role="status" aria-live="polite">
          {t('verify.working')}
        </p>
      ) : state.kind === 'verified' ? (
        <>
          <h1 className="auth-title">{t('verify.verifiedTitle')}</h1>
          <p className="auth-subtitle">{t('verify.verifiedBody')}</p>
          <div className={styles.methods}>
            <Btn as="a" href={state.next} variant="primary" className="auth-submit">
              {t('verify.toSettings')}
            </Btn>
          </div>
        </>
      ) : state.kind === 'account_exists' ? (
        <>
          <h1 className="auth-title">{t('verify.accountExistsTitle')}</h1>
          <p className="auth-subtitle">{t('verify.accountExistsBody')}</p>
          <div className={styles.methods}>
            <Btn as="a" href={state.next} variant="primary" className="auth-submit">
              {t('verify.toSignIn')}
            </Btn>
          </div>
        </>
      ) : (
        <>
          <h1 className="auth-title">{t('verify.failedTitle')}</h1>
          <p className="auth-subtitle" role="alert">
            {t(state.reason === 'expired' ? 'verify.expired' : state.reason === 'other_brand' ? 'otherBrand.body' : state.reason === 'invalid' ? 'verify.invalid' : 'errors.network')}
          </p>
          <p className="auth-switch">
            <Link href="/login">{t('common.backToSignIn')}</Link>
          </p>
        </>
      )}
    </div>
  );
}
