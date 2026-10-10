'use client';

// JobOverview — the Overview tab (PRODUCT F-JOB-02, F-MATCH-02/03, F-RES-08):
// the AI summary (labelled as AI), work-authorization lines quoted from the
// post, the posting's own sections verbatim, the skills it lists, then how
// the user's resume compares (fit with its honesty line, "Why this job",
// keyword check). GoApply campus jobs show the employer's verified 网申
// window and 届别 first.
//
// The market block (MarketJobMeta) sits here unless the panel already shows it
// above the tabs (`marketMeta={false}`): on GoApply it carries the job's pay,
// dates and source, which must stay on screen on every tab.

import { useFormatter, useTranslations } from 'next-intl';

import { Markdown } from '../../v3/primitives';
import { JobFit, JobKeywordCheck } from '../match';
import { WhyThisJob } from '../compliance';
import { AiGeneratedBadge, MarketJobMeta, withOwnImport } from '../market';
import { useBrand } from '../../../lib/brand';
import type { JobDetailResponse, JobCampusInfo } from '../../../lib/api/contracts/jobs/detail';
import { validDate } from './format';
import styles from './job.module.css';

export interface JobOverviewProps {
  detail: JobDetailResponse;
  /** False when the caller renders the market block itself (default true). */
  marketMeta?: boolean;
}

export function CampusWindow({ campus, company }: { campus: JobCampusInfo; company: string }) {
  const t = useTranslations('jobDetail.campus');
  const format = useFormatter();
  const fmt = (d: Date) => format.dateTime(d, { dateStyle: 'medium' });
  const opens = validDate(campus.applyOpensAt);
  const closes = validDate(campus.applyClosesAt);
  const window =
    opens && closes
      ? t('window', { opens: fmt(opens), closes: fmt(closes) })
      : opens
        ? t('opensOnly', { opens: fmt(opens) })
        : closes
          ? t('closesOnly', { closes: fmt(closes) })
          : t('windowUnknown');
  return (
    <section className={styles.campus} data-testid="campus-window" aria-label={t('title', { graduationClass: campus.graduationClass, company })}>
      <h3 className={styles.subTitle}>{t('title', { graduationClass: campus.graduationClass, company })}</h3>
      <p className={styles.body}>{window}</p>
      {campus.classYears.length ? <p className={styles.muted}>{t('classYears', { years: campus.classYears.join(', ') })}</p> : null}
      {campus.needsCheck ? (
        <p className={styles.muted} role="note">
          {t('needsCheck')}
        </p>
      ) : null}
      <p className={styles.muted}>{t('note')}</p>
      <a className={styles.linkBtn} href={campus.officialUrl} target="_blank" rel="noopener noreferrer">
        {t('official')}
      </a>
    </section>
  );
}

export function JobOverview({ detail, marketMeta = true }: JobOverviewProps) {
  const t = useTranslations('jobDetail.overview');
  const tq = useTranslations('jobDetail.header');
  const { job } = detail;
  // Visa sponsorship is a RoboApply question; GoApply (mainland) shows no visa or work-permit wording.
  const intl = useBrand().market !== 'cn';
  const workAuth = [
    ...(intl && job.sponsorship.status !== 'not_stated' && job.sponsorship.quote
      ? [{ key: 'sponsorship', label: t(`sponsorship.${job.sponsorship.status}`), quote: job.sponsorship.quote }]
      : []),
    ...job.requirements.map((r) => ({ key: r.tag, label: t(`requirement.${r.tag}`), quote: r.quote })),
  ];

  return (
    <div className={styles.main} data-testid="job-overview">
      {job.campus ? <CampusWindow campus={job.campus} company={job.companyName} /> : null}
      {marketMeta ? <MarketJobMeta jobId={job.id} meta={withOwnImport(detail.marketMeta, job.source.kind === 'user_import')} variant="detail" /> : null}

      {job.summary ? (
        <section className={styles.summary} data-testid="job-summary">
          <div className={styles.summaryHead}>
            <p className={styles.label}>{t('summaryLabel')}</p>
            <AiGeneratedBadge kind="text" />
          </div>
          <p className={styles.body}>{job.summary.text}</p>
        </section>
      ) : null}

      {workAuth.length ? (
        <section className={styles.section} data-testid="job-work-auth">
          <h3 className={styles.subTitle}>{t('workAuthTitle')}</h3>
          <ul className={styles.list}>
            {workAuth.map((w) => (
              <li key={w.key}>
                <p className={styles.body}>{w.label}</p>
                <p className={styles.quote}>{tq('quote', { quote: w.quote })}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.section} data-testid="job-sections">
        <p className={styles.label}>{t('fromPost')}</p>
        {job.sections.length ? (
          job.sections.map((s) => (
            <div key={s.kind} className={styles.main}>
              <h3 className={styles.subTitle}>{t(`section.${s.kind}`)}</h3>
              <div className={styles.body}>
                <Markdown block>{s.body}</Markdown>
              </div>
            </div>
          ))
        ) : (
          <p className={styles.muted}>{t('noDescription')}</p>
        )}
        {job.skills.length ? (
          <>
            <h3 className={styles.subTitle}>{t('skillsTitle')}</h3>
            <ul className={styles.skillList}>
              {job.skills.map((s) => (
                <li key={s.skill} className={styles.skill}>
                  {s.skill}
                  <span className={styles.skillKind}>· {s.required ? t('skillRequired') : t('skillPreferred')}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className={styles.section} aria-label={t('fitTitle')}>
        <h3 className={styles.sectionTitle}>{t('fitTitle')}</h3>
        <JobFit jobId={job.id} />
        {detail.explanation ? <WhyThisJob explanation={detail.explanation} /> : null}
      </section>

      <section className={styles.section} aria-label={t('keywordTitle')}>
        <h3 className={styles.sectionTitle}>{t('keywordTitle')}</h3>
        {/* This section already carries the title: the check does not print "Keyword check" a second time. */}
        <JobKeywordCheck jobId={job.id} withHeading={false} />
      </section>
    </div>
  );
}
