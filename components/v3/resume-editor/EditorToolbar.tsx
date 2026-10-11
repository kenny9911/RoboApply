'use client';

// EditorToolbar — the top bar of the resume editor (.rb-toolbar). Source:
// RoboApply_V3/resume-editor.jsx top toolbar. Holds: back link, an editable
// resume title, a live "saved" + strength meter, and the Coach / Download /
// Tailor actions.
//
// The title is an inline editable input styled to look like text (the page
// debounce-PATCHes the rename). The strength meter is derived display state
// the page owns — clicking it opens the AnalyzerPanel issue list (the WHY
// behind the number, with click-to-fix jumps).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, IconSparkle, IconArrow, IconBolt, IconUpload, IconTrash } from '../primitives';
import { AnalyzerPanel } from './AnalyzerPanel';
import { ResumeCheckEntry } from '../../features/resume';
import type { AnalyzerReport } from '../../../lib/resumeAnalyzer';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  name: string;
  onRename: (next: string) => void;
  saveState: SaveState;
  /** 0..100 resume strength; null when the resume could not be analysed (the meter is then not shown). */
  strength: number | null;
  /** Full analyzer report backing the meter; null while structured is unset. */
  report?: AnalyzerReport | null;
  /** Scroll to the section an analyzer issue points at. */
  onJumpToIssue?: (anchor?: string) => void;
  coachOpen: boolean;
  onToggleCoach: () => void;
  onDownload: () => void;
  onTailor: () => void;
  onDelete: () => void;
  onBack: () => void;
  /** Resume id: adds the Resume check entry and the server check in the analyzer popover (WP-22). */
  resumeId?: string;
  /** False hides AI-only actions (Tailor) when the user's AI is off. Default true. */
  aiEnabled?: boolean;
}

export function EditorToolbar({
  name,
  onRename,
  saveState,
  strength,
  report,
  onJumpToIssue,
  coachOpen,
  onToggleCoach,
  onDownload,
  onTailor,
  onDelete,
  onBack,
  resumeId,
  aiEnabled = true,
}: Props) {
  const t = useTranslations('resume');
  const [issuesOpen, setIssuesOpen] = useState(false);

  const savedLabel =
    saveState === 'saving'
      ? t('toolbar.saving')
      : saveState === 'error'
        ? t('toolbar.save_error')
        : t('toolbar.saved');

  return (
    <div className="rb-toolbar">
      <Btn variant="ghost" onClick={onBack} icon={<IconArrow size={13} style={{ transform: 'rotate(180deg)' }} />}>
        {t('toolbar.back')}
      </Btn>

      <div className="rb-title-wrap">
        <input
          className="rb-title"
          value={name}
          onChange={(e) => onRename(e.target.value)}
          aria-label={t('toolbar.rename')}
          // A long name is cut with an ellipsis; the full name stays readable on hover.
          title={name}
          style={{
            background: 'transparent',
            border: 0,
            outline: 'none',
            width: '100%',
            color: 'var(--text)',
            fontFamily: 'var(--font-ui)',
          }}
        />
        <div className="rb-title-meta">
          <span
            className="rb-saved"
            style={saveState === 'error' ? { color: 'var(--warn)' } : undefined}
          >
            {savedLabel}
          </span>
          {strength === null ? null : (
          <span className="rb-analyzer-wrap">
            <button
              type="button"
              className="rb-strength rb-strength-btn"
              onClick={() => setIssuesOpen((o) => !o)}
              disabled={!report}
              aria-expanded={issuesOpen}
              // This number is the editor's own quick score (it moves as you
              // type). It is not the Resume check result; the label and the
              // hint say so, so the two are never read as one score.
              title={t('toolbar.quick_score_hint')}
              aria-label={`${t('toolbar.quick_score')} ${strength}. ${t('toolbar.quick_score_hint')}`}
            >
              <span className="rb-strength-lbl">{t('toolbar.quick_score')}</span>
              <span className="rb-strength-bar">
                <span className="fill" style={{ width: `${strength}%` }} />
              </span>
              <span className="rb-strength-num">{strength}</span>
              {report && report.counts.total > 0 ? (
                <span className="rb-strength-issues">{report.counts.total}</span>
              ) : null}
            </button>
            {issuesOpen && report ? (
              <AnalyzerPanel
                report={report}
                resumeId={resumeId}
                onJump={(anchor) => {
                  onJumpToIssue?.(anchor);
                  setIssuesOpen(false);
                }}
                onClose={() => setIssuesOpen(false)}
              />
            ) : null}
          </span>
          )}
        </div>
      </div>

      <div className="rb-toolbar-actions">
        {resumeId ? <ResumeCheckEntry resumeId={resumeId} name={name} /> : null}
        <Btn variant="ghost" onClick={onToggleCoach} icon={<IconSparkle size={13} />}>
          {coachOpen ? t('toolbar.hide_coach') : t('toolbar.coach')}
        </Btn>
        <Btn variant="ghost" onClick={onDelete} icon={<IconTrash size={13} />}>
          {t('toolbar.delete')}
        </Btn>
        <Btn onClick={onDownload} icon={<IconUpload size={13} style={{ transform: 'rotate(180deg)' }} />}>
          {t('toolbar.download')}
        </Btn>
        {aiEnabled ? (
          <Btn variant="primary" onClick={onTailor} icon={<IconBolt size={13} />}>
            {t('toolbar.tailor')}
          </Btn>
        ) : null}
      </div>
    </div>
  );
}
