'use client';

// ReviewPanel — the editor's Review tab: this resume's latest check (WP-22) in
// short, beside the live preview (resume.io's AI review tab, built from the
// check RoboApply already has). Only what the check returned is shown (D3):
// the rating label and the checklist score, how it was checked, the counts by
// priority, and the issues grouped by section the way the full check page
// groups them (groupIssues). There is no strengths list: the check does not
// return one.
//
// "Check again" is the check page's own call (useResumeCheck: never blocked
// on credits; with no resume check credit left, or AI off, the free checklist
// runs without the spelling pass), and its cost shows before the click. No
// check yet, a failed one, or one still running: the check page's own start
// and running cards. AI versions of a fix stay on the full check page, one
// link away; here an issue leads to its section in the Edit tab, and a
// two-column template issue to the Customize tab.

import { useId } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../../v3/primitives';
import { useResumeCheck, type ResumeCheckState } from '../../../../hooks/resume/useResumeCheck';
import type { GradeIssue, GradeView, LatestGradeResponse } from '../../../../lib/api/contracts/resume';
import { RunningCard, SEVERITIES, StartCard, aiSkippedNote, checkCostMessage, groupIssues } from '../ResumeCheckReport';
import { resumeCheckHref } from '../ResumeCheckEntry';
import { issueText } from '../issueText';
import { editorSectionIdFor } from './tabs';
import styles from './EditorTabs.module.css';

export interface ReviewPanelProps {
  resumeId: string;
  /** Show the section an anchor points at in the Edit tab. */
  onShowSection: (anchor: string) => void;
  /** Open the Customize tab (the template is chosen there). */
  onCustomize: () => void;
}

export function ReviewPanel({ resumeId, onShowSection, onCustomize }: ReviewPanelProps) {
  const t = useTranslations('resumeCheck');
  const te = useTranslations('resume.editor_tabs.check');
  const check = useResumeCheck(resumeId);
  const data = check.latest.data;
  const grade = data?.grade ?? null;

  let body;
  if (check.latest.isLoading) {
    body = (
      <p className={styles.muted} role="status">
        {te('loading')}
      </p>
    );
  } else if (check.latest.isError) {
    body = (
      <div className={styles.actions}>
        <p className={styles.error} role="alert">
          {te('load_error')}
        </p>
        <Btn onClick={() => void check.latest.refetch()}>{t('failed.retry')}</Btn>
      </div>
    );
  } else if (check.running || grade?.status === 'running') {
    body = <RunningCard onCancel={check.cancel} />;
  } else if (grade?.status === 'done' && data) {
    body = <Summary resumeId={resumeId} data={data} grade={grade} check={check} onShowSection={onShowSection} onCustomize={onCustomize} />;
  } else {
    body = (
      <StartCard
        aiAvailable={data?.aiAvailable ?? true}
        creditsLeft={check.creditsLeft}
        failed={grade?.status === 'failed'}
        error={check.error}
        onRun={(title) => void check.run(title)}
      />
    );
  }

  return (
    <div className={styles.review} data-panel="review">
      {body}
    </div>
  );
}

function Summary({
  resumeId,
  data,
  grade,
  check,
  onShowSection,
  onCustomize,
}: {
  resumeId: string;
  data: LatestGradeResponse;
  grade: GradeView;
  check: ResumeCheckState;
  onShowSection: (anchor: string) => void;
  onCustomize: () => void;
}) {
  const t = useTranslations('resumeCheck');
  const te = useTranslations('resume.editor_tabs.check');
  const format = useFormatter();
  const id = useId();
  const groups = groupIssues(grade.issues);
  const skipped = aiSkippedNote(grade, data.aiAvailable);
  const cost = checkCostMessage(data.aiAvailable, check.creditsLeft);

  return (
    <>
      <section className={styles.summary} aria-labelledby={`${id}-grade`} data-grade={grade.label ?? 'none'}>
        <span className={styles.badge}>{t('title')}</span>
        <h2 className={styles.rating} id={`${id}-grade`}>
          {grade.label ? t(`label.${grade.label}`) : '—'}
        </h2>
        <p className={styles.score}>{grade.score === null ? '—' : t('score', { score: grade.score })}</p>

        <ul className={styles.counts} aria-label={te('counts')}>
          {SEVERITIES.map((s) => (
            <li key={s} className={styles.count} data-severity={s}>
              <span className={styles.dot} data-severity={s} aria-hidden="true" />
              <strong>{grade.counts ? grade.counts[s] : '—'}</strong>
              <span>{t(`severity.${s}`)}</span>
            </li>
          ))}
        </ul>

        <div className={styles.meta}>
          {grade.rulesChecked !== null || skipped ? (
            <p className={styles.muted}>
              {grade.rulesChecked === null ? null : t('method', { rules: grade.rulesChecked, ai: grade.method === 'rules_ai' ? 'yes' : 'no' })}
              {skipped ? ` ${t(skipped)}` : null}
            </p>
          ) : null}
          {grade.targetTitle ? <p className={styles.muted}>{t('targetTitle', { title: grade.targetTitle })}</p> : null}
          <p className={styles.muted}>
            {t('checkedAt', { when: format.dateTime(new Date(grade.completedAt ?? grade.createdAt), { dateStyle: 'medium', timeStyle: 'short' }) })}
          </p>
          <p className={styles.muted} data-honesty="resume-check">
            {t('honesty')}
          </p>
        </div>

        {data.stale ? (
          <p className={styles.notice} role="status">
            {t('stale.body')}
          </p>
        ) : null}
        {check.error ? (
          <p className={styles.error} role="alert">
            {t(`errors.${check.error}`)}
          </p>
        ) : null}

        <div className={styles.actions}>
          <Btn onClick={() => void check.run(grade.targetTitle ?? undefined)}>{t('stale.cta')}</Btn>
          <a className={styles.link} href={resumeCheckHref(resumeId)}>
            {t('editor.open')}
          </a>
        </div>
        <p className={styles.muted}>{t(cost.key, cost.values)}</p>
      </section>

      {grade.issues.length === 0 ? (
        <p className={styles.body}>{t('noIssues')}</p>
      ) : (
        groups.map((g) => {
          const titleId = `${id}-${g.section}`;
          const name = t(`section.${g.section}`);
          // Anchors are per section; the first one the Edit tab knows leads there.
          const anchor = g.issues.map((i) => i.anchor).find((a): a is string => editorSectionIdFor(a) !== null) ?? null;
          return (
            <section key={g.section} className={styles.group} aria-labelledby={titleId} data-section={g.section}>
              <div className={styles.groupHead}>
                <h3 className={styles.groupTitle} id={titleId}>
                  {name}
                </h3>
                {anchor ? (
                  <button type="button" className={styles.linkButton} aria-label={te('edit_section_aria', { section: name })} onClick={() => onShowSection(anchor)}>
                    {te('edit_section')}
                  </button>
                ) : null}
              </div>
              <ul className={styles.issues}>
                {g.issues.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} onCustomize={onCustomize} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </>
  );
}

function IssueRow({ issue, onCustomize }: { issue: GradeIssue; onCustomize: () => void }) {
  const t = useTranslations('resumeCheck');
  const te = useTranslations('resume.editor_tabs.check');
  const text = issueText(t, issue);
  const quote = issue.target ?? issue.evidence ?? null;
  return (
    <li className={styles.issue} data-severity={issue.severity} data-issue-type={issue.type}>
      <span className={styles.dot} data-severity={issue.severity} aria-hidden="true" />
      <div className={styles.issueBody}>
        <span className={styles.sev}>{t(`severity.${issue.severity}`)}</span>
        <p className={styles.issueTitle}>{text.title}</p>
        {quote ? (
          <blockquote className={styles.quote} aria-label={t('detail.evidence')}>
            {quote}
          </blockquote>
        ) : null}
        <p className={styles.how}>{text.how}</p>
        {issue.carriedOver ? (
          <p className={styles.muted} data-carried="true">
            {t('carried')}
          </p>
        ) : null}
        {/* "Use a single-column template": the template is picked in Customize. */}
        {issue.type === 'layout_columns' ? (
          <button type="button" className={styles.linkButton} onClick={onCustomize}>
            {te('change_template')}
          </button>
        ) : null}
      </div>
    </li>
  );
}
