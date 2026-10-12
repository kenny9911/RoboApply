'use client';

// ResumeCheckReport — /resume/[id]/check (WP-22; PRODUCT_PLAN.md F-RES-03…06).
//
//   header (Resume check · resume name · back to the editor)
//   no check yet → explanation + optional target role + "Run the check" (+ credit line)
//   running      → status + Cancel (the reserved credit goes back)
//   report       → grade (Excellent · Good · Fair · Needs work), checklist score,
//                  method + honesty lines, counts by priority (filters),
//                  "resume changed since" banner, comparison with the previous
//                  check, issues grouped by section with the fix panel.
//
// The grade is a checklist result, never a chance of passing. With AI off
// (GoApply without the AI consent, or no model) the fix panel is hidden and
// the method line says spelling was not checked. With no resume check credit
// left the checklist still runs and the method line says so; what the last AI
// read found is then carried over (marked "not checked again") or listed as
// "not checked this time" — never as fixed.
//
// WP-65: the 4-step tour (ResumeTour, F-RES-07) points at the parts marked
// `data-tour` (grade, filters, issues, recheck).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn, EmptyState, PageHeader } from '../../v3/primitives';
import { useResume } from '../../../hooks/useResumes';
import { useIssueFix, useResumeCheck } from '../../../hooks/resume/useResumeCheck';
import { markResumeCheckOpened } from '../../../lib/api/resumes';
import type { GradeIssue, GradeView, IssueSeverity, LatestGradeResponse } from '../../../lib/api/contracts/resume';
import { IssueCard } from './IssueCard';
import { issueTypeName } from './issueText';
import { ResumeTour } from './ResumeTour';
import styles from './ResumeCheck.module.css';

const SEVERITIES: IssueSeverity[] = ['urgent', 'critical', 'optional'];
const SECTION_ORDER = ['layout', 'contact', 'summary', 'experience', 'projects', 'education', 'skills', 'other'] as const;

export interface ResumeCheckReportProps {
  resumeId: string;
  /**
   * The issue a link pointed at (`/resume/<id>/check?issue=<issueId>`, used by
   * the Assistant's fix cards). The report opens on it.
   */
  focusIssueId?: string | null;
}

export function editorHrefFor(resumeId: string, anchor: string | null | undefined): string {
  const base = `/resume/${encodeURIComponent(resumeId)}`;
  return anchor ? `${base}?focus=${encodeURIComponent(anchor)}` : base;
}

export function ResumeCheckReport({ resumeId, focusIssueId = null }: ResumeCheckReportProps) {
  const t = useTranslations('resumeCheck');
  const resume = useResume(resumeId);
  const check = useResumeCheck(resumeId);
  const fix = useIssueFix(resumeId);
  const data = check.latest.data;
  const grade = data?.grade ?? null;
  const showReport = grade && grade.status === 'done';

  // The finished report is on screen: tell the server once per check, so the
  // "you have not opened your check" reminder is never sent to someone who
  // has. This is its own call because the latest-check query is shared with
  // the editor, tailoring and the onboarding dock, which only read it.
  const shownGradeId = showReport && !check.running ? grade.id : null;
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shownGradeId || openedRef.current === shownGradeId) return;
    openedRef.current = shownGradeId;
    // Best effort: a failed stamp changes nothing on this page.
    void markResumeCheckOpened(resumeId).catch(() => undefined);
  }, [resumeId, shownGradeId]);

  return (
    <div className={styles.page}>
      <PageHeader eyebrow={resume.data?.name ?? undefined} title={t('title')} sub={t('sub')} />
      <div className={styles.topRow}>
        <a className={styles.linkBtn} href={`/resume/${encodeURIComponent(resumeId)}`}>
          ← {t('back')}
        </a>
        {/* WP-65: the 4-step tour (F-RES-07), once the report is on screen. */}
        <ResumeTour enabled={Boolean(showReport) && !check.running} />
      </div>

      {check.latest.isLoading ? (
        <p className={styles.muted} role="status">
          <span className={`${styles.spinner} ${styles.inlineSpinner}`} aria-hidden="true" />
          {t('running.body')}
        </p>
      ) : check.latest.isError ? (
        <EmptyState title={t('errors.failed')} action={<Btn onClick={() => check.latest.refetch()}>{t('failed.retry')}</Btn>} />
      ) : check.running || grade?.status === 'running' ? (
        <RunningCard onCancel={check.cancel} />
      ) : showReport && data ? (
        <Report
          resumeId={resumeId}
          data={data}
          grade={grade}
          fix={data.aiAvailable ? fix : null}
          focusIssueId={focusIssueId}
          onRecheck={() => void check.run(grade.targetTitle ?? undefined)}
          error={check.error}
        />
      ) : (
        <StartCard
          aiAvailable={data?.aiAvailable ?? true}
          creditsLeft={check.creditsLeft}
          failed={grade?.status === 'failed'}
          error={check.error}
          onRun={(title) => void check.run(title)}
        />
      )}
    </div>
  );
}

function RunningCard({ onCancel }: { onCancel: () => Promise<void> }) {
  const t = useTranslations('resumeCheck');
  const [cancelling, setCancelling] = useState(false);
  return (
    <section className={styles.cardSoft} aria-busy="true">
      <h2 className={styles.cardTitle}>
        <span className={`${styles.spinner} ${styles.inlineSpinner}`} aria-hidden="true" />
        {t('running.title')}
      </h2>
      <p className={styles.body} role="status">
        {t('running.body')}
      </p>
      <div className={`${styles.actions} ${styles.mt4}`}>
        <Btn
          variant="ghost"
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            await onCancel();
            setCancelling(false);
          }}
        >
          {t('running.cancel')}
        </Btn>
      </div>
    </section>
  );
}

function StartCard({
  aiAvailable,
  creditsLeft,
  failed,
  error,
  onRun,
}: {
  aiAvailable: boolean;
  creditsLeft: number | null;
  failed: boolean;
  error: string | null;
  onRun: (targetTitle?: string) => void;
}) {
  const t = useTranslations('resumeCheck');
  const [target, setTarget] = useState('');
  return (
    <section className={styles.cardSoft}>
      <h2 className={styles.cardTitle}>{failed ? t('failed.title') : t('empty.title')}</h2>
      <p className={styles.body}>{failed ? t('failed.body') : t('empty.body')}</p>
      <label className={`${styles.field} ${styles.mt4} ${styles.narrow}`}>
        {t('empty.targetLabel')}
        <input className={styles.input} value={target} maxLength={120} placeholder={t('empty.targetPlaceholder')} onChange={(e) => setTarget(e.target.value)} />
      </label>
      {error ? (
        <p className={`${styles.error} ${styles.mt4}`} role="alert">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <div className={`${styles.actions} ${styles.mt4}`}>
        <Btn variant="primary" onClick={() => onRun(target.trim() || undefined)}>
          {failed ? t('failed.retry') : t('empty.cta')}
        </Btn>
        <p className={styles.muted}>
          {!aiAvailable
            ? t('empty.noAi')
            : creditsLeft === null
              ? t('empty.creditAi')
              : creditsLeft === 0
                ? t('empty.creditNone')
                : t('empty.creditLeft', { left: creditsLeft })}
        </p>
      </div>
    </section>
  );
}

function Report({
  resumeId,
  data,
  grade,
  fix,
  focusIssueId,
  onRecheck,
  error,
}: {
  resumeId: string;
  data: LatestGradeResponse;
  grade: GradeView;
  fix: ReturnType<typeof useIssueFix> | null;
  focusIssueId: string | null;
  onRecheck: () => void;
  error: string | null;
}) {
  const t = useTranslations('resumeCheck');
  const format = useFormatter();
  const [filter, setFilter] = useState<IssueSeverity | null>(null);
  const counts = grade.counts ?? { urgent: 0, critical: 0, optional: 0 };
  const total = counts.urgent + counts.critical + counts.optional;
  const skippedNote = aiSkippedNote(grade, data.aiAvailable);
  // A linked issue that this check no longer lists (fixed, or the resume was checked again).
  const focusMissing = Boolean(focusIssueId) && !grade.issues.some((i) => i.id === focusIssueId);

  const groups = useMemo(() => {
    const visible = grade.issues.filter((i) => !filter || i.severity === filter);
    const bySection = new Map<string, GradeIssue[]>();
    for (const issue of visible) {
      const key = (SECTION_ORDER as readonly string[]).includes(issue.section) ? issue.section : 'other';
      bySection.set(key, [...(bySection.get(key) ?? []), issue]);
    }
    const rank = (s: IssueSeverity) => SEVERITIES.indexOf(s);
    return SECTION_ORDER.filter((s) => bySection.has(s)).map((s) => ({
      section: s,
      issues: [...bySection.get(s)!].sort((a, b) => rank(a.severity) - rank(b.severity)),
    }));
  }, [grade.issues, filter]);

  return (
    <>
      <section className={styles.card} aria-labelledby="resume-check-grade">
        <div className={styles.summary}>
          <div data-tour="grade">
            <span className={styles.gradeBadge}>{t('title')}</span>
            <h2 id="resume-check-grade" className={`${styles.gradeLabel} ${styles.mt2}`}>
              {grade.label ? t(`label.${grade.label}`) : '—'}
            </h2>
            <div className={styles.meta}>
              <p className={styles.body}>{grade.score === null ? '—' : t('score', { score: grade.score })}</p>
              <p className={styles.muted}>
                {grade.rulesChecked === null ? null : t('method', { rules: grade.rulesChecked, ai: grade.method === 'rules_ai' ? 'yes' : 'no' })}
                {skippedNote ? ` ${t(skippedNote)}` : null}
              </p>
              {grade.targetTitle ? <p className={styles.muted}>{t('targetTitle', { title: grade.targetTitle })}</p> : null}
              <p className={styles.muted}>{t('checkedAt', { when: format.dateTime(new Date(grade.completedAt ?? grade.createdAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
              <p className={styles.muted} data-honesty="resume-check">
                {t('honesty')}
              </p>
            </div>
          </div>
          <span data-tour="recheck">
            <Btn onClick={onRecheck}>{t('stale.cta')}</Btn>
          </span>
        </div>

        <div className={styles.counts} role="group" aria-label={t('filter.label')} data-tour="filters">
          <button type="button" className={styles.countBtn} aria-pressed={filter === null} onClick={() => setFilter(null)}>
            {t('filter.all', { count: total })}
          </button>
          {SEVERITIES.map((s) => (
            <button key={s} type="button" className={styles.countBtn} aria-pressed={filter === s} disabled={counts[s] === 0} onClick={() => setFilter(filter === s ? null : s)}>
              <span className={`${styles.dot} ${styles[`sev-${s}`]}`} aria-hidden="true" />
              <strong>{counts[s]}</strong>
              <span>{t(`severity.${s}`)}</span>
            </button>
          ))}
        </div>
      </section>

      {error ? (
        <p className={styles.error} role="alert">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {data.stale ? (
        <div className={styles.banner} role="status">
          <span>{t('stale.body')}</span>
          <Btn variant="primary" onClick={onRecheck}>
            {t('stale.cta')}
          </Btn>
        </div>
      ) : null}

      {focusMissing ? (
        <p className={styles.muted} role="status" data-focus-missing="true">
          {t('focus.gone')}
        </p>
      ) : null}

      {data.previous ? <Comparison current={grade} previous={data.previous} /> : null}

      {total === 0 ? (
        <p className={styles.body} data-tour="issues">
          {t('noIssues')}
        </p>
      ) : (
        groups.map((g, gi) => (
          <section key={g.section} className={styles.group} aria-labelledby={`rc-section-${g.section}`} data-tour={gi === 0 ? 'issues' : undefined}>
            <h3 id={`rc-section-${g.section}`} className={styles.groupTitle}>
              {t(`section.${g.section}`)}
            </h3>
            {g.issues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} fix={fix} editorHref={editorHrefFor(resumeId, issue.anchor)} focused={issue.id === focusIssueId} />
            ))}
          </section>
        ))
      )}
    </>
  );
}

/** Why spelling was not checked on a checklist-only report, as a message key (or null). */
export function aiSkippedNote(grade: GradeView, aiAvailable: boolean): 'methodNoAi' | 'methodNoCredit' | 'methodAiFailed' | null {
  if (grade.method !== 'rules') return null;
  if (grade.aiSkipped === 'credits_exhausted') return 'methodNoCredit';
  if (grade.aiSkipped === 'ai_failed') return 'methodAiFailed';
  if (grade.aiSkipped === 'ai_unavailable' || !aiAvailable) return 'methodNoAi';
  return null;
}

export function Comparison({ current, previous }: { current: GradeView; previous: NonNullable<LatestGradeResponse['previous']> }) {
  const t = useTranslations('resumeCheck');
  const now = current.counts ?? { urgent: 0, critical: 0, optional: 0 };
  const before = previous.counts;
  const currentTypes = new Set(current.issues.map((i) => i.type));
  // A check that ran without the AI pass did not look for what only the AI
  // pass finds (spelling, a vague summary): those are "not checked this
  // time", never "fixed".
  const unchecked = current.method === 'rules_ai' ? [] : (previous.aiIssueTypes ?? []).filter((type) => !currentTypes.has(type));
  const fixed = previous.issueTypes.filter((type) => !currentTypes.has(type) && !unchecked.includes(type));
  const fixedNames = fixed.map((type) => issueTypeName(t, type)).filter((n): n is string => Boolean(n));
  const uncheckedNames = unchecked.map((type) => issueTypeName(t, type)).filter((n): n is string => Boolean(n));
  const same = before ? SEVERITIES.every((s) => before[s] === now[s]) && fixed.length === 0 : false;
  return (
    <section className={styles.card} aria-labelledby="rc-compare">
      <h3 id="rc-compare" className={styles.cardTitle}>
        {t('compare.title')}
      </h3>
      <p className={styles.muted}>
        {t('compare.previous', { label: previous.label ? t(`label.${previous.label}`) : '—', score: previous.score ?? '—' })}
      </p>
      <div className={styles.compareGrid}>
        {SEVERITIES.map((s) => (
          <div key={s} className={styles.compareCell} data-severity={s}>
            <span className={styles.muted}>{t(`severity.${s}`)}</span>
            <p className={styles.compareValue}>{t('compare.row', { before: before ? before[s] : '—', after: now[s] })}</p>
          </div>
        ))}
      </div>
      {fixedNames.length ? (
        <>
          <p className={`${styles.muted} ${styles.mt3}`}>
            {t('compare.fixed')}
          </p>
          <ul className={styles.fixedList}>
            {fixedNames.map((n) => (
              <li key={n} className={`${styles.chip} ${styles.chipOk}`}>
                {n}
              </li>
            ))}
          </ul>
        </>
      ) : same ? (
        <p className={`${styles.muted} ${styles.mt3}`}>
          {t('compare.same')}
        </p>
      ) : null}
      {uncheckedNames.length ? (
        <div data-compare="not-checked">
          <p className={`${styles.muted} ${styles.mt3}`}>{t('compare.notChecked')}</p>
          <ul className={styles.fixedList}>
            {uncheckedNames.map((n) => (
              <li key={n} className={styles.chip}>
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
