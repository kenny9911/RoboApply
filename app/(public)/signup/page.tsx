'use client';

// Signup — the consumer-facing form card on the right of the auth split screen
// (the brand hero is rendered by (public)/layout.tsx). Presentation only: the
// auth data flow (signup → refresh → /jobs) is unchanged from the placeholder
// apart from the destination.

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { signup } from '../../../lib/api/auth';
import { useAuth } from '../../../lib/auth/AuthProvider';
import { Btn } from '../../../components/v3/primitives/Btn';
import { AuthBrandMark, AuthField, AuthError } from '../../../components/auth/AuthShell';

export default function SignupPage() {
  const t = useTranslations('auth.signup');
  // The language the visitor actually read the site in. Sent with the signup so
  // the backend seeds SeekerProfile.locale from an explicit choice instead of
  // guessing from Accept-Language — without it, someone who browsed in Chinese
  // but has an English-first browser gets English LLM output forever.
  const locale = useLocale();
  const router = useRouter();
  const { refresh } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signup({ email, password, name: name || undefined, locale });
      await refresh();
      // Straight into the product. The two interstitials that used to sit here
      // are deleted: /choose-plan asked for a payment decision before the user
      // had seen a single job, and /onboarding asked a chat's worth of setup
      // questions before showing anything. Plans live in /settings, and setup
      // is a panel in the /jobs filter bar (ruling C21).
      router.replace('/jobs');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('error_generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-card">
      <AuthBrandMark className="auth-card__brand" />
      <h1 className="auth-title">{t('title')}</h1>
      <p className="auth-subtitle">{t('subtitle')}</p>

      <form onSubmit={onSubmit} className="auth-form">
        <AuthField
          label={t('name')}
          type="text"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <AuthField
          label={t('email')}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label={t('password')}
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <AuthError message={error} /> : null}
        <Btn
          type="submit"
          variant="primary"
          className="auth-submit"
          disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? t('submitting') : t('submit')}
        </Btn>
      </form>

      <p className="auth-switch">
        {t('has_account')}{' '}
        <Link href="/login">{t('login_cta')}</Link>
      </p>
    </div>
  );
}
