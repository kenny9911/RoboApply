'use client';

// SalaryCn — GoApply pay line (F-SAL-01 cn). The posting's own words or the
// structured pay in mainland notation ("15-25K·13薪", "200-300元/天"); when
// the posting gives no figure, "薪资未披露" / "Pay not listed". Never estimated.

import { useTranslations } from 'next-intl';

import styles from './cnJobs.module.css';

export interface SalaryCnProps {
  text: string | null;
  disclosed: boolean;
  className?: string;
}

export function SalaryCn({ text, disclosed, className }: SalaryCnProps) {
  const t = useTranslations('jobsCn.salary');
  const shown = disclosed && text ? text : null;
  return (
    <span className={[styles.salary, shown ? '' : styles.muted, className].filter(Boolean).join(' ')} data-disclosed={shown ? 'true' : 'false'}>
      {shown ?? t('notDisclosed')}
    </span>
  );
}

export default SalaryCn;
