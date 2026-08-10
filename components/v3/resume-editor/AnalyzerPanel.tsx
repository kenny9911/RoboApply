'use client';

// AnalyzerPanel — the issue list behind the toolbar strength meter. Fresh V3
// component (NOT a port of the orphaned V2 BuilderAnalyzer): the meter score
// was previously the only surfaced output of lib/resumeAnalyzer; this popover
// shows WHY the score is what it is, with click-to-fix navigation via the
// analyzer's per-issue anchors.
//
// lib/resumeAnalyzer emits an i18n key plus ICU values per issue, never a
// sentence: the analyzer is pure/synchronous and locale-blind, and this panel
// is the only place its issues are read. Everything here goes through the
// catalog like the rest of the editor.

import { useTranslations } from 'next-intl';

import { IconX } from '../primitives';
import type { AnalyzerIssue, AnalyzerReport, AnalyzerSeverity } from '../../../lib/resumeAnalyzer';

interface Props {
  report: AnalyzerReport;
  /** Scroll/focus the section the issue points at. */
  onJump: (anchor?: string) => void;
  onClose: () => void;
}

const SEVERITY_ORDER: AnalyzerSeverity[] = ['critical', 'recommended', 'optional'];

export function AnalyzerPanel({ report, onJump, onClose }: Props) {
  const t = useTranslations('resume');

  const sorted: AnalyzerIssue[] = SEVERITY_ORDER.flatMap((sev) =>
    report.issues.filter((i) => i.severity === sev),
  );

  // An experience entry with neither a company nor a title has no name to put
  // in front of the issue, so it is labelled by its position — translated,
  // like everything else the user reads here.
  const issueText = (issue: AnalyzerIssue) => {
    const values = issue.messageValues ?? {};
    const where =
      values.where ||
      (values.entry === undefined
        ? ''
        : t('analyzer.issue.entry_fallback', { index: values.entry }));
    return t(`analyzer.issue.${issue.messageKey}`, { ...values, where });
  };

  return (
    <div className="rb-analyzer-pop" role="dialog" aria-label={t('analyzer.title')}>
      <div className="rb-analyzer-head">
        <span className="rb-analyzer-title">{t('analyzer.title')}</span>
        <span className="rb-analyzer-score">{report.score}</span>
        <button
          type="button"
          className="iv-coach-close"
          style={{ marginLeft: 'auto' }}
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <IconX size={11} />
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="rb-analyzer-empty">{t('analyzer.empty')}</p>
      ) : (
        <div className="rb-analyzer-list">
          {sorted.map((issue) => (
            <button
              key={issue.id}
              type="button"
              className="rb-issue"
              onClick={() => onJump(issue.anchor)}
            >
              <span className={`rb-issue-dot ${issue.severity}`} aria-hidden="true" />
              <span>
                <span className="rb-issue-sev">
                  {t(`analyzer.severity.${issue.severity}`)}
                </span>
                <span className="rb-issue-msg">{issueText(issue)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
