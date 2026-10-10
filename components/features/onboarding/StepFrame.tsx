'use client';

// StepFrame — the shared layout of every onboarding screen (WP-30): progress,
// a plain heading, the body, and the Back · Skip · Next footer (PRODUCT §4.1:
// Back always works and keeps answers; Skip on every step after the account
// step except the situation step). "Finish later" leaves onboarding early
// (POST /onboarding/skip) and lands on the jobs page with the finish banner.

import type { FormEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import styles from './onboarding.module.css';

export interface StepFrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 1-based screen position and total screens (for the progress line). */
  position?: { current: number; total: number } | null;
  children: ReactNode;
  /** Optional side column (market snapshot, capability cards). */
  aside?: ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  /** Submit handler; the Next button submits the form. */
  onNext?: () => void;
  nextLabel?: ReactNode;
  nextDisabled?: boolean;
  skipLabel?: ReactNode;
  busy?: boolean;
  error?: ReactNode;
  onLeave?: () => void;
  /** Hide the footer (O6 renders its own actions). */
  hideFooter?: boolean;
}

export function StepFrame({
  title,
  subtitle,
  position,
  children,
  aside,
  onBack,
  onSkip,
  onNext,
  nextLabel,
  nextDisabled,
  skipLabel,
  busy,
  error,
  onLeave,
  hideFooter,
}: StepFrameProps) {
  const t = useTranslations('onboarding.frame');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && !nextDisabled) onNext?.();
  };
  const pct = position ? Math.round((position.current / Math.max(1, position.total)) * 100) : 0;

  return (
    <form className={`${styles.frame} ${aside ? styles.frameWide : ''}`} onSubmit={submit} noValidate aria-busy={busy || undefined}>
      <header>
        {position ? (
          <>
            <p className={styles.progress}>{t('progress', { current: position.current, total: position.total })}</p>
            <div className={styles.progressBar} aria-hidden="true">
              <div className={styles.progressFill} style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : null}
        <h1 className={styles.title} style={{ marginTop: position ? 'var(--sp-4)' : 0 }}>
          {title}
        </h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </header>

      <div className={aside ? styles.layout : undefined}>
        <div className={styles.body}>{children}</div>
        {aside ? <aside className={styles.aside}>{aside}</aside> : null}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {hideFooter ? null : (
        <div className={styles.footer}>
          {onBack ? (
            <Btn type="button" variant="ghost" onClick={onBack} disabled={busy} className={styles.touch}>
              {t('back')}
            </Btn>
          ) : null}
          {onLeave ? (
            <button type="button" className={styles.leave} onClick={onLeave} disabled={busy} title={t('leaveHint')}>
              {t('leave')}
            </button>
          ) : null}
          <span className={styles.footerSpacer} />
          {onSkip ? (
            <Btn type="button" onClick={onSkip} disabled={busy} className={styles.touch}>
              {skipLabel ?? t('skip')}
            </Btn>
          ) : null}
          {onNext ? (
            <Btn type="submit" variant="primary" disabled={busy || nextDisabled} className={styles.touch}>
              {busy ? t('saving') : (nextLabel ?? t('next'))}
            </Btn>
          ) : null}
        </div>
      )}
    </form>
  );
}
