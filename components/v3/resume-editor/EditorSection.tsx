'use client';

// EditorSection — the section shell in the left edit pane (.rb-section).
// A mono eyebrow number, the section title, an optional sub line, and an
// optional right-aligned AI chip (e.g. "Rewrite summary") and/or "+ Add" ghost
// button. Source: RoboApply_V3/resume-editor.jsx EditorSection.
//
// `aiBusy` swaps the AI chip into a spinner state while a rewrite is running.

import type { ReactNode } from 'react';

interface Props {
  /** Mono eyebrow, e.g. "01". */
  eyebrow: string;
  title: string;
  /** Optional mono sub line (e.g. "Hover any bullet for inline AI"). */
  subtitle?: string;
  /** Optional AI-chip label; renders the accent ✦ chip when present. */
  aiLabel?: string;
  aiBusy?: boolean;
  onAi?: () => void;
  /** Optional "+ Add …" ghost-button label. */
  addLabel?: string;
  onAdd?: () => void;
  /** Anchor id so the page can scroll to a section. */
  anchorId?: string;
  children: ReactNode;
}

export function EditorSection({
  eyebrow,
  title,
  subtitle,
  aiLabel,
  aiBusy = false,
  onAi,
  addLabel,
  onAdd,
  anchorId,
  children,
}: Props) {
  return (
    <section className="rb-section" id={anchorId}>
      <div className="rb-section-bar">
        <div className="rb-section-eye">{eyebrow}</div>
        <div className="rb-section-title">{title}</div>
        {subtitle ? <div className="rb-section-sub">{subtitle}</div> : null}
        <div style={{ flex: 1 }} />
        {aiLabel ? (
          <button
            type="button"
            className="rb-ai-chip"
            onClick={onAi}
            disabled={aiBusy}
          >
            {aiBusy ? (
              <>
                <span className="rb-ai-spinner" /> {aiLabel}
              </>
            ) : (
              <>
                <span className="rb-ai-spark">✦</span> {aiLabel}
              </>
            )}
          </button>
        ) : null}
        {addLabel ? (
          <button
            type="button"
            className="btn ghost"
            style={{ padding: '5px 9px', fontSize: 11.5 }}
            onClick={onAdd}
          >
            {addLabel}
          </button>
        ) : null}
      </div>
      <div className="rb-section-body">{children}</div>
    </section>
  );
}
