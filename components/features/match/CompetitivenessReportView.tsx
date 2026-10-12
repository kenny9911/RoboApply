'use client';

// CompetitivenessReportView — "You and what employers ask" (PRODUCT
// F-MATCH-04; WP-77). Props-driven: the report the server counted from our
// job index for one saved search.
//
//   Requirements you meet   share of the posts that state a degree / years /
//                           required skills where you meet everything stated,
//                           then each requirement on its own
//   Most requested skills   "Asked for in X of Y posts", with whether your
//                           profile or resume shows it
//   Broaden your search     filters you could remove, with the real extra-job
//                           count, one tap each (one PATCH of the search)
//
// D3: every comparative number renders through its source (SourceNote with
// N); an aggregate the server suppressed (n < 20) renders "Not enough…",
// never 0. Nothing here compares the user with other applicants.

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, SourceNote } from '../../v3/primitives';
import { useFilterLabels } from '../filters';
import type { FilterField, FilterSet } from '../../../lib/api/contracts/search';
import type { BroadenOption, CompetitivenessReport, CompetitivenessRequirement } from '../../../lib/api/contracts/match';
import { useDegreeLabel } from './labels';
import styles from './competitiveness.module.css';

/** The sample rule (twin of the server's MIN_SAMPLE; SourceNote's constant). */
const MIN_POSTS = 20;

export type BroadenState = 'idle' | 'applying' | 'applied' | 'error' | 'conflict';

export interface CompetitivenessReportViewProps {
  report: CompetitivenessReport;
  /** The saved search's current filters (for value labels); falls back to raw values. */
  filters?: FilterSet | null;
  /** Remove one filter from the saved search; absent hides the buttons. */
  onBroaden?: (option: BroadenOption) => void;
  broadenState?: Record<string, BroadenState>;
}

function pct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function RequirementRow({ row }: { row: CompetitivenessRequirement }) {
  const t = useTranslations('competitiveness.req');
  const degree = useDegreeLabel();
  const yours =
    !row.youKnown || row.yours === null
      ? t('yoursUnknown')
      : row.key === 'degree'
        ? t('yoursDegree', { degree: degree(row.yours) ?? String(row.yours) })
        : row.key === 'years'
          ? t('yoursYears', { years: Number(row.yours) })
          : t('yoursSkills', { count: Number(row.yours) });
  const typical = row.typical
    ? row.key === 'degree'
      ? t('typicalDegree', { degree: degree(row.typical.value) ?? String(row.typical.value), count: row.typical.count ?? 0 })
      : t('typicalYears', { years: Number(row.typical.value) })
    : null;
  return (
    <li className={styles.row} data-testid={`requirement-${row.key}`}>
      <div className={styles.rowHead}>
        <span className={styles.rowLabel}>{t(row.key)}</span>
        <span className={styles.rowMeta}>{t('stated', { count: row.stated })}</span>
      </div>
      <p className={styles.muted}>{yours}</p>
      {row.share ? (
        <>
          <div className={styles.track} aria-hidden="true">
            <div className={`${styles.fill} ${styles.fillOk}`} style={{ width: `${pct(row.share.value)}%` }} />
          </div>
          <p className={styles.text}>{t('share', { met: row.share.met, total: row.share.sampleSize })}</p>
        </>
      ) : row.youKnown && row.stated > 0 ? (
        <p className={styles.muted}>{t('notEnough')}</p>
      ) : null}
      {typical ? <p className={styles.muted}>{typical}</p> : null}
    </li>
  );
}

export function CompetitivenessReportView({ report, filters, onBroaden, broadenState = {} }: CompetitivenessReportViewProps) {
  const t = useTranslations('competitiveness');
  const format = useFormatter();
  const labels = useFilterLabels();

  const total = report.total?.value ?? null;
  const sampleLine =
    total === null
      ? t('sample.line', { size: report.sample.size })
      : t(report.totalCapped ? 'sample.lineWithTotalCapped' : 'sample.lineWithTotal', { size: report.sample.size, total: format.number(total) });

  const describe = (o: BroadenOption): string => {
    const f = o.field as FilterField;
    const name = labels.field(f);
    const v = o.value;
    if (v === undefined || v === null || typeof v === 'boolean') return typeof v === 'boolean' ? labels.value(f, v, filters ?? undefined) : name;
    const values = Array.isArray(v) ? v : [v];
    const shown = values.slice(0, 3).map((x) => labels.value(f, x, filters ?? undefined));
    return `${name}: ${shown.join(', ')}${values.length > 3 ? '…' : ''}`;
  };

  const meets = report.meetsRequirements;
  const missingSkills = report.topSkills.some((s) => !s.youHave);

  return (
    <div className={styles.page} data-testid="competitiveness-report">
      <p className={styles.muted}>{sampleLine}</p>
      {report.total ? <SourceNote sourced={report.total} className={styles.muted} /> : null}
      {report.stale ? (
        <p className={styles.note} role="status">
          {t('stale')}
        </p>
      ) : null}

      {report.suppressed ? (
        <section className={styles.section} aria-labelledby="cmp-suppressed">
          <h2 id="cmp-suppressed" className={styles.heading}>
            {t('suppressed.title')}
          </h2>
          <p className={styles.text}>{t('suppressed.body', { size: report.sample.size, min: MIN_POSTS })}</p>
        </section>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="cmp-meets">
            <h2 id="cmp-meets" className={styles.heading}>
              {t('meets.title')}
            </h2>
            {meets ? (
              <>
                <div className={styles.headline} data-testid="meets-headline">
                  <span className={styles.big}>{t('meets.headline', { met: meets.met, total: meets.sampleSize })}</span>
                  <span className={styles.percent}>{t('meets.share', { percent: format.number(meets.value, { style: 'percent', maximumFractionDigits: 0 }) })}</span>
                </div>
                <SourceNote sourced={meets} className={styles.muted} />
              </>
            ) : (
              <p className={styles.text} data-testid="meets-not-enough">
                —
                <span className={styles.muted}> {t('meets.notEnough')}</span>
              </p>
            )}
            <p className={styles.text}>{t('meets.explain')}</p>
            {report.overall.notStated > 0 ? <p className={styles.muted}>{t('meets.notStated', { count: report.overall.notStated })}</p> : null}
            {report.overall.unknown > 0 ? (
              <p className={styles.muted}>
                {t('meets.unknown', { count: report.overall.unknown })}{' '}
                <Link href="/profile" className={styles.link}>
                  {t('meets.fillProfile')}
                </Link>
              </p>
            ) : null}
            <ul className={styles.rows}>
              {report.requirements.map((r) => (
                <RequirementRow key={r.key} row={r} />
              ))}
            </ul>
          </section>

          <section className={styles.section} aria-labelledby="cmp-skills">
            <h2 id="cmp-skills" className={styles.heading}>
              {t('skills.title')}
            </h2>
            <p className={styles.text}>{t('skills.intro')}</p>
            {report.topSkills.length ? (
              <>
                <ul className={styles.rows}>
                  {report.topSkills.map((s) => (
                    <li key={s.skill} className={styles.row} data-testid="top-skill">
                      <div className={styles.rowHead}>
                        <span className={styles.rowLabel}>{s.skill}</span>
                        <span className={`${styles.status} ${s.youHave ? styles.statusHave : styles.statusMissing}`}>
                          {s.youHave ? t('skills.have') : t('skills.missing')}
                        </span>
                      </div>
                      <div className={styles.track} aria-hidden="true">
                        <div className={styles.fill} style={{ width: `${pct(s.askedIn.value / Math.max(1, s.askedIn.sampleSize))}%` }} />
                      </div>
                      <p className={styles.muted}>{t('skills.askedIn', { count: s.askedIn.value, total: s.askedIn.sampleSize })}</p>
                    </li>
                  ))}
                </ul>
                <SourceNote sourced={report.topSkills[0]!.askedIn} className={styles.muted} />
              </>
            ) : (
              <p className={styles.muted}>{t('skills.none')}</p>
            )}
            {report.hiddenSkills > 0 ? (
              <p className={styles.muted}>{t(report.upgradable ? 'skills.hidden' : 'skills.hiddenPlan', { count: report.hiddenSkills })}</p>
            ) : null}
            {missingSkills ? (
              <p className={styles.muted}>
                {t('skills.addHint')}{' '}
                <Link href="/resume" className={styles.link}>
                  {t('skills.editResume')}
                </Link>
              </p>
            ) : null}
          </section>
        </>
      )}

      <section className={styles.section} aria-labelledby="cmp-broaden">
        <h2 id="cmp-broaden" className={styles.heading}>
          {t('broaden.title')}
        </h2>
        {report.broaden.length ? (
          <>
            <p className={styles.text}>{t('broaden.intro')}</p>
            {report.stale && onBroaden ? <p className={styles.muted}>{t('broaden.staleNote')}</p> : null}
            <ul className={styles.rows}>
              {report.broaden.map((o) => {
                const state = broadenState[o.field] ?? 'idle';
                return (
                  <li key={o.field} className={styles.broadenRow} data-testid="broaden-option">
                    <div className={styles.broadenText}>
                      <span className={styles.rowLabel}>{t('broaden.remove', { filter: describe(o) })}</span>
                      <span className={styles.gain}>
                        {t(o.capped ? 'broaden.extraCapped' : 'broaden.extra', { count: format.number(o.extraJobs.value) })}
                      </span>
                      {state === 'applied' ? (
                        <span className={styles.muted} role="status">
                          {t('broaden.applied')}
                        </span>
                      ) : null}
                      {state === 'error' || state === 'conflict' ? (
                        <span className={styles.alert} role="alert">
                          {t(state === 'conflict' ? 'broaden.conflict' : 'broaden.error')}
                        </span>
                      ) : null}
                    </div>
                    {onBroaden && state !== 'applied' ? (
                      <Btn
                        className={styles.action}
                        onClick={() => onBroaden(o)}
                        disabled={report.stale || state === 'applying'}
                        aria-busy={state === 'applying'}
                      >
                        {state === 'applying' ? t('broaden.applying') : t('broaden.apply')}
                      </Btn>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <SourceNote sourced={report.broaden[0]!.extraJobs} className={styles.muted} />
          </>
        ) : report.totalCapped && report.total ? (
          <p className={styles.muted} data-testid="broaden-many">
            {t('broaden.manyAlready', { total: format.number(report.total.value) })}
          </p>
        ) : (
          <p className={styles.muted}>{t('broaden.none')}</p>
        )}
        {report.hiddenBroaden > 0 ? (
          <p className={styles.muted}>{t(report.upgradable ? 'broaden.hidden' : 'broaden.hiddenPlan', { count: report.hiddenBroaden })}</p>
        ) : null}
      </section>
    </div>
  );
}
