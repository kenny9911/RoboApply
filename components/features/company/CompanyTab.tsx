'use client';

// CompanyTab — the job's Company tab (PRODUCT F-JOB-04). Only sourced facts:
// each one names its source through SourceNote; anything we don't have
// renders "Not listed". The open-job count is our own count of public rows
// ("{n} open jobs at {company} in %BRAND%"). No funding, ratings or
// leadership (flag `companyFunding` stays off until a licensed provider);
// recent news is V2, behind its own flag, labelled as search results.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { SourceNote } from '../common';
import { useCompanyJobs } from '../../../hooks/job';
import type { CompanySummary } from '../../../lib/api/contracts/jobs/detail';
import { CompanyNews } from './CompanyNews';
import styles from './company.module.css';

export interface CompanyTabProps {
  jobId: string;
  company: CompanySummary;
  /** V2 news block (flag `companyNews`). */
  showNews: boolean;
  /** Open another job (the panel decides: split view or full page). */
  onOpenJob?: (jobId: string) => void;
}

const FACT_ORDER = ['industry', 'size', 'headquarters', 'founded', 'website'] as const;

export function CompanyTab({ jobId, company, showNews, onOpenJob }: CompanyTabProps) {
  const t = useTranslations('jobDetail.company');
  const jobs = useCompanyJobs(company.id);
  const others = (jobs.data?.items ?? []).filter((j) => j.jobId !== jobId).slice(0, 5);
  const description = company.facts.description;

  return (
    <div className={styles.tab} data-testid="company-tab">
      <section className={styles.section}>
        <h3 className={styles.title}>{t('title', { company: company.name })}</h3>
        {!company.id ? <p className={styles.muted}>{t('noRecord')}</p> : null}
        <dl className={styles.facts} aria-label={t('factsLabel')}>
          {FACT_ORDER.map((key) => {
            const fact = company.facts[key];
            return (
              <div key={key} className={styles.fact} data-fact={key}>
                <dt className={styles.factLabel}>{t(`fact.${key}`)}</dt>
                <dd className={styles.factValue}>
                  {fact ? (
                    <>
                      {key === 'website' && /^https?:\/\//i.test(String(fact.value)) ? (
                        <a href={String(fact.value)} target="_blank" rel="noopener noreferrer">
                          {String(fact.value).replace(/^https?:\/\//, '')}
                        </a>
                      ) : key === 'size' ? (
                        t('sizeValue', { size: String(fact.value) })
                      ) : (
                        String(fact.value)
                      )}
                      <SourceNote sourced={fact} className={styles.source} />
                    </>
                  ) : (
                    <span className={styles.muted}>{t('notListed')}</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {description ? (
          <div className={styles.about}>
            <p className={styles.factLabel}>{t('fact.description')}</p>
            <p className={styles.body}>{description.value}</p>
            <SourceNote sourced={description} className={styles.source} />
          </div>
        ) : null}
        <div data-testid="company-open-jobs">
          <p className={styles.body}>
            {company.openJobs
              ? t('openJobs', { count: company.openJobs.value, company: company.name })
              : t('openJobsUnknown', { company: company.name })}
          </p>
          {company.openJobs ? <SourceNote sourced={company.openJobs} className={styles.source} /> : null}
        </div>
      </section>

      {company.id ? (
        <section className={styles.section}>
          <h3 className={styles.title}>{t('jobsTitle', { company: company.name })}</h3>
          {jobs.isSuccess && !others.length ? <p className={styles.muted}>{t('jobsEmpty')}</p> : null}
          {others.length ? (
            <ul className={styles.jobs}>
              {others.map((j) => (
                <li key={j.jobId}>
                  <Link
                    className={styles.jobLink}
                    href={`/jobs/${encodeURIComponent(j.jobId)}`}
                    onClick={(e) => {
                      if (onOpenJob && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
                        e.preventDefault();
                        onOpenJob(j.jobId);
                      }
                    }}
                  >
                    <span className={styles.jobTitle}>{j.title}</span>
                    {j.location ? <span className={styles.muted}>{j.location}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {showNews ? <CompanyNews jobId={jobId} /> : null}
    </div>
  );
}
