'use client';

// ExternalSearchLinks — "search other job sites" for the user's own query
// (CN L-5; MARKET_STRATEGY JC-5): the search pages of mainland job sites in a
// new tab. We never fetch, fill or greet on those sites; a link carries only
// the query (built server-side, GET /cn/jobs/external-links). GoApply only:
// renders nothing elsewhere or without a query.
//
// The server decides which sites are offered and their order (the sites for
// the user's audience first), and sends each site's own name; this component
// keeps that order and shows that name. When the answer holds sites for both
// audiences they are shown as two groups, the user's own group first; with
// one audience there is one list and no group heading.

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import { groupExternalLinks, type ExternalLinkView } from '../../../../lib/api/cnJobs';
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
  const id = useId();
  const q = isCn ? query.trim() : '';
  const links = useExternalLinks(q, city);
  if (!q) return null;

  const groups = links.data ? groupExternalLinks(links.data.links) : [];
  const ready = !links.isLoading && !links.isError;

  const list = (items: ExternalLinkView[]) => (
    <ul className={styles.linkList}>
      {items.map((l) => (
        <li key={l.board}>
          <a className={styles.extLink} href={l.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
            {t('link', { board: l.label })}
            <span className={styles.srOnly}> {t('newTab')}</span>
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <section className={[styles.external, className].filter(Boolean).join(' ')} aria-labelledby={`${id}-h`} data-testid="cn-external-links">
      <h3 className={styles.h3} id={`${id}-h`}>
        {t('title')}
      </h3>
      {ready && groups.length === 0 ? null : <p className={styles.muted}>{t('sub', { query: q })}</p>}
      {links.isLoading ? (
        <p className={styles.muted} aria-busy="true">
          {t('loading')}
        </p>
      ) : links.isError ? (
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
      ) : groups.length === 0 ? (
        <p className={styles.muted} data-testid="cn-external-none">
          {t('none')}
        </p>
      ) : groups.length === 1 ? (
        list(groups[0]!.links)
      ) : (
        <div className={styles.stack}>
          {groups.map((g) => (
            <div key={g.audience} className={styles.field} role="group" aria-labelledby={`${id}-${g.audience}`} data-testid="cn-external-group" data-audience={g.audience}>
              <h4 className={styles.label} id={`${id}-${g.audience}`}>
                {g.audience === 'campus' ? t('groups.campus') : t('groups.experienced')}
              </h4>
              {g.audience === 'campus' ? <p className={styles.muted}>{t('groups.campusNote')}</p> : null}
              {list(g.links)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default ExternalSearchLinks;
