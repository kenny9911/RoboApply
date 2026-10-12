'use client';

// SignupLink — every marketing CTA (PRODUCT §3.2): `/signup?from=<slug>`,
// carrying `job`, `ref` and `utm_*` from the current URL.

import Link from 'next/link';
import type { ReactNode } from 'react';

import { useSignupHref } from './hooks';
import styles from './marketing.module.css';

export interface SignupLinkProps {
  /** Page slug for attribution (`home`, `pricing`, `feature:job-matches`, …). */
  from: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'sm';
  className?: string;
}

export function SignupLink({ from, children, variant = 'primary', size = 'md', className }: SignupLinkProps) {
  const href = useSignupHref(from);
  const cls = [variant === 'primary' ? styles.ctaPrimary : styles.ctaSecondary, size === 'sm' ? styles.ctaSmall : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Link href={href} className={cls} data-cta-from={from}>
      {children}
    </Link>
  );
}
