'use client';

// ResumeCard — one card in the library grid (.rb-card). Source:
// RoboApply_V3/resume.jsx ResumeCard. Renders a faux "paper" preview, the
// variant name + a derived version pill, a tailored-for line (or a "base"
// muted line), and a meta row with the last-edited time.
//
// No fit number here. A resume version's fit for its target job is the "With
// this version" number, shown only in tailoring and read live there
// (MARKET_STRATEGY §2.2). The stored copy (`matchScoreCached`) was frozen at
// the last model call, carried no label, kind or date, and is not printed.
//
// Data: a single `RAResumeVariantSummary` from `resumes.list()`. The prototype
// carries `sections` + `version` which the summary shape does NOT have:
//   • `version` is derived by the page (oldest = v1) and passed in.
//   • `sections` is dropped — it's display-only fluff with no contract field.
// Clicking the card routes to the editor (`/resumes/[id]`) — the page owns the
// push so Lane F's route stays the only coupling point.

import { useTranslations } from 'next-intl';

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
  onOpen: () => void;
  /** Open the delete-confirm for this variant. Omit to hide the control. */
  onDelete?: () => void;
  /** Localized aria-label / tooltip for the delete control. */
  deleteLabel?: string;
}

export function ResumeCard({
  resume,
  version,
  editedLabel,
  baseLabel,
  onOpen,
  onDelete,
  deleteLabel,
}: Props) {
  const t = useTranslations('resume');
  const tailored = Boolean(resume.targetJobTitle || resume.targetJobCompany);

  return (
    <div className="rb-card-wrap">
      <button type="button" className="rb-card" onClick={onOpen}>
      <div className="rb-card-paper">
        {/* mini paper preview — decorative */}
        <div className="rb-mini" aria-hidden="true">
          <div className="rb-mini-name">{resume.name}</div>
          <div className="rb-mini-line" style={{ width: '60%' }} />
          <div className="rb-mini-spacer" />
          {/* Section names in the interface language (they were fixed English words). */}
          <div className="rb-mini-section">{t('section.experience')}</div>
          <div className="rb-mini-line" style={{ width: '85%' }} />
          <div className="rb-mini-line" style={{ width: '95%' }} />
          <div className="rb-mini-line" style={{ width: '70%' }} />
          <div className="rb-mini-spacer" />
          <div className="rb-mini-section">{t('section.education')}</div>
          <div className="rb-mini-line" style={{ width: '75%' }} />
        </div>
        {tailored ? <div className="rb-mini-stamp">{t('card.tailored_stamp')}</div> : null}
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
            {resume.targetJobTitle ?? ''}
          </div>
        ) : (
          <div className="rb-card-tailored muted">{baseLabel}</div>
        )}

        <div className="rb-card-meta">
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
