'use client';

// HonestyLine — one of the required honesty strings, word for word
// (PRODUCT_PLAN.md F-TRUST-05; components/features/common/honesty.ts):
//
//   fit             This is not your chance of getting hired.
//   ai_written      Written with AI. Check every line before you use it.
//   search_results  Search results, not verified.
//   sponsorship     From what the job post says. Confirm sponsorship with the employer.
//   you_submit      You submit each application yourself.

import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { HONESTY_KEYS, type HonestyKind } from '../../features/common';
import styles from './primitives.module.css';

export interface HonestyLineProps {
  kind: HonestyKind;
  className?: string;
}

export function HonestyLine({ kind, className }: HonestyLineProps) {
  const t = useTranslations();
  return (
    <p className={cn(styles.honesty, className)} data-honesty={kind}>
      {t(HONESTY_KEYS[kind])}
    </p>
  );
}
