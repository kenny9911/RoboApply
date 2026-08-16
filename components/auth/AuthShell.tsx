'use client';

// Auth chrome for the login / signup split-screen surface.
//
//  • AuthBrandPanel — the desktop-only left hero (brand mark + value props).
//  • AuthBrandMark  — the wordmark, reused compactly on mobile where the panel
//                     is hidden. Intentionally NOT a <Link> (an unauthenticated
//                     click on /home would just bounce back through the gate).
//  • AuthField      — a labelled input styled on the V3 bare tokens.
//
// All visuals live in styles/auth.css (.auth-*), so dark/light + data-accent
// flips come for free.

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '../../lib/utils';

function SparkMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--action)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      </svg>
    </span>
  );
}

export function AuthBrandMark({ className }: { className?: string }) {
  const t = useTranslations('auth.brand');
  return (
    <span className={cn('brand', className)} aria-label="RoboApply">
      <SparkMark />
      <span className="brand-name">
        RoboApply
        <small>{t('tagline')}</small>
      </span>
    </span>
  );
}

function FeatureCheck() {
  return (
    <span className="auth-feature__dot" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}

export function AuthBrandPanel() {
  const t = useTranslations('auth.brand');
  return (
    <aside className="auth-brand">
      <div className="auth-brand__glow" aria-hidden="true" />
      <AuthBrandMark />
      <div className="auth-brand__inner">
        <p className="auth-eyebrow">{t('eyebrow')}</p>
        {/* The headline is one continuous string in one family (ruling R4). The
         * message still carries legacy <em> markup, so the tag handler stays —
         * it now renders the chunks inline instead of an italic-serif accent. */}
        <p className="auth-headline">
          {t.rich('headline', { em: (chunks) => <>{chunks}</> })}
        </p>
        <p className="auth-lead">{t('lead')}</p>
        <ul className="auth-features">
          <li className="auth-feature"><FeatureCheck />{t('feature_resume')}</li>
          <li className="auth-feature"><FeatureCheck />{t('feature_interview')}</li>
          <li className="auth-feature"><FeatureCheck />{t('feature_track')}</li>
        </ul>
      </div>
      <p className="auth-brand__foot">© RoboApply</p>
    </aside>
  );
}

export function AuthError({ message }: { message: string }) {
  return (
    <div className="auth-error" role="alert">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

type AuthFieldProps = InputHTMLAttributes<HTMLInputElement> & { label: ReactNode };

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
      <label htmlFor={fieldId} className="auth-field__label">{label}</label>
      <div className="auth-field__control">
        <input
          id={fieldId}
          className={cn('auth-field__input', isPassword && 'auth-field__input--reveal')}
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
            tabIndex={-1}
          >
            <EyeIcon off={revealed} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
