'use client';

// Shared authentication chrome: a calm entry point, clear benefits, and
// accessible form controls. Account actions remain in the route components.

import {
  useId,
  useState,
  useTransition,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from '../landing/ThemeToggle';
import { BrandSymbol } from '../chrome/BrandSymbol';
import { setLocaleCookie } from '../../lib/locale';
import { useLocale, useTranslations } from 'next-intl';
import { isLocale, localePath, READY_LOCALES } from '../../lib/localeConfig';
import { cn } from '../../lib/utils';

function AuthLogoSymbol() {
  return (
    <span className="auth-brand-mark" aria-hidden="true">
      <BrandSymbol size={24} />
    </span>
  );
}

export function AuthBrandMark({ className }: { className?: string }) {
  const locale = useLocale();
  return (
    <Link
      href={localePath(isLocale(locale) ? locale : 'en')}
      className={cn('auth-wordmark', className)}
      aria-label="RoboApply"
    >
      <AuthLogoSymbol />
      <span>
        RoboApply
        <span className="auth-wordmark-period" aria-hidden="true">
          .
        </span>
      </span>
    </Link>
  );
}

/** Locale changes keep the visitor and their entered form on the auth page. */
export function AuthUtilities() {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="auth-utilities">
      <select
        aria-label={t('language')}
        value={locale}
        disabled={pending}
        onChange={(event) => {
          const language = event.target.value;
          if (!isLocale(language)) return;
          setLocaleCookie(language);
          startTransition(() => router.refresh());
        }}
      >
        {READY_LOCALES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
      <ThemeToggle />
    </div>
  );
}

function FeatureCheck() {
  return (
    <span className="auth-feature__dot" aria-hidden="true">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}

export function AuthBrandPanel() {
  const t = useTranslations('auth.brand');
  return (
    <aside className="auth-brand">
      <div className="auth-brand__path" aria-hidden="true">
        <svg
          viewBox="0 0 600 800"
          fill="none"
          preserveAspectRatio="xMidYMid slice"
        >
          <path
            d="M-180 650C20 170 715 306 496 710S50 745 236 470c137-201 357-64 344 69"
            stroke="currentColor"
            strokeWidth="1"
          />
          <path d="M572 524l8 17 13-11" stroke="currentColor" strokeWidth="1" />
          <circle cx="238" cy="469" r="7" fill="currentColor" />
        </svg>
      </div>
      <AuthBrandMark />
      <div className="auth-brand__inner">
        <p className="auth-eyebrow">{t('eyebrow')}</p>
        <p className="auth-headline">
          {t.rich('headline', { em: (chunks) => <em>{chunks}</em> })}
        </p>
        <p className="auth-lead">{t('lead')}</p>
        <ul className="auth-features">
          <li className="auth-feature">
            <FeatureCheck />
            {t('feature_resume')}
          </li>
          <li className="auth-feature">
            <FeatureCheck />
            {t('feature_interview')}
          </li>
          <li className="auth-feature">
            <FeatureCheck />
            {t('feature_track')}
          </li>
        </ul>
      </div>
      <p className="auth-brand__foot">© RoboApply</p>
    </aside>
  );
}

export function AuthError({ message }: { message: string }) {
  return (
    <div className="auth-error" role="alert">
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5h.01" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {off ? <path d="M4 20 20 4" /> : null}
    </svg>
  );
}

type AuthFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
};

export function AuthField({ label, id, type, ...rest }: AuthFieldProps) {
  const t = useTranslations('auth.field');
  const autoId = useId();
  const fieldId = id ?? autoId;
  // Password fields get a reveal toggle. `type` then follows the toggle, so the
  // browser still sees a real password input while masked (autofill + managers
  // keep working) and a plain text one while revealed.
  const isPassword = type === 'password';
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="auth-field">
      <label htmlFor={fieldId} className="auth-field__label">
        {label}
      </label>
      <div className="auth-field__control">
        <input
          id={fieldId}
          className={cn(
            'auth-field__input',
            isPassword && 'auth-field__input--reveal',
          )}
          type={isPassword && revealed ? 'text' : type}
          {...rest}
        />
        {isPassword ? (
          <button
            type="button"
            className="auth-field__reveal"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? t('hide_password') : t('show_password')}
            aria-pressed={revealed}
            aria-controls={fieldId}
          >
            <EyeIcon off={revealed} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
