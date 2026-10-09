'use client';

// /auth/callback/{google,line} (WP-10). The provider returns here with
// `code` + `state`; this page hands them to the API (JSON form), which
// verifies the ID token and finds or creates the seeker. Outcomes:
//   signed_in         → refresh the session, go to `next` (or onboarding)
//   consent_required  → a brand-new user ticks the signup agreements first
//                       (required age, PDPA for zh-TW/TW, marketing unchecked)
//   email_required    → the provider shared no confirmed email (LINE often,
//                       Google rarely): enter one; the account is created
//                       only after the emailed link is clicked
//   account_other_brand / failures → explained, with a way back.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { completeOAuth, finishOAuth, submitOAuthEmail, type OAuthCallbackResult, type OAuthProvider } from '../../../lib/api/auth';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { browserTimeZone } from '../../../lib/auth/entry';
import { useAuthMethodsInfo } from '../../../hooks/auth/useAuthAccount';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { Btn } from '../../v3/primitives/Btn';
import { AuthBrandMark, AuthError, AuthField } from '../../auth/AuthShell';
import { agreementsComplete, consentsFrom, type SignupAgreements } from '../../auth/agreements';
import { AgreementsFields } from './AgreementsFields';
import { OtherBrandNotice, otherBrandUrlOf } from './OtherBrandNotice';
import styles from './auth.module.css';

type Pending = Exclude<OAuthCallbackResult, { status: 'signed_in' }>;
type View =
  | { kind: 'working' }
  | { kind: 'pending'; pending: Pending }
  | { kind: 'check_email'; email: string }
  | { kind: 'other_brand'; url: string | null }
  | { kind: 'failed'; key: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Product names, not copy (the same in every locale). */
const PROVIDER_NAMES: Record<OAuthProvider, string> = { google: 'Google', line: 'LINE' };

function codeOf(err: unknown): string | undefined {
  return err instanceof RoboApiError ? ((err.payload as { code?: string } | undefined)?.code ?? err.code) : undefined;
}

export function OAuthCallbackView({ provider }: { provider: OAuthProvider }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const brand = useBrand();
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useAuth();
  const info = useAuthMethodsInfo(locale);
  const [view, setView] = useState<View>({ kind: 'working' });
  const ran = useRef(false);

  const pdpaRequired = info.data?.pdpaNoticeRequired ?? (brand.id === 'roboapply' && locale === 'zh-TW');
  const [agreements, setAgreements] = useState<SignupAgreements>({ age: false, pdpa: false, marketing: false, pdpaRequired });
  const effective: SignupAgreements = { ...agreements, pdpaRequired };
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function fail(err: unknown) {
    const code = codeOf(err);
    if (code === 'account_other_brand') setView({ kind: 'other_brand', url: otherBrandUrlOf((err as RoboApiError).payload) });
    else if (code === 'account_disabled') setView({ kind: 'failed', key: 'loginForm.disabled' });
    else if (code === 'account_deleted') setView({ kind: 'failed', key: 'loginForm.deleted' });
    else if (code === 'not_a_seeker_account') setView({ kind: 'failed', key: 'loginForm.notSeeker' });
    else setView({ kind: 'failed', key: 'loginForm.oauthError' });
  }

  async function signedIn(next: string) {
    await refresh();
    router.replace(next);
  }

  useEffect(() => {
    // A code is single-use: never exchange it twice (React strict mode).
    if (ran.current) return;
    ran.current = true;
    const pendingToken = params?.get('pending');
    const status = params?.get('status');
    if (pendingToken && (status === 'consent_required' || status === 'email_required')) {
      setView({ kind: 'pending', pending: { status, pendingToken, next: '/jobs', name: null, ...(status === 'consent_required' ? { email: null } : {}) } as Pending });
      return;
    }
    finishOAuth(provider, { code: params?.get('code'), state: params?.get('state'), error: params?.get('error') })
      .then((res) => {
        if (res.status === 'signed_in') return signedIn(res.next);
        setView({ kind: 'pending', pending: res });
        return undefined;
      })
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onComplete(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (view.kind !== 'pending') return;
    setFormError(null);
    if (!agreementsComplete(effective)) {
      setFormError(t(effective.age ? 'signupForm.pdpaRequired' : 'signupForm.ageRequired'));
      return;
    }
    const base = { consents: consentsFrom(effective), marketingOptIn: effective.marketing, locale, timezone: browserTimeZone() };
    setSubmitting(true);
    try {
      if (view.pending.status === 'email_required') {
        const clean = email.trim().toLowerCase();
        if (!EMAIL_RE.test(clean)) {
          setFormError(t('signupForm.emailInvalid'));
          return;
        }
        await submitOAuthEmail(view.pending.pendingToken, clean, base);
        setView({ kind: 'check_email', email: clean });
      } else {
        const res = await completeOAuth(view.pending.pendingToken, base);
        if (res.status === 'signed_in') await signedIn(res.next);
        else setView({ kind: 'pending', pending: res });
      }
    } catch (err) {
      const code = codeOf(err);
      if (code === 'age_consent_required') setFormError(t('signupForm.ageRequired'));
      else if (code === 'pdpa_consent_required') setFormError(t('signupForm.pdpaRequired'));
      else fail(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-split" style={{ gridTemplateColumns: '1fr' }}>
      <div className="auth-pane">
        <div className="auth-card" data-testid="oauth-callback">
          <AuthBrandMark className="auth-card__brand" />
          {view.kind === 'working' ? (
            <p className="auth-subtitle" role="status" aria-live="polite">
              {t('callback.working')}
            </p>
          ) : view.kind === 'pending' ? (
            <>
              <h1 className="auth-title">{t(view.pending.status === 'email_required' ? 'callback.emailTitle' : 'callback.consentTitle')}</h1>
              <p className="auth-subtitle">
                {view.pending.status === 'email_required' ? t('callback.emailBody', { provider: PROVIDER_NAMES[provider] }) : t('callback.consentBody')}
              </p>
              <form className="auth-form" onSubmit={onComplete} noValidate>
                {view.pending.status === 'email_required' ? (
                  <AuthField label={t('login.email')} type="email" name="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                ) : null}
                <AgreementsFields value={effective} onChange={(a) => setAgreements(a)} />
                {formError ? <AuthError message={formError} /> : null}
                <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting} aria-busy={submitting}>
                  {t(view.pending.status === 'email_required' ? 'callback.emailSubmit' : 'signupForm.submit')}
                </Btn>
              </form>
            </>
          ) : view.kind === 'check_email' ? (
            <div className={`${styles.notice} ${styles.status}`} role="status">
              <p className={styles.noticeTitle}>{t('signupForm.checkEmailTitle')}</p>
              <p>{t('signupForm.checkEmailBody', { email: view.email })}</p>
            </div>
          ) : view.kind === 'other_brand' ? (
            <div className={styles.status}>
              <OtherBrandNotice url={view.url} />
            </div>
          ) : (
            <>
              <h1 className="auth-title">{t('callback.failed')}</h1>
              <div style={{ marginTop: 24 }}>
                <AuthError message={t(view.key)} />
              </div>
            </>
          )}
          {view.kind !== 'working' ? (
            <p className="auth-switch">
              <Link href="/login">{t('common.backToSignIn')}</Link>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
