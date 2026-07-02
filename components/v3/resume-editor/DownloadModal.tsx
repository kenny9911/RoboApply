'use client';

// DownloadModal — the export-format chooser (.rb-modal). Source:
// RoboApply_V3/resume-editor.jsx DownloadModal. PDF + DOCX are now REAL
// server-rendered exports of the built/tailored resume markdown (GET
// /resumes/:id/export?format=…, lib/resumeDownload). TXT/MD are client-side
// blob downloads of the current markdown.
//
// Modal panel uses a LITERAL solid background (CLAUDE.md rule).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconX, IconArrow } from '../primitives';
import { downloadResumeExport } from '../../../lib/resumeDownload';

type Format = 'pdf' | 'docx' | 'txt' | 'md';

interface Props {
  resumeId: string;
  resumeName: string;
  resumeMarkdown: string;
  onClose: () => void;
}

// Solid panel bg. Theme-aware var(--surface) — flips white in light, dark in dark (the bare token is on :root, so it never bleeds; the .rb-modal-card class also paints it).
const PANEL_BG = 'var(--surface)';

const FORMATS: Array<{ id: Format; recommended?: boolean }> = [
  { id: 'pdf', recommended: true },
  { id: 'docx' },
  { id: 'txt' },
  { id: 'md' },
];

export function DownloadModal({ resumeId, resumeName, resumeMarkdown, onClose }: Props) {
  const t = useTranslations('resumeEditor');
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState(false);

  async function handle(format: Format) {
    if (busy) return;
    // Server-rendered exports of the actual resume (not a print of the editor).
    if (format === 'pdf' || format === 'docx') {
      setBusy(format);
      setError(false);
      try {
        await downloadResumeExport(resumeId, format, resumeName);
        onClose();
      } catch {
        setError(true);
      } finally {
        setBusy(null);
      }
      return;
    }
    // TXT / MD — client-side blob of the current markdown.
    if (typeof window !== 'undefined') {
      const blob = new Blob([resumeMarkdown], {
        type: format === 'md' ? 'text/markdown' : 'text/plain',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${resumeName || 'resume'}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    }
    onClose();
  }

  return (
    <div className="rb-modal" onClick={onClose}>
      <div
        className="rb-modal-card"
        style={{ maxWidth: 460, background: PANEL_BG }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rb-modal-head">
          <div>
            <div
              className="iv-step-num"
              style={{ display: 'inline-block', marginBottom: 8 }}
            >
              {t('download.eyebrow')}
            </div>
            <h2 className="rb-modal-title">{t('download.title')}</h2>
          </div>
          <button
            type="button"
            className="iv-coach-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconX size={16} />
          </button>
        </div>
        <div
          className="rb-modal-body"
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="rb-download-row"
              onClick={() => handle(f.id)}
              disabled={busy !== null}
              style={busy !== null ? { opacity: busy === f.id ? 1 : 0.5 } : undefined}
            >
              <div className="rb-download-lbl">
                {t(`download.${f.id}.label`)}
                {busy === f.id ? <span className="rb-ai-spinner" style={{ marginLeft: 8 }} /> : null}
              </div>
              <div className="rb-download-desc">{t(`download.${f.id}.desc`)}</div>
              {f.recommended ? (
                <span className="iv-format-tag recommended">
                  {t('download.recommended')}
                </span>
              ) : null}
              <IconArrow size={14} />
            </button>
          ))}
          {error ? (
            <p style={{ fontSize: 12, color: 'var(--warn)', marginTop: 4 }} role="alert">
              {t('download.error')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
