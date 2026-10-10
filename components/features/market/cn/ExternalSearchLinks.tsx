'use client';

// ExternalSearchLinks — "search other job sites" for the user's own query
// (CN L-5): BOSS直聘 / 智联招聘 / 猎聘 search pages in a new tab. We never
// fetch, fill or greet on those sites; the link carries only the query
// (built server-side, GET /cn/jobs/external-links). GoApply only: renders
// nothing elsewhere or without a query.

import { useTranslations } from 'next-intl';

import { useBrand } from '../../../../lib/brand/BrandProvider';
import { useExternalLinks } from './useCnJobs';
import styles from './cnJobs.module.css';

export interface ExternalSearchLinksProps {
  /** The user's own search words. */
  query: string;
  city?: string | null;
  className?: string;
}

export function ExternalSearchLinks({ query, city, className }: ExternalSearchLinksProps) {
  const brand = useBrand();
  const isCn = brand.market === 'cn';
  const t = useTranslations('jobsCn.external');
  const q = isCn ? query.trim() : '';
  const links = useExternalLinks(q, city);
  if (!q) return null;

  return (
    <section className={[styles.external, className].filter(Boolean).join(' ')} aria-labelledby="cn-external-h" data-testid="cn-external-links">
      <h3 className={styles.h3} id="cn-external-h">
        {t('title')}
      </h3>
      <p className={styles.muted}>{t('sub', { query: q })}</p>
      {links.isLoading ? (
        <p className={styles.muted} aria-busy="true">
          {t('loading')}
        </p>
      ) : links.isError ? (
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
      ) : (
        <ul className={styles.linkList}>
          {(links.data?.links ?? []).map((l) => (
            <li key={l.board}>
              <a className={styles.extLink} href={l.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
                {t('link', { board: l.label })}
                <span className={styles.srOnly}> {t('newTab')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ExternalSearchLinks;
