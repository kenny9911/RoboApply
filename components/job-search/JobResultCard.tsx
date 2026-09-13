'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Btn } from '../v3/primitives';
import type { ProviderInfo, SearchJob } from '../../lib/api/job-search-types';
import { jobDate, jobSalary, safeJobUrl } from './format';

const PERIODS: Record<string, string> = { hour: 'salary_hour', hourly: 'salary_hour', day: 'salary_day', daily: 'salary_day', week: 'salary_week', weekly: 'salary_week', month: 'salary_month', monthly: 'salary_month', year: 'salary_year', yearly: 'salary_year', annual: 'salary_year' };
const EMPLOYMENT = { full_time: 'fulltime', part_time: 'parttime', contract: 'contractor', internship: 'intern' } as const;

export function JobResultCard({ job, providers }: { job: SearchJob; providers: ProviderInfo[] }) {
  const t = useTranslations('jobSearch');
  const locale = useLocale();
  const posted = jobDate(job.postedAt, locale);
  const fetched = jobDate(job.fetchedAt, locale);
  const salary = jobSalary(job.salary, locale);
  const periodKey = job.salary?.period ? PERIODS[job.salary.period.toLowerCase()] : null;
  const applyUrl = safeJobUrl(job.applyUrl);
  const sourceUrl = safeJobUrl(job.sourceUrl);
  const providerName = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;

  return (
    <article className="job-search-card">
      <div className="job-search-card-top">
        <div className="job-search-company-mark" aria-hidden="true">{job.company.trim().slice(0, 2).toUpperCase() || '—'}</div>
        <div className="job-search-role">
          <p className="job-search-company">{job.company || t('company_unknown')}</p>
          <h3>{job.title}</h3>
        </div>
        <span className="job-search-source-tag">{providerName(job.provider)}</span>
      </div>
      <ul className="job-search-facts">
        <li>{job.location || t('location_unknown')}</li>
        {job.remote === true ? <li>{t('remote')}</li> : null}
        {job.employmentType ? <li>{t(EMPLOYMENT[job.employmentType])}</li> : null}
      </ul>
      <p className="job-search-pay">{salary ?? t('salary_unknown')}{salary && periodKey ? <span> / {t(periodKey)}</span> : null}</p>
      <div className="job-search-card-bottom">
        <p className="job-search-posted">{posted ? t('posted', { date: posted }) : t('posted_unknown')}</p>
        {applyUrl ? <Btn as="a" href={applyUrl} target="_blank" rel="noopener noreferrer" variant="violet">{t('apply')}<span aria-hidden="true">↗</span></Btn> : <span className="job-search-posted">{t('apply_missing')}</span>}
      </div>
      <details className="job-search-details">
        <summary>{t('details')}</summary>
        <div className="job-search-details-body">
          <h4>{t('description')}</h4>
          <p className="job-search-description">{job.description || t('description_missing')}</p>
          {job.sources.length > 1 ? <div><h4>{t('provenance')}</h4><ul className="job-search-provenance">{job.sources.map((source, index) => {
            const url = safeJobUrl(source.applyUrl);
            const label = [providerName(source.provider), source.publisher].filter(Boolean).join(' · ');
            return <li key={`${source.provider}-${source.id}-${index}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{label} ↗</a> : label}</li>;
          })}</ul></div> : null}
          <div className="job-search-detail-meta">
            {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{t('original')} ↗</a> : null}
            {fetched ? <span>{t('retrieved', { date: fetched })}</span> : null}
          </div>
          <p className="job-search-freshness">{t('freshness_note')}</p>
        </div>
      </details>
    </article>
  );
}
