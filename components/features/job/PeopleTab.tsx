'use client';

// PeopleTab — "People at {company}" (PRODUCT F-NET-02/03). MVP: three LinkedIn
// people searches the user opens themselves; we look nobody up and contact
// nobody. The `PeoplePanel` slot (WP-54) adds imported connections and opted-in
// hiring contacts in V2 (and the GoApply 内推 hub).

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { PeoplePanel } from '../network';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import styles from './job.module.css';

export function PeopleTab({ detail }: { detail: JobDetailResponse }) {
  const t = useTranslations('jobDetail.people');
  const { job, company, people } = detail;
  const companyName = company.name || job.companyName;
  return (
    <div className={styles.main} data-testid="job-people">
      {people.searchLinks.length ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('title', { company: companyName })}</h3>
          <p className={styles.muted}>{t('intro')}</p>
          <ul className={styles.list}>
            {people.searchLinks.map((l) =>
              l.url ? (
                <li key={l.kind}>
                  <a className={styles.peopleLink} href={l.url} target="_blank" rel="noopener noreferrer" data-people-link={l.kind}>
                    <span>{t(l.kind, l.params)}</span>
                    <span className={styles.muted}>{t('opensLinkedIn')}</span>
                  </a>
                </li>
              ) : (
                <li key={l.kind} className={styles.muted} data-people-missing={l.kind}>
                  {t(l.kind === 'past_companies' ? 'need_past_companies' : 'need_schools', { company: companyName })}{' '}
                  <Link className={styles.linkBtn} href="/profile">
                    {t('editProfile')}
                  </Link>
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}
      <PeoplePanel jobId={job.id} companyId={company.id} companyName={companyName} />
    </div>
  );
}
