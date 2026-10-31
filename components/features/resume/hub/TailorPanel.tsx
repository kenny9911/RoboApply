'use client';

// TailorPanel — AI tailoring at the top of the /resume hub (WP-36a flow): pick
// the base resume, then a saved job that has no tailored version yet, or open
// the flow to pick another saved job or paste a posting. The flow itself is
// the TailorSheet; this panel only starts it. Rendered only when AI tailoring
// may run for this user (R-04). Its last line is the promise that makes it
// safe to use: every new keyword, number or claim waits for the user's OK.

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import type { ResumeSummary } from '../../../../lib/api/resumes';
import type { TailorTargetJob } from '../../../../hooks/tailor';
import { Btn, IconArrow, IconCheck, IconSparkle } from '../../../v3/primitives';
import styles from './Hub.module.css';

/** Saved jobs shown as one-tap starts; the rest are one step away in the flow. */
export const TAILOR_CHIP_LIMIT = 4;

export interface TailorPanelProps {
  /** Base resumes, the main one first. */
  bases: readonly ResumeSummary[];
  baseId: string;
  onBaseChange: (id: string) => void;
  /** Saved jobs without a tailored version. */
  jobs: readonly TailorTargetJob[];
  /** Start tailoring `baseId`: for `jobId`, or (null) let the user pick or paste. */
  onTailor: (jobId: string | null) => void;
}

export function TailorPanel({ bases, baseId, onBaseChange, jobs, onTailor }: TailorPanelProps) {
  const t = useTranslations('resume.hub.studio');
  const tr = useTranslations('resume');
  const titleId = useId();
  const baseSelectId = useId();
  const jobsLabelId = useId();
  const base = bases.find((b) => b.id === baseId) ?? bases[0];
  const shown = jobs.slice(0, TAILOR_CHIP_LIMIT);
  const more = jobs.length - shown.length;

  return (
    <section className={styles.tailor} aria-labelledby={titleId}>
      <p className={styles.aiEyebrow}>
        <IconSparkle size={14} aria-hidden="true" />
        {t('eyebrow')}
      </p>
      <h2 className={styles.tailorTitle} id={titleId}>
        {t('title')}
      </h2>
      <p className={styles.tailorBody}>{t('body')}</p>

      {bases.length > 1 ? (
        <div className={styles.baseRow}>
          <label htmlFor={baseSelectId}>{t('base')}</label>
          <select id={baseSelectId} className={styles.select} value={base?.id} onChange={(e) => onBaseChange(e.target.value)}>
            {bases.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : base ? (
        <p className={styles.baseRow}>{t.rich('base_one', { name: base.name, b: (chunks) => <strong>{chunks}</strong> })}</p>
      ) : null}

      {shown.length > 0 ? (
        <div role="group" aria-labelledby={jobsLabelId}>
          <p className={styles.jobsLabel} id={jobsLabelId}>
            {t('saved')}
          </p>
          <ul className={styles.jobChips}>
            {shown.map((job) => (
              <li key={job.jobId}>
                <button
                  type="button"
                  className={styles.jobChip}
                  onClick={() => onTailor(job.jobId)}
                  aria-label={job.company ? t('job_aria_company', { title: job.title, company: job.company }) : t('job_aria', { title: job.title })}
                >
                  {job.company ? <strong>{job.company}</strong> : null}
                  <span className={styles.jobChipRole}>{job.title}</span>
                  <IconArrow size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.tailorActions}>
        <Btn variant="primary" className={styles.action} icon={<IconSparkle size={14} aria-hidden="true" />} onClick={() => onTailor(null)}>
          {tr('toolbar.tailor')}
        </Btn>
        {more > 0 ? (
          <Btn variant="ghost" className={styles.action} onClick={() => onTailor(null)}>
            {t('more', { count: more })}
          </Btn>
        ) : null}
      </div>
      <p className={styles.trust}>
        <IconCheck size={14} aria-hidden="true" />
        {t('honesty')}
      </p>
    </section>
  );
}
