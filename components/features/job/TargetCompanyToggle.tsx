'use client';

// TargetCompanyToggle — "Companies you want to work at" on the job page
// (docs/agent-driven/REDESIGN.md §8 scenario 4). One line under the company
// and the title:
//   not on the list   "Add {company} to companies you want to work at"
//   on the list       "On your list of companies" · Remove
//
// The list is the active saved search's (the one Jobs and the Dashboard's goal
// line use; the filters drawer edits the same list). The server says whether
// the company is on it (`JobDetailResponse.atTargetCompany`, compared as the
// Jobs card compares it) and makes the change (POST
// /search-profiles/target-companies): one company on or off, every spelling of
// it. Nothing is shown when the server said nothing (D3). A preference, never
// a filter: jobs at other companies still show; this one ranks ahead of an
// otherwise equal job.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { toast } from '../../v3/primitives';
import { jobKeys } from '../../../hooks/job';
import { searchErrorReason, useSetTargetCompany } from '../../../hooks/search/useSearchProfiles';
import type { JobDetailResponse } from '../../../lib/api/contracts/jobs/detail';
import styles from './job.module.css';

export interface TargetCompanyToggleProps {
  jobId: string;
  /** The company as the page names it. */
  company: string;
  /** The server's answer; undefined when it gave none (the control is then left out). */
  on: boolean | undefined;
}

export function TargetCompanyToggle({ jobId, company, on }: TargetCompanyToggleProps) {
  const t = useTranslations('jobDetail.targets');
  const qc = useQueryClient();
  const change = useSetTargetCompany();
  const [error, setError] = useState<'failed' | 'full' | null>(null);
  const name = company.trim();
  if (on === undefined || !name) return null;

  const toggle = () => {
    setError(null);
    change.mutate(
      { company: name, on: !on },
      {
        onSuccess: (res) => {
          // At once on this page; then the page is read again, so a read of it still on its way (the page's own
          // fit sync) cannot put the old answer back. Other cached job pages are read again when next opened.
          qc.setQueriesData<JobDetailResponse>({ queryKey: jobKeys.detail(jobId) }, (prev) => (prev ? { ...prev, atTargetCompany: res.on } : prev));
          void qc.invalidateQueries({ queryKey: jobKeys.detail(jobId) });
          void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'job' && q.queryKey[1] === 'detail' && q.queryKey[2] !== jobId, refetchType: 'none' });
          toast({ message: res.on ? t('added', { company: name }) : t('removed', { company: name }), tone: 'ok' });
        },
        // The only refusal of a valid change is a full list (the drawer's own limit).
        onError: (err) => setError(searchErrorReason(err) === 'invalid_filters' ? 'full' : 'failed'),
      },
    );
  };

  return (
    <div className={styles.target} data-testid="job-target-company" data-on={on ? 'true' : 'false'}>
      {on ? (
        <>
          <span className={styles.targetOn}>{t('on')}</span>
          <button type="button" className={styles.targetBtn} onClick={toggle} disabled={change.isPending} aria-label={t('removeLabel', { company: name })}>
            {t('remove')}
          </button>
        </>
      ) : (
        <button type="button" className={styles.targetBtn} onClick={toggle} disabled={change.isPending}>
          {t('add', { company: name })}
        </button>
      )}
      {error ? (
        <p className={styles.alert} role="alert">
          {t(error)}
        </p>
      ) : null}
    </div>
  );
}
