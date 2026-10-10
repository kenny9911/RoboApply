'use client';

// IssueCard — one resume-check issue (WP-22; F-RES-05): what it is, the quote
// from the resume, why it matters, how to fix it, and — when the issue has
// text an AI version can rewrite and AI is available — the fix panel:
// Write an AI version → Use · Edit · Shorter · Longer · Stronger.
//
// AI output is always labelled: "AI version" here, plus AiGeneratedBadge,
// which renders on GoApply (the badge decides; no market branch here).
// Nothing is written to the resume until the user picks Use or Save.

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import type { GradeIssue } from '../../../lib/api/contracts/resume';
import type { FixVariant, IssueFixError, IssueFixState } from '../../../hooks/resume/useResumeCheck';
import { issueText } from './issueText';
import styles from './ResumeCheck.module.css';

export interface IssueCardProps {
  issue: GradeIssue;
  /** Fix actions; null hides the AI panel (AI unavailable). */
  fix: IssueFixState | null;
  /** Editor link for this issue's section. */
  editorHref: string;
  /** Called after the resume text was replaced. */
  onApplied?: () => void;
  /**
   * A link pointed at this issue (`/resume/<id>/check?issue=<id>`): it opens
   * with its details shown, scrolls into view once and takes focus.
   */
  focused?: boolean;
}

/** The element id of an issue card, for links and focus. */
export function issueElementId(issueId: string): string {
  return `issue-${issueId}`;
}

const VARIANTS: Array<Exclude<FixVariant, 'ai'>> = ['shorter', 'longer', 'stronger'];

export function IssueCard({ issue, fix, editorHref, onApplied, focused = false }: IssueCardProps) {
  const t = useTranslations('resumeCheck');
  const text = issueText(t, issue);
  const detailsId = useId();
  const cardRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(issue.severity === 'urgent' || focused);

  useEffect(() => {
    if (!focused) return;
    const el = cardRef.current;
    if (!el) return;
    setOpen(true);
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }, [focused]);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(0);
  const [error, setError] = useState<IssueFixError | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [applied, setApplied] = useState<'ok' | 'failed' | null>(null);

  const canFix = Boolean(fix && issue.fixable && issue.target);

  async function write(variant: FixVariant) {
    if (!fix) return;
    setBusy(true);
    setError(null);
    setApplied(null);
    const r = await fix.write(issue.id, variant, instruction.trim() || undefined);
    setBusy(false);
    if (r.ok) {
      setSuggestions(r.value.suggestions.map((s) => s.text));
      setBlocked(r.value.blocked);
    } else {
      setError(r.error);
    }
  }

  async function use(value: string) {
    if (!fix) return;
    setBusy(true);
    const ok = await fix.apply(issue.id, value);
    setBusy(false);
    setApplied(ok ? 'ok' : 'failed');
    if (ok) {
      setSuggestions([]);
      setEditing(null);
      onApplied?.();
    }
  }

  return (
    <article
      ref={cardRef}
      id={issueElementId(issue.id)}
      tabIndex={-1}
      className={focused ? `${styles.issue} ${styles.issueFocused}` : styles.issue}
      data-issue-type={issue.type}
      data-severity={issue.severity}
      data-focused={focused ? 'true' : undefined}
    >
      <div className={styles.issueHead}>
        <span className={`${styles.dot} ${styles[`sev-${issue.severity}`]}`} aria-hidden="true" />
        <div className={styles.grow}>
          <span className={styles.sevText}>{t(`severity.${issue.severity}`)}</span>
          <h4 className={styles.issueTitle}>{text.title}</h4>
        </div>
      </div>

      {issue.evidence || issue.target ? (
        <blockquote className={styles.quote} aria-label={t('detail.evidence')}>
          {issue.target ?? issue.evidence}
        </blockquote>
      ) : null}

      <button type="button" className={styles.linkBtn} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((o) => !o)}>
        {open ? t('detail.hide') : t('detail.show')}
      </button>
      {open ? (
        <div id={detailsId} className={styles.details}>
          <div>
            <p className={styles.detailLabel}>{t('detail.why')}</p>
            <p className={styles.body}>{text.why}</p>
          </div>
          <div>
            <p className={styles.detailLabel}>{t('detail.how')}</p>
            <p className={styles.body}>{text.how}</p>
          </div>
        </div>
      ) : null}

      {canFix && fix ? (
        <div className={styles.fix}>
          <label className={styles.field}>
            {t('fix.instructionLabel')}
            <input
              className={styles.input}
              value={instruction}
              maxLength={1000}
              placeholder={t('fix.instructionPlaceholder')}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <Btn variant="primary" onClick={() => write('ai')} disabled={busy}>
              {suggestions.length ? t('fix.again') : t('fix.write')}
            </Btn>
            {suggestions.length
              ? VARIANTS.map((v) => (
                  <Btn key={v} variant="ghost" onClick={() => write(v)} disabled={busy}>
                    {t(`fix.${v}`)}
                  </Btn>
                ))
              : null}
          </div>
          <p className={styles.muted}>{fix.creditsLeft === null ? t('fix.credit') : t('fix.creditLeft', { left: fix.creditsLeft })}</p>

          {busy ? (
            <p className={styles.muted} role="status">
              <span className={`${styles.spinner} ${styles.inlineSpinner}`} aria-hidden="true" />
              {t('fix.writing')}
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {t(`fix.errors.${error}`)}
            </p>
          ) : null}
          {blocked > 0 && suggestions.length > 0 ? <p className={styles.muted}>{t('fix.blocked', { count: blocked })}</p> : null}
          {applied === 'ok' ? (
            <p className={styles.muted} role="status">
              {t('fix.applied')}
            </p>
          ) : null}
          {applied === 'failed' ? (
            <p className={styles.error} role="alert">
              {t('fix.applyFailed')}
            </p>
          ) : null}

          {suggestions.map((s, i) => (
            <div key={`${i}-${s.slice(0, 20)}`} className={styles.suggestion} data-ai-output="true">
              <div className={styles.suggestionHead}>
                <span>{t('fix.suggestion')}</span>
                <AiGeneratedBadge kind="text" />
              </div>
              {editing !== null && editing === s ? null : <p className={styles.suggestionText}>{s}</p>}
              {editing === s ? (
                <EditBox initial={s} busy={busy} onCancel={() => setEditing(null)} onSave={(v) => use(v)} />
              ) : (
                <div className={styles.actions}>
                  <Btn variant="primary" onClick={() => use(s)} disabled={busy}>
                    {t('fix.use')}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setEditing(s)} disabled={busy}>
                    {t('fix.edit')}
                  </Btn>
                </div>
              )}
            </div>
          ))}
          {suggestions.length ? <p className={styles.muted}>{t('fix.review')}</p> : null}
        </div>
      ) : null}

      <div className={styles.actions}>
        <a className={styles.linkBtn} href={editorHref}>
          {t('openEditor')}
        </a>
      </div>
    </article>
  );
}

function EditBox({ initial, busy, onCancel, onSave }: { initial: string; busy: boolean; onCancel: () => void; onSave: (v: string) => void }) {
  const t = useTranslations('resumeCheck');
  const [value, setValue] = useState(initial);
  return (
    <div className={styles.field}>
      <textarea className={styles.textarea} aria-label={t('fix.editLabel')} value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
      <div className={styles.actions}>
        <Btn variant="primary" onClick={() => onSave(value)} disabled={busy || !value.trim()}>
          {t('fix.save')}
        </Btn>
        <Btn variant="ghost" onClick={onCancel} disabled={busy}>
          {t('fix.cancelEdit')}
        </Btn>
      </div>
    </div>
  );
}
