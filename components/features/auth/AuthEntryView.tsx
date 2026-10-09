'use client';

// AuthEntryView — the login and signup cards (WP-10; PRODUCT_PLAN.md O0,
// G0 for the method order on GoApply).
//
//   - Methods = the brand's `authMethods` ∩ capabilities (components/auth/
//     methods/registry.ts); a method without credentials never renders.
//     LINE is offered only to zh-TW visitors and visitors from Taiwan, and
//     then first (PRODUCT O0 row 3).
//   - RoboApply: provider buttons, "or", then the email form.
//     GoApply: phone (WP-11) first, WeChat, and email behind "Use email
//     instead" (the fallback).
//   - Contextual title from `action=apply` / `job` / `from`; the job title is
//     looked up by id (never taken from the URL) and shown only when found.
//     Every query parameter is carried to the other page.
//   - Signup: the agreements (marketing unchecked, required age, PDPA for
//     zh-TW/TW) are page state shared with every method.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { AUTH_METHOD_COMPONENTS, useAuthMethods, type AuthMethodEntry } from '../../auth/methods/registry';
import { AuthEntryProvider, type SignupAgreements } from '../../auth/agreements';
import { AuthBrandMark, AuthError } from '../../auth/AuthShell';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { attributionFrom, carriedQuery, entryContext, safeNext } from '../../../lib/auth/entry';
import { useAuthMethodsInfo, useEntryJob } from '../../../hooks/auth/useAuthAccount';
import styles from './auth.module.css';

const OAUTH_ERRORS = new Set(['oauth_failed', 'oauth_state_invalid', 'account_other_brand', 'account_disabled', 'account_deleted', 'not_a_seeker_account']);

const OAUTH_ERROR_KEYS: Record<string, string> = {
  account_disabled: 'loginForm.disabled',
  account_deleted: 'loginForm.deleted',
  not_a_seeker_account: 'loginForm.notSeeker',
};

/**
 * Pure: the methods this visitor sees, in order. LINE only for zh-TW
 * visitors and visitors from Taiwan, and then first (mirrors the server's
 * /auth/methods).
 */
export function filterAndOrder(methods: AuthMethodEntry[], opts: { locale: string; country: string | null }): AuthMethodEntry[] {
  const line = methods.find((m) => m.id === 'line');
  const rest = methods.filter((m) => m.id !== 'line');
  const lineAudience = opts.locale === 'zh-TW' || (opts.country ?? '').toUpperCase() === 'TW';
  return line && lineAudience ? [line, ...rest] : rest;
}

export function AuthEntryView({ mode }: { mode: 'login' | 'signup' }) {
  const t = useTranslations('auth');
  const locale = useLocale();
  const brand = useBrand();
  const params = useSearchParams();
  const info = useAuthMethodsInfo(locale);
  const registryMethods = useAuthMethods();

  const country = info.data?.country ?? null;
  const pdpaRequired = info.data?.pdpaNoticeRequired ?? (brand.id === 'roboapply' && locale === 'zh-TW');
  const [agreements, setAgreements] = useState<Omit<SignupAgreements, 'pdpaRequired'>>({ age: false, pdpa: false, marketing: false });
  const [showEmail, setShowEmail] = useState(false);

  const next = safeNext(params?.get('next'));
  const ctx = entryContext(params);
  const job = useEntryJob(ctx.jobId);
  const methods = useMemo(() => filterAndOrder(registryMethods, { locale, country }), [registryMethods, locale, country]);
  const redirects = methods.filter((m) => m.kind === 'redirect');
  const forms = methods.filter((m) => m.kind === 'form');
  const emailEntry = forms.find((m) => m.id === 'email_password');
  const otherForms = forms.filter((m) => m.id !== 'email_password');
  // GoApply keeps email behind a link when another way to sign in exists (G0 row 6).
  const emailBehindLink = brand.market === 'cn' && (otherForms.length > 0 || redirects.length > 0);

  const errorCode = params?.get('error');
  // A job title appears only when the looked-up job exists (never from the URL).
  const title =
    mode === 'signup'
      ? ctx.kind === 'apply' && job
        ? t('contextual.signupApply', { jobTitle: job.title })
        : ctx.kind === 'job' && job
          ? t('contextual.signupJob', { jobTitle: job.title })
          : ctx.kind === 'resume_check'
            ? t('contextual.signupResumeCheck')
            : t('contextual.signupDefault')
      : ctx.kind === 'apply' && job
        ? t('contextual.loginApply', { jobTitle: job.title })
        : t('login.title');
  const subtitle = mode === 'signup' ? t('contextual.signupSubtitle') : t('login.subtitle');

  const entryValue = {
    mode,
    agreements: mode === 'signup' ? { ...agreements, pdpaRequired } : null,
    setAgreements: mode === 'signup' ? (a: SignupAgreements) => setAgreements({ age: a.age, pdpa: a.pdpa, marketing: a.marketing }) : undefined,
    attribution: attributionFrom(params, typeof window !== 'undefined' ? window.location.pathname : undefined),
    next,
    locale,
  };

  const render = (m: AuthMethodEntry) => {
    const Method = AUTH_METHOD_COMPONENTS[m.id];
    return <Method key={m.id} mode={mode} next={next} />;
  };

  const query = carriedQuery(params);

  return (
    <div className="auth-card" data-auth-mode={mode}>
      <AuthBrandMark className="auth-card__brand" />
      <h1 className="auth-title">{title}</h1>
      <p className="auth-subtitle">{subtitle}</p>

      {errorCode && OAUTH_ERRORS.has(errorCode) ? (
        <div style={{ marginTop: 24 }}>
          <AuthError message={t(OAUTH_ERROR_KEYS[errorCode] ?? 'loginForm.oauthError')} />
        </div>
      ) : null}

      <AuthEntryProvider value={entryValue}>
        {otherForms.length > 0 ? <div className={styles.methods}>{otherForms.map(render)}</div> : null}
        {redirects.length > 0 ? <div className={styles.methods}>{redirects.map(render)}</div> : null}
        {emailEntry ? (
          emailBehindLink && !showEmail ? (
            <div className={styles.methods}>
              <button type="button" className={styles.oauthButton} onClick={() => setShowEmail(true)}>
                {t('methods.useEmail')}
              </button>
            </div>
          ) : (
            <>
              {redirects.length > 0 || otherForms.length > 0 ? (
                <div className={styles.divider} role="separator">
                  {t('common.or')}
                </div>
              ) : null}
              {render(emailEntry)}
            </>
          )
        ) : null}
      </AuthEntryProvider>

      <p className="auth-switch">
        {mode === 'signup' ? (
          <>
            {t('signup.has_account')} <Link href={`/login${query}`}>{t('signup.login_cta')}</Link>
          </>
        ) : (
          <>
            {t('login.no_account')} <Link href={`/signup${query}`}>{t('login.signup_cta')}</Link>
          </>
        )}
      </p>
    </div>
  );
}
