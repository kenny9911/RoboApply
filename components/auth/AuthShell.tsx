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

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
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
        stroke="var(--accent-text)"
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
  const t = useTranslations('nav_v3');
  return (
    <span className={cn('brand', className)} aria-label="RoboApply">
      <SparkMark />
      <span className="brand-name">
        RoboApply
        <small>{t('brand_tagline')}</small>
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
        <p className="auth-headline">
          {t.rich('headline', { em: (chunks) => <em>{chunks}</em> })}
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

type AuthFieldProps = InputHTMLAttributes<HTMLInputElement> & { label: ReactNode };

export function AuthField({ label, id, ...rest }: AuthFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className="auth-field">
      <label htmlFor={fieldId} className="auth-field__label">{label}</label>
      <input id={fieldId} className="auth-field__input" {...rest} />
    </div>
  );
}
