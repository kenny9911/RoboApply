'use client';

// Shared authentication chrome: a calm entry point, clear benefits, and
// accessible form controls. Account actions remain in the route components.
// WP-10: brand-neutral (the wordmark and footer read the current brand), and
// the brand panel's lead follows the entry context (`from=resume-check`,
// `action=apply`, `from=job`). Proof points are capabilities only — never
// user counts or unverified multipliers.

import {
  useId,
  useState,
  useTransition,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ThemeToggle } from '../v3/shell/ThemeToggle';
import { BrandSymbol } from '../chrome/BrandSymbol';
import { setLocaleCookie } from '../../lib/locale';
import { useLocale, useTranslations } from 'next-intl';
import { isLocale, localePath } from '../../lib/localeConfig';
import { brandSwitcherLocales } from '../features/brand';
import { cn } from '../../lib/utils';
import { useBrand } from '../../lib/brand/BrandProvider';
import { useFlag } from '../../lib/flags';
import { entryContext } from '../../lib/auth/entry';
import { useEntryJob } from '../../hooks/auth/useAuthAccount';

function AuthLogoSymbol() {
  return (
    <span className="auth-brand-mark" aria-hidden="true">
      <BrandSymbol size={24} />
    </span>
  );
}

export function AuthBrandMark({ className }: { className?: string }) {
  const locale = useLocale();
  const brand = useBrand();
  return (
    <Link
      href={localePath(isLocale(locale) ? locale : 'en')}
      className={cn('auth-wordmark', className)}
      aria-label={brand.name}
    >
      <AuthLogoSymbol />
      <span>
        {brand.name}
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
  const brand = useBrand();
  const [pending, startTransition] = useTransition();
  // Only the brand's own locales (nine on RoboApply, zh/en on GoApply; WP-12).
  const languages = brandSwitcherLocales(brand.locales);
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
        {languages.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
      {/* The app's own toggle, so the icon means the same thing before and after
          sign-in (it shows the current appearance; the label says what a press
          switches to). The auth pages used the landing's toggle, whose icon
          showed the appearance a press would switch to. */}
      <ThemeToggle className={AUTH_THEME_TOGGLE_CLASS} />
    </div>
  );
}

/** The round, bordered control the auth header uses (tokens only). */
const AUTH_THEME_TOGGLE_CLASS =
  'inline-flex h-9 w-9 items-center justify-center rounded-[var(--r-pill)] border border-[color:var(--rule)] text-[color:var(--text-2)] transition-colors duration-[var(--dur-hover)] hover:border-[color:var(--rule-strong)] hover:text-[color:var(--text)]';

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

/**
 * The panel's lead line for the entry context (resume check, a job, applying).
 * The job's title and company come from looking up the `job` id; nothing is
 * shown for a job that cannot be found.
 */
function ContextLead() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const ctx = entryContext(params);
  const job = useEntryJob(ctx.jobId);
  if (ctx.kind === 'resume_check') return <p className="auth-lead">{t('panel.resumeCheck')}</p>;
  if (ctx.kind === 'resume_job_match') return <p className="auth-lead">{t('panel.resumeJobMatch')}</p>;
  if ((ctx.kind === 'apply' || ctx.kind === 'job') && job) {
    return (
      <p className="auth-lead">
        {job.companyName ? t('panel.jobAtCompany', { jobTitle: job.title, company: job.companyName }) : t('panel.job', { jobTitle: job.title })}
      </p>
    );
  }
  return null;
}

export function AuthBrandPanel() {
  const t = useTranslations('auth.brand');
  const brand = useBrand();
  // "Practice interviews that talk back" is only said where the spoken
  // interview is on for this brand (`ai.interviewVoice`; off on GoApply,
  // where practice is written). Fails closed: unknown reads as off.
  const voice = useFlag('ai.interviewVoice');
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
        <ContextLead />
        <ul className="auth-features">
          <li className="auth-feature">
            <FeatureCheck />
            {t('feature_resume')}
          </li>
          <li className="auth-feature">
            <FeatureCheck />
            {voice ? t('feature_interview') : t('feature_interview_written')}
          </li>
          <li className="auth-feature">
            <FeatureCheck />
            {t('feature_track')}
          </li>
        </ul>
      </div>
      <p className="auth-brand__foot">© {brand.name}</p>
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
