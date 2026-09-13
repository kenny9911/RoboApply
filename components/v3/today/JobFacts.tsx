'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RAJob, RAJobListItem } from '../../../lib/api/v2';
import { BuildingOffice2Icon, MapPinIcon, BanknotesIcon } from '@heroicons/react/24/outline';
import { formatSalary, logoColor, logoLetter } from './lib';

type JobFactsData = Pick<RAJobListItem, 'location' | 'workType' | 'salaryMin' | 'salaryMax' | 'salaryCurrency'> & Partial<Pick<RAJob, 'salaryPeriod'>>;

/** The same disclosed facts appear in discovery and the full posting. Missing
 * information stays visible so absence cannot look like a favorable finding. */
export function JobFacts({ job }: { job: JobFactsData }) {
  const t = useTranslations('jobs');
  const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency);
  return (
    <ul className="discovery-facts" aria-label={t('discovery.essentials')}>
      <li className={!salary ? 'undisclosed' : undefined} aria-label={t('facet.salaryFit')}>
        <BanknotesIcon width={16} height={16} aria-hidden="true" />
        <span>{salary ?? t('discovery.salaryUnknown')}{salary && job.salaryPeriod ? ` ${t(`discovery.salaryPeriod.${job.salaryPeriod}`)}` : ''}{salary && !job.salaryCurrency ? ` · ${t('discovery.currencyUnknown')}` : ''}</span>
      </li>
      <li className={!job.location ? 'undisclosed' : undefined}>
        <MapPinIcon width={16} height={16} aria-hidden="true" />
        <span>{job.location || t('discovery.locationUnknown')}</span>
      </li>
      <li>
        <BuildingOffice2Icon width={16} height={16} aria-hidden="true" />
        <span>{t(`work.${job.workType}`)}</span>
      </li>
    </ul>
  );
}

export function CompanyIdentity({ name, logoUrl, index = 0 }: { name: string; logoUrl: string | null; index?: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div className="logo discovery-company-logo" data-color={logoColor(index)} aria-hidden="true">
      {logoUrl && failedUrl !== logoUrl ? (
        // Third-party logos are optional data, not layout dependencies. A
        // failed URL falls back to the company's initial without a request loop.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" width={48} height={48} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(logoUrl)} />
      ) : logoLetter(name)}
    </div>
  );
}
