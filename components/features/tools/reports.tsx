'use client';

// The two free-tool reports (WP-57). Both are labelled as automated
// checklists; neither shows a number on a scale ("no ATS score"): the resume
// check shows a word label and counts of issues, the resume–job check shows
// requirement rows and word lists. Issue titles/why/how come from WP-22's
// `resumeCheck.issue.<type>.*` strings through `issueText`.

import { useFormatter, useTranslations } from 'next-intl';

import { issueText } from '../resume';
import type { KeywordReportRow } from '../../../lib/api/contracts/resume';
import type { ResumeCheckReport, ResumeJobMatchReport, ToolIssue, ToolReport } from '../../../lib/api/contracts/tools';
import styles from './tools.module.css';

const SEVERITIES = ['urgent', 'critical', 'optional'] as const;

function ReportFooter({ report }: { report: ToolReport }) {
  const t = useTranslations('tools');
  const format = useFormatter();
  const when = format.dateTime(new Date(report.expiresAt), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className={styles.field}>
      {report.cached ? <p className={styles.muted}>{t('report.cached')}</p> : null}
      {!report.full ? <p className={styles.muted}>{t('report.deletes', { when })}</p> : null}
    </div>
  );
}

function IssueItem({ issue }: { issue: ToolIssue }) {
  const t = useTranslations('tools');
  const rc = useTranslations('resumeCheck');
  const text = issueText(rc, { ...issue });
  return (
    <li className={styles.issue} data-issue={issue.type} data-severity={issue.severity}>
      <div className={styles.issueHead}>
        <span className={styles.issueSev}>
          <span className={`${styles.dot} ${styles[`sev-${issue.severity}`]}`} aria-hidden="true" />
          {t(`report.severity.${issue.severity}`)}
        </span>
      </div>
      <h4 className={styles.issueTitle}>{text.title}</h4>
      {issue.evidence ? (
        <blockquote className={styles.quote} aria-label={t('report.quote')}>
          {issue.evidence}
        </blockquote>
      ) : null}
      <p className={styles.detailLabel}>{t('report.why')}</p>
      <p className={styles.body}>{text.why}</p>
      <p className={styles.detailLabel}>{t('report.how')}</p>
      <p className={styles.body}>{text.how}</p>
    </li>
  );
}

export function CheckReportView({ report }: { report: ResumeCheckReport }) {
  const t = useTranslations('tools');
  return (
    <section className={styles.card} aria-labelledby="tool-check-result" data-report="resume_check" data-full={report.full ? 'yes' : 'no'}>
      <div className={styles.reportHead}>
        <div>
          <p className={styles.muted}>{t('report.resultLabel')}</p>
          <h2 id="tool-check-result" className={styles.resultLabel}>
            {t(`report.label.${report.label}`)}
          </h2>
        </div>
        <span className={styles.badge} data-honesty="automated">
          {t('report.automated')}
        </span>
      </div>
      <p className={styles.muted}>
        {report.rulesChecked ? t('report.automatedNote', { rules: report.rulesChecked }) : t('report.automatedNoteNoCount')}
      </p>

      <div className={styles.field}>
        <p className={styles.detailLabel}>{t('report.countsLabel')}</p>
        <ul className={styles.counts}>
          {SEVERITIES.map((s) => (
            <li key={s} className={styles.count} data-count={s}>
              <span className={`${styles.dot} ${styles[`sev-${s}`]}`} aria-hidden="true" />
              {t(`report.severity.${s}`)}: {report.counts[s]}
            </li>
          ))}
        </ul>
      </div>

      <h3 className={styles.sectionTitle}>{report.full ? t('report.allIssues') : t('report.topIssues')}</h3>
      {report.issues.length === 0 ? (
        <p className={styles.body}>{t('report.noIssues')}</p>
      ) : (
        <ol className={styles.issues}>
          {report.issues.map((issue) => (
            <IssueItem key={issue.id} issue={issue} />
          ))}
        </ol>
      )}
      {report.hiddenIssueCount > 0 ? (
        <p className={styles.body} data-hidden-count={report.hiddenIssueCount}>
          {t('report.more', { count: report.hiddenIssueCount })}
        </p>
      ) : null}
      <ReportFooter report={report} />
    </section>
  );
}

type T = ReturnType<typeof useTranslations>;

function rowDetail(t: T, row: KeywordReportRow): string {
  const p = row.params;
  switch (row.key) {
    case 'title':
      if (row.status === 'pass') return t('matchReport.titlePass');
      if (row.status === 'warn') return t('matchReport.titleWarn');
      if (row.status === 'fail') return t('matchReport.titleFail');
      return t('matchReport.status.unknown');
    case 'years':
      if (p.required === undefined) return t('matchReport.yearsNotListed');
      if (p.found === undefined) return t('matchReport.yearsNoDates');
      return t('matchReport.yearsDetail', { required: p.required, found: p.found });
    case 'education':
      if (p.required === undefined) return t('matchReport.eduNotListed');
      if (p.found === undefined) return t('matchReport.eduNotFound');
      return row.status === 'pass' ? t('matchReport.eduMet') : t('matchReport.eduBelow');
    default:
      return typeof p.total === 'number' && p.total > 0 ? t('matchReport.count', { met: p.met ?? 0, total: p.total }) : t('matchReport.status.unknown');
  }
}

function TermList({ title, terms, ok }: { title: string; terms: string[]; ok?: boolean }) {
  const t = useTranslations('tools');
  const unique = [...new Map(terms.map((x) => [x.toLowerCase(), x])).values()];
  return (
    <div>
      <p className={styles.detailLabel}>{title}</p>
      {unique.length === 0 ? (
        <p className={styles.muted}>{t('matchReport.none')}</p>
      ) : (
        <ul className={styles.chips}>
          {unique.map((term) => (
            <li key={term} className={`${styles.chip} ${ok ? styles.chipOk : ''}`}>
              {term}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ROW_KEYS = new Set(['title', 'years', 'education', 'skills', 'keywords']);
const STATUS_KEYS = new Set(['pass', 'warn', 'fail', 'unknown']);

export function MatchReportView({ report }: { report: ResumeJobMatchReport }) {
  const t = useTranslations('tools');
  return (
    <section className={styles.card} aria-labelledby="tool-match-result" data-report="resume_job_match">
      <div className={styles.reportHead}>
        <h2 id="tool-match-result" className={styles.sectionTitle}>
          {t('matchReport.title', { title: report.postingTitle })}
        </h2>
        <span className={styles.badge} data-honesty="automated">
          {t('report.automated')}
        </span>
      </div>
      <p className={styles.muted} data-honesty="no-score">
        {t('matchReport.noScore')}
      </p>
      <ul className={styles.rows}>
        {report.rows
          .filter((row) => ROW_KEYS.has(row.key))
          .map((row) => {
            const status = STATUS_KEYS.has(row.status) ? row.status : 'unknown';
            return (
              <li key={row.key} className={styles.row} data-row={row.key} data-status={status}>
                <span className={styles.rowLabel}>{t(`matchReport.row.${row.key}`)}</span>
                <span className={`${styles.status} ${styles[`status-${status}`] ?? ''}`}>{t(`matchReport.status.${status}`)}</span>
                <span className={styles.rowDetail}>{rowDetail(t, row)}</span>
              </li>
            );
          })}
      </ul>
      <div className={styles.terms}>
        <TermList title={t('matchReport.matched')} terms={[...report.hardSkills.matched, ...report.keywords.matched]} ok />
        <TermList title={t('matchReport.missing')} terms={[...report.hardSkills.missing, ...report.keywords.missing]} />
      </div>
      <p className={styles.muted}>{t('matchReport.honest')}</p>
      <ReportFooter report={report} />
    </section>
  );
}

export function ToolReportView({ report }: { report: ToolReport }) {
  return report.kind === 'resume_check' ? <CheckReportView report={report} /> : <MatchReportView report={report} />;
}
