'use client';

// KeywordReport — the keyword check for one resume and one job (WP-22;
// PRODUCT_PLAN.md F-RES-08). Job detail (WP-34) and tailoring (WP-36a)
// render it. Requirement rows (title, years, education, hard skills n/m,
// keywords n/m) with Met · Partly met · Not met · Not listed, the matched and
// missing terms, and — only when the server has one for this resume version —
// the 0–100 fit score through FitMeter (no second scale, D3 source line).

import { useTranslations } from 'next-intl';

import { FitMeter } from '../../v3/primitives';
import { SourceNote } from '../common';
import { useKeywordReport } from '../../../hooks/resume/useKeywordReport';
import type { KeywordReportResponse, KeywordReportRow } from '../../../lib/api/contracts/resume';
import type { FitTierKey } from '../common';
import styles from './ResumeCheck.module.css';

export interface KeywordReportProps {
  resumeId: string;
  /** The job to check against… */
  jobId?: string | null;
  /** …or a tailor session (its own job, or the posting pasted for it). */
  tailorSession?: { id: string; version?: string } | null;
  /** Leave the fit score out (the tailored result shows its own before / after scores). */
  hideFit?: boolean;
}

export function KeywordReport({ resumeId, jobId = null, tailorSession = null, hideFit = false }: KeywordReportProps) {
  const t = useTranslations('resumeCheck');
  const q = useKeywordReport(resumeId, tailorSession ? { tailorSessionId: tailorSession.id, version: tailorSession.version } : jobId);
  if (q.isLoading) {
    return (
      <p className={styles.muted} role="status">
        {t('keywords.loading')}
      </p>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p className={styles.error} role="alert">
        {t('keywords.error')}
      </p>
    );
  }
  return <KeywordReportView report={q.data} hideFit={hideFit} />;
}

export function KeywordReportView({ report, hideFit = false }: { report: KeywordReportResponse; hideFit?: boolean }) {
  const t = useTranslations('resumeCheck');
  return (
    <section className={styles.card} aria-labelledby="rc-keywords">
      <h3 id="rc-keywords" className={styles.cardTitle}>
        {t('keywords.title')}
      </h3>
      <p className={styles.muted}>{t('keywords.sub')}</p>

      {hideFit ? null : (
        <div className={styles.mt4}>
          <p className={styles.detailLabel}>{t('keywords.fit')}</p>
          {report.fit ? (
            <>
              <FitMeter score={report.fit.value} tier={(report.fitTier as FitTierKey | null) ?? null} compact />
              <SourceNote sourced={report.fit} />
            </>
          ) : (
            <p className={styles.muted}>{t('keywords.fitNone')}</p>
          )}
        </div>
      )}

      <ul className={styles.rows}>
        {report.rows.map((row) => (
          <li key={row.key} className={styles.row} data-row={row.key} data-status={row.status}>
            <span className={styles.rowLabel}>
              {t(`keywords.row.${row.key}`)}
              {row.key === 'skills' || row.key === 'keywords'
                ? typeof row.params.total === 'number' && row.params.total > 0
                  ? ` · ${t('keywords.count', { met: row.params.met ?? 0, total: row.params.total })}`
                  : ''
                : ''}
            </span>
            <span className={`${styles.status} ${styles[`status-${row.status}`]}`}>{t(`keywords.status.${row.status}`)}</span>
            <span className={styles.rowDetail}>{rowDetail(t, row)}</span>
          </li>
        ))}
      </ul>

      <div className={styles.termGroups}>
        <TermList title={t('keywords.matched')} terms={[...report.hardSkills.matched, ...report.keywords.matched]} ok />
        <TermList title={t('keywords.missing')} terms={[...report.hardSkills.missing, ...report.keywords.missing]} />
      </div>
      <p className={`${styles.muted} ${styles.mt3}`}>
        {t('keywords.honest')}
        {report.keywordSource === 'posting' ? ` ${t('keywords.fromPosting')}` : ''}
      </p>
    </section>
  );
}

function TermList({ title, terms, ok = false }: { title: string; terms: string[]; ok?: boolean }) {
  const t = useTranslations('resumeCheck');
  const unique = [...new Map(terms.map((x) => [x.toLowerCase(), x])).values()];
  return (
    <div>
      <p className={styles.detailLabel}>{title}</p>
      {unique.length === 0 ? (
        <p className={styles.muted}>{t('keywords.none')}</p>
      ) : (
        <ul className={`${styles.fixedList} ${styles.mt0}`}>
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

type T = ReturnType<typeof useTranslations>;

function rowDetail(t: T, row: KeywordReportRow): string {
  const p = row.params;
  switch (row.key) {
    case 'title':
      return row.status === 'pass' ? t('keywords.titlePass') : row.status === 'warn' ? t('keywords.titleWarn') : row.status === 'fail' ? t('keywords.titleFail') : t('keywords.status.unknown');
    case 'years':
      if (p.required === undefined) return t('keywords.yearsNotListed');
      if (p.found === undefined) return t('keywords.yearsNoDates');
      return t('keywords.yearsDetail', { required: p.required, found: p.found });
    case 'education':
      if (p.required === undefined) return t('keywords.eduNotListed');
      if (p.found === undefined) return t('keywords.eduNotFound');
      return row.status === 'pass' ? t('keywords.eduMet') : t('keywords.eduBelow');
    default:
      return typeof p.total === 'number' && p.total > 0 ? t('keywords.count', { met: p.met ?? 0, total: p.total }) : t('keywords.status.unknown');
  }
}
