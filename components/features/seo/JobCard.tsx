'use client';

// JobCard — one public job on a browse page: title (links to the public job
// page), company, place, work model, pay only as the posting lists it,
// posted date (or "found" when the posted date was estimated), source, and
// the posting's sponsorship sentence on sponsorship lists.

import Link from 'next/link';

import type { PublicJobCard } from '../../../lib/api/contracts/seo';
import { useSeoFormat } from './labels';
import styles from './seo.module.css';

export function JobCard({ job, showQuote = false }: { job: PublicJobCard; showQuote?: boolean }) {
  const { t, date, pay, workModel, employment } = useSeoFormat();
  const posted = date(job.postedAt);
  const payLine = pay(job.pay);
  const facts = [job.location, workModel(job.workModel), employment(job.employmentType), payLine ?? t('card.payNotListed')].filter(Boolean) as string[];
  return (
    <article className={styles.card} data-job-id={job.id}>
      <h3 className={styles.cardTitle}>
        <Link className={styles.cardLink} href={job.path}>
          {job.title}
        </Link>
      </h3>
      <p className={styles.company}>{job.companyName}</p>
      <ul className={styles.meta}>
        {facts.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
        <li>{posted ? t('card.posted', { date: posted }) : t('card.found', { date: date(job.firstSeenAt) ?? '—' })}</li>
        {job.sourceName ? <li>{t('card.source', { sourceName: job.sourceName })}</li> : null}
      </ul>
      {showQuote && job.sponsorshipQuote ? <p className={styles.quote}>{t('card.sponsorQuote', { quote: job.sponsorshipQuote })}</p> : null}
    </article>
  );
}
