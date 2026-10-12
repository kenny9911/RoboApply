'use client';

// CompanyNews — recent news from a web search (PRODUCT F-JOB-04, V2). Always
// labelled "Search results, not verified by %BRAND%"; each item shows the
// publisher, the date the result states (or "Date not listed") and a link.

import { useFormatter, useTranslations } from 'next-intl';

import { useCompanyNews } from '../../../hooks/job';
import styles from './company.module.css';

export function CompanyNews({ jobId }: { jobId: string }) {
  const t = useTranslations('jobDetail.company.news');
  const format = useFormatter();
  const q = useCompanyNews(jobId, { enabled: true });
  return (
    <section className={styles.section} data-testid="company-news">
      <h3 className={styles.title}>{t('title')}</h3>
      <p className={styles.label}>{t('label')}</p>
      {q.isPending ? (
        <p className={styles.muted} role="status">
          {t('loading')}
        </p>
      ) : q.isError ? (
        <p className={styles.muted} role="alert">
          {t('error')}
        </p>
      ) : q.data.items.length ? (
        <ul className={styles.news}>
          {q.data.items.map((n) => {
            const date = n.publishedAt ? new Date(n.publishedAt) : null;
            return (
              <li key={n.url} className={styles.newsItem}>
                <a href={n.url} target="_blank" rel="noopener noreferrer nofollow" className={styles.newsLink}>
                  {n.title}
                </a>
                <span className={styles.muted}>
                  {n.publisher} · {date && !Number.isNaN(date.getTime()) ? format.dateTime(date, { dateStyle: 'medium' }) : t('undated')}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.muted}>{t('empty')}</p>
      )}
    </section>
  );
}
