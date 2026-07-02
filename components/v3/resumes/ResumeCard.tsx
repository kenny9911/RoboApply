'use client';

// ResumeCard — one card in the library grid (.rb-card). Source:
// RoboApply_V3/resume.jsx ResumeCard. Renders a faux "paper" preview, the
// variant name + a derived version pill, a tailored-for line (or a "base"
// muted line), and a mono meta row with the cached match score + last-edited.
//
// Data: a single `RAResumeVariantSummary` from `resumes.list()`. The prototype
// carries `sections` + `version` which the summary shape does NOT have:
//   • `version` is derived by the page (oldest = v1) and passed in.
//   • `sections` is dropped — it's display-only fluff with no contract field.
// Clicking the card routes to the editor (`/resumes/[id]`) — the page owns the
// push so Lane F's route stays the only coupling point.

import type { RAResumeVariantSummary } from '../../../lib/api/v2/types';
import { IconTrash } from '../primitives';

interface Props {
  resume: RAResumeVariantSummary;
  /** Derived display label, e.g. "v3". */
  version: string;
  /** Localized "Edited {when}" string (page formats the date). */
  editedLabel: string;
  /** Localized fallback when the variant isn't tailored to a job. */
  baseLabel: string;
  /** Localized "/100" suffix unit. */
  scoreUnit: string;
  onOpen: () => void;
  /** Open the delete-confirm for this variant. Omit to hide the control. */
  onDelete?: () => void;
  /** Localized aria-label / tooltip for the delete control. */
  deleteLabel?: string;
}

function scoreColor(score: number): string {
  if (score >= 90) return 'var(--ok)';
  if (score >= 80) return 'var(--accent-text)';
  return 'var(--warn)';
}

export function ResumeCard({
  resume,
  version,
  editedLabel,
  baseLabel,
  scoreUnit,
  onOpen,
  onDelete,
  deleteLabel,
}: Props) {
  const tailored = Boolean(resume.targetJobTitle || resume.targetJobCompany);
  const score = resume.matchScoreCached;

  return (
    <div className="rb-card-wrap">
      <button type="button" className="rb-card" onClick={onOpen}>
      <div className="rb-card-paper">
        {/* mini paper preview — decorative */}
        <div className="rb-mini" aria-hidden="true">
          <div className="rb-mini-name">{resume.name}</div>
          <div className="rb-mini-line" style={{ width: '60%' }} />
          <div className="rb-mini-spacer" />
          <div className="rb-mini-section">EXPERIENCE</div>
          <div className="rb-mini-line" style={{ width: '85%' }} />
          <div className="rb-mini-line" style={{ width: '95%' }} />
          <div className="rb-mini-line" style={{ width: '70%' }} />
          <div className="rb-mini-spacer" />
          <div className="rb-mini-section">EDUCATION</div>
          <div className="rb-mini-line" style={{ width: '75%' }} />
        </div>
        {tailored ? <div className="rb-mini-stamp">TAILORED</div> : null}
      </div>

      <div className="rb-card-body">
        <div className="rb-card-head">
          <div className="rb-card-name">{resume.name}</div>
          <div className="rb-card-version">{version}</div>
        </div>

        {tailored ? (
          <div className="rb-card-tailored">
            <span className="rb-card-arrow">→</span>
            {resume.targetJobCompany ? `${resume.targetJobCompany} · ` : ''}
            <em>{resume.targetJobTitle ?? ''}</em>
          </div>
        ) : (
          <div className="rb-card-tailored muted">{baseLabel}</div>
        )}

        <div className="rb-card-meta">
          {score !== null ? (
            <span className="rb-card-score" style={{ color: scoreColor(score) }}>
              {Math.round(score)}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{scoreUnit}</span>
            </span>
          ) : null}
          {score !== null ? <span className="rb-card-divider">·</span> : null}
          <span>{editedLabel}</span>
        </div>
      </div>
      </button>

      {onDelete ? (
        <button
          type="button"
          className="rb-card-del"
          aria-label={deleteLabel}
          title={deleteLabel}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <IconTrash size={14} />
        </button>
      ) : null}
    </div>
  );
}
