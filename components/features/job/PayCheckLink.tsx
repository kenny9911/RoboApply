'use client';

// PayCheckLink — "See what postings pay for this title", beside the job's
// stated pay: opens the pay check (/pay) for the job's title, where the job is
// (remote jobs for a remote job, else the job's own location). The pay check
// reads the job posts, so the link follows the job feed (`jobs.feed`): where
// the feed is off (GoApply with CN_RECRUITMENT_INFO_MODE=off) there is no link
// (R-04), as there is no nav entry.
//
//   variant 'inline' (default): the link alone, for the header's pay row;
//   variant 'line': the link on its own line, under GoApply's market block,
//   which prints the pay there in place of the header.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useFlag } from '../../../lib/flags';
import { payCheckHrefForJob } from '../pay';
import styles from './job.module.css';

export interface PayCheckLinkProps {
  job: { title: string; location?: string | null; workModel?: string | null };
  variant?: 'inline' | 'line';
}

export function PayCheckLink({ job, variant = 'inline' }: PayCheckLinkProps) {
  const t = useTranslations('jobDetail.header');
  const feed = useFlag('jobs.feed');
  if (!feed || !job.title?.trim()) return null;
  const link = (
    <Link className={styles.payCheckLink} href={payCheckHrefForJob(job)} data-testid="job-pay-check">
      {t('payCheck')}
    </Link>
  );
  return variant === 'line' ? <p className={styles.payCheckLine}>{link}</p> : link;
}
