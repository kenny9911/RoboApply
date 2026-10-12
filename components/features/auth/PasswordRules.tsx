'use client';

// PasswordRules — the inline rule checklist under the signup password
// (PRODUCT_PLAN.md O0 row 6): at least 8 characters, a letter, a digit.

import { useTranslations } from 'next-intl';
import { cn } from '../../../lib/utils';
import styles from './auth.module.css';

export function passwordChecks(pw: string) {
  return { length: pw.length >= 8, letter: /[A-Za-z]/.test(pw), digit: /\d/.test(pw) };
}

export function passwordOk(pw: string): boolean {
  const c = passwordChecks(pw);
  return c.length && c.letter && c.digit;
}

export function PasswordRules({ password, id }: { password: string; id?: string }) {
  const t = useTranslations('auth');
  const checks = passwordChecks(password);
  const rows: Array<[keyof typeof checks, string]> = [
    ['length', t('signupForm.ruleLength')],
    ['letter', t('signupForm.ruleLetter')],
    ['digit', t('signupForm.ruleDigit')],
  ];
  return (
    <ul className={styles.rules} id={id} aria-label={t('signupForm.rulesLabel')}>
      {rows.map(([key, label]) => (
        <li key={key} className={cn(styles.rule, checks[key] && styles.ruleMet)} data-met={checks[key] ? 'true' : 'false'}>
          <span className={styles.ruleMark} aria-hidden="true">
            {checks[key] ? '✓' : '·'}
          </span>
          <span>
            {label}
            <span className="sr-only">{checks[key] ? ` ${t('signupForm.ruleMet')}` : ''}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
