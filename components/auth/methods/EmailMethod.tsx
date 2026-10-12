'use client';

// EmailMethod — email + password sign-in and sign-up (both brands; GoApply's
// fallback). WP-10, PRODUCT_PLAN.md O0.
//
//   login   email · password · "Forgot password?" (only when reset is
//           available) → /auth/login → /auth/me → the onboarding screen when
//           unfinished, else `next`, else /jobs (sign-in only, never on every
//           page view). A 409 account_other_brand (password matched an
//           account of the other brand) shows the "continue there" notice.
//           A 401 two_factor_required (the password matched an account with
//           two-step sign-in on; no session exists yet) goes to /login/2fa,
//           carrying `next`.
//   signup  email · password with its rule checklist · the agreements
//           (marketing unchecked, required age, PDPA for zh-TW/TW) →
//           /auth/signup → the first onboarding screen. An email that belongs
//           to the other brand gets the same "check your email" screen.
//           GoApply: its own agreement boxes (the user agreement, the age
//           confirmation and, while data is processed outside the mainland,
//           the separate cross-border consent) and, only when the operator
//           made sign-up invite-only, the invite code. They are the same
//           boxes the phone form shows (one shared set); this form renders
//           them unless the phone form is on the page. Each box shows the text the
//           sign-up policy serves, and the form sends that text's hash, so
//           the stored consent record names what was on screen. If the text
//           changed meanwhile (422 consent_required, `outdated`), the new
//           text is loaded and the boxes are asked again.
//           A `next` to a free-tool page wins over the first onboarding
//           screen (the visitor asked to keep a result there).
// No partial-signup capture: nothing is sent before the visitor submits.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { login, signup } from '../../../lib/api/auth';
import { RoboApiError } from '../../../lib/api/client';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { signInRoute } from '../../../lib/auth/signInRoute';
import { browserTimeZone, priorityNext } from '../../../lib/auth/entry';
import { isTwoFactorRequired, twoFactorHref } from '../../../lib/auth/twoFactor';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { useFlag } from '../../../lib/flags';
import { Btn } from '../../v3/primitives/Btn';
import { AuthError, AuthField } from '../AuthShell';
import { agreementsComplete, consentsFrom, useAuthEntry } from '../agreements';
import { AgreementsFields } from '../../features/auth/AgreementsFields';
import { OtherBrandNotice, otherBrandUrlOf } from '../../features/auth/OtherBrandNotice';
import { PasswordRules, passwordOk } from '../../features/auth/PasswordRules';
import {
  InviteCodeField,
  SignupConsents,
  agreementSatisfied,
  authCnErrorMessage,
  isConsentOutdated,
  shownConsentsFromPolicy,
  signupInputs,
  useSignupInputs,
  useSignupInputsHost,
  useSignupPolicy,
} from '../../features/auth-cn';
import styles from '../../features/auth/auth.module.css';
import type { AuthMethodProps } from './registry';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rawCode(err: unknown): string | undefined {
  if (!(err instanceof RoboApiError)) return undefined;
  return (err.payload as { code?: string } | undefined)?.code ?? err.code;
}

export function EmailMethod({ mode, next, onSuccess }: AuthMethodProps) {
  return mode === 'signup' ? <SignupForm next={next} onSuccess={onSuccess} /> : <LoginForm next={next} onSuccess={onSuccess} />;
}

function LoginForm({ next, onSuccess }: Pick<AuthMethodProps, 'next' | 'onSuccess'>) {
  const t = useTranslations('auth');
  const router = useRouter();
  const { refresh } = useAuth();
  const entry = useAuthEntry();
  const resetAvailable = useFlag('auth.passwordReset');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [otherBrandUrl, setOtherBrandUrl] = useState<string | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOtherBrandUrl(undefined);
    setSubmitting(true);
    try {
      await login({ email, password });
      const me = await refresh();
      // login() set the cookie, but without a /me the session is unusable:
      // stay on the form rather than entering the app on empty defaults.
      if (!me) {
        setError(t('login.error_generic'));
        return;
      }
      onSuccess?.();
      router.replace(signInRoute(me, next ?? entry?.next ?? null));
    } catch (err) {
      // Two-step sign-in: the password was right; the authenticator code is next.
      if (isTwoFactorRequired(err)) {
        router.replace(twoFactorHref(err, next ?? entry?.next ?? null));
        return;
      }
      const code = rawCode(err);
      if (code === 'account_other_brand') setOtherBrandUrl(otherBrandUrlOf((err as RoboApiError).payload));
      else if (code === 'account_disabled') setError(t('loginForm.disabled'));
      else if (code === 'account_deleted') setError(t('loginForm.deleted'));
      else if (code === 'rate_limited') setError(t('errors.rateLimited'));
      else if (code === 'network_error' || code === 'server_error') setError(t('errors.network'));
      else setError(t('login.error_generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="auth-form" noValidate>
      <AuthField
        label={t('login.email')}
        type="email"
        name="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <AuthField
        label={t('login.password')}
        type="password"
        name="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {resetAvailable ? (
        <div className={styles.linkRow}>
          <Link href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : '/forgot-password'}>{t('loginForm.forgot')}</Link>
        </div>
      ) : null}
      {otherBrandUrl !== undefined ? <OtherBrandNotice url={otherBrandUrl} /> : null}
      {error ? <AuthError message={error} /> : null}
      <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting || !email || !password} aria-busy={submitting}>
        {submitting ? t('login.submitting') : t('login.submit')}
      </Btn>
    </form>
  );
}

function SignupForm({ next, onSuccess }: Pick<AuthMethodProps, 'next' | 'onSuccess'>) {
  const t = useTranslations('auth');
  const tCn = useTranslations('authCn');
  const router = useRouter();
  const { refresh } = useAuth();
  const entry = useAuthEntry();
  const brand = useBrand();
  const cn = brand.market === 'cn';
  const agreements = entry?.agreements ?? { age: false, pdpa: false, marketing: false, pdpaRequired: false };

  // GoApply: the agreement boxes and the invite code live in the store the
  // phone form and the WeChat button share. This form shows them unless the
  // phone form is on the page too (one set of boxes; `useSignupInputsHost`).
  const policyQuery = useSignupPolicy(cn);
  const policy = policyQuery.data;
  const [cnInputs] = useSignupInputs();
  const hostsCnInputs = useSignupInputsHost('email', cn);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ key: string; signIn?: boolean; text?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const [touchedEmail, setTouchedEmail] = useState(false);
  // Submit was pressed with a bad (or empty) email: the message under the field shows even for an empty box.
  const [emailAsked, setEmailAsked] = useState(false);

  const emailValid = EMAIL_RE.test(email.trim());
  // One message, under the field, for as long as the address is not valid.
  // (It used to appear there AND in the form's error box after Submit.)
  const emailProblem = touchedEmail && !emailValid && (email !== '' || emailAsked);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!emailValid) {
      setTouchedEmail(true);
      setEmailAsked(true);
      return;
    }
    if (!passwordOk(password)) {
      setError({ key: 'signupForm.weakPassword' });
      return;
    }
    if (cn) {
      if (!agreementSatisfied(cnInputs, policy)) {
        setError({ key: 'cn', text: tCn('consent.agreeFirst') });
        return;
      }
    } else if (!agreementsComplete(agreements)) {
      setError({ key: agreements.age ? 'signupForm.pdpaRequired' : 'signupForm.ageRequired' });
      return;
    }
    setSubmitting(true);
    try {
      const invite = cnInputs.invite.trim();
      const res = await signup({
        email: email.trim().toLowerCase(),
        password,
        locale: entry?.locale,
        // GoApply: the required consents of the sign-up policy, each with the
        // hash of the text shown beside its box. The server records a consent
        // only for a text it serves, under that text's own version and hash.
        consents: cn ? shownConsentsFromPolicy(policy) : consentsFrom(agreements),
        marketingOptIn: cn ? false : agreements.marketing,
        attribution: entry?.attribution,
        timezone: browserTimeZone(),
        ...(cn && invite ? { inviteCode: invite } : {}),
      });
      if (res.status === 'check_email') {
        setCheckEmail(email.trim().toLowerCase());
        return;
      }
      const me = await refresh();
      onSuccess?.();
      const wanted = next ?? entry?.next ?? null;
      router.replace(priorityNext(wanted) ?? (('next' in res && res.next) || signInRoute(me, wanted)));
    } catch (err) {
      const code = rawCode(err);
      // GoApply's sign-up rules answer with the same codes as the phone form.
      if (cn && (code === 'invite_invalid' || code === 'consent_required')) {
        setError({ key: 'cn', text: authCnErrorMessage(err, tCn) });
        // The consent text changed while the form was open: show the new text
        // and ask again (a tick is kept per text, so the boxes come back unticked).
        if (isConsentOutdated(err)) {
          signupInputs.set({ granted: {} });
          void policyQuery.refetch();
        }
      }
      else if (code === 'email_taken') setError({ key: 'signupForm.emailTaken', signIn: true });
      else if (code === 'age_consent_required') setError({ key: 'signupForm.ageRequired' });
      else if (code === 'pdpa_consent_required') setError({ key: 'signupForm.pdpaRequired' });
      else if (code === 'weak_password' || code === 'invalid_password') setError({ key: 'signupForm.weakPassword' });
      else if (code === 'invalid_email') setError({ key: 'signupForm.emailInvalid' });
      else if (code === 'rate_limited') setError({ key: 'errors.rateLimited' });
      // Shown only when the server says sign-up is closed (GoApply with `CN_SIGNUP_MODE=closed`).
      else if (code === 'signup_closed') setError({ key: 'signupForm.closed' });
      else setError({ key: 'signup.error_generic' });
    } finally {
      setSubmitting(false);
    }
  }

  if (checkEmail) {
    return (
      <div className={`${styles.notice} ${styles.status}`} role="status" data-testid="check-email">
        <p className={styles.noticeTitle}>{t('signupForm.checkEmailTitle')}</p>
        <p>{t('signupForm.checkEmailBody', { email: checkEmail })}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="auth-form" noValidate>
      {/* The operator closed sign-up (CN_SIGNUP_MODE=closed): say so before the visitor fills the form in. */}
      {cn && policy && !policy.signupOpen ? (
        <div className={styles.notice} role="status" data-testid="signup-closed">
          <p>{tCn('signupClosed')}</p>
        </div>
      ) : null}
      <AuthField
        label={t('signup.email')}
        type="email"
        name="email"
        required
        autoComplete="email"
        value={email}
        aria-invalid={emailProblem}
        aria-describedby={emailProblem ? 'signup-email-error' : undefined}
        onBlur={() => setTouchedEmail(true)}
        onChange={(e) => setEmail(e.target.value)}
      />
      {emailProblem ? (
        <p className={styles.error} id="signup-email-error" role="alert">
          {t('signupForm.emailInvalid')}
        </p>
      ) : null}
      <div>
        <AuthField
          label={t('signup.password')}
          type="password"
          name="password"
          required
          autoComplete="new-password"
          aria-describedby="signup-password-rules"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <PasswordRules password={password} id="signup-password-rules" />
      </div>
      {cn ? (
        hostsCnInputs ? (
          <>
            {policy?.inviteRequired ? <InviteCodeField id="auth-email-invite" /> : null}
            <SignupConsents policy={policy} />
          </>
        ) : null
      ) : entry?.setAgreements ? (
        <AgreementsFields value={agreements} onChange={entry.setAgreements} />
      ) : null}
      {error ? (
        error.text ? (
          <AuthError message={error.text} />
        ) : error.signIn ? (
          <div className="auth-error" role="alert">
            <span>
              {t.rich(error.key, {
                signin: (chunks) => <Link href={`/login${typeof window !== 'undefined' ? window.location.search : ''}`}>{chunks}</Link>,
              })}
            </span>
          </div>
        ) : (
          <AuthError message={t(error.key)} />
        )
      ) : null}
      <Btn type="submit" variant="primary" className="auth-submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? t('signupForm.submitting') : t('signupForm.submit')}
      </Btn>
    </form>
  );
}

export default EmailMethod;
