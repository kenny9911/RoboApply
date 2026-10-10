'use client';

// DownloadModal — the export chooser (.rb-modal). Source:
// RoboApply_V3/resume-editor.jsx DownloadModal. PDF + DOCX are server-rendered
// exports of the resume with its saved layout (GET /resumes/:id/export,
// lib/api/resumes downloadResumeExport). TXT/MD are client-side blobs of the
// current markdown.
//
// WP-36b: file-name presets; export refused while inserted details are not
// verified (ruling C12; the server answers 409 unverified_claims too); an
// "AI wrote part of this resume" line with the GoApply AI badge; the WeChat
// in-app browser banner on downloads; `trackerEntryId` records the exact file
// on an application.
//
// WP-65: `photo` (a data URL kept on this device) travels in the POST body and
// the renderer places it; it is never stored. A file recorded on an
// application (`trackerEntryId`) is stored, so the server makes it without
// the photo on every brand (X-Photo-Omitted).
//
// Modal panel uses a LITERAL solid background (CLAUDE.md rule).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconX, IconArrow } from '../primitives';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';
import { FILE_NAME_STYLES, downloadResumeExport, type FileNameStyle } from '../../../lib/api/resumes';
import { WechatBrowserBanner } from '../../features/auth-cn';
import { AiGeneratedBadge } from '../../features/market';
import styles from '../../features/resume/ResumeHub.module.css';

type Format = 'pdf' | 'docx' | 'txt' | 'md';

interface Props {
  resumeId: string;
  resumeName: string;
  resumeMarkdown: string;
  /** Inserted details still to verify (>0 blocks PDF/DOCX). */
  unverifiedClaims?: number;
  /** AI wrote part of this resume (the file carries the AI marks). */
  aiAssisted?: boolean;
  /** Record the exact file on this application. */
  trackerEntryId?: string | null;
  /** WP-65: a photo kept on this device, placed in the PDF/DOCX (never stored on the server). */
  photo?: string | null;
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

export function DownloadModal({
  resumeId,
  resumeName,
  resumeMarkdown,
  unverifiedClaims = 0,
  aiAssisted = false,
  trackerEntryId = null,
  photo = null,
  onClose,
}: Props) {
  const t = useTranslations('resume');
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState(false);
  const [blockedCount, setBlockedCount] = useState(unverifiedClaims);
  const [nameStyle, setNameStyle] = useState<FileNameStyle>('name_company_role');
  const blocked = blockedCount > 0;

  async function handle(format: Format) {
    if (busy) return;
    // Server-rendered exports of the actual resume (not a print of the editor).
    if (format === 'pdf' || format === 'docx') {
      if (blocked) return;
      setBusy(format);
      setError(false);
      try {
        await downloadResumeExport(resumeId, { format, nameStyle, trackerEntryId, ...(photo ? { photo } : {}) }, resumeName);
        onClose();
      } catch (err) {
        if (apiErrorCode(err) === 'unverified_claims') {
          const count = Number(apiErrorDetails<{ count?: number }>(err)?.count ?? 1);
          setBlockedCount(count > 0 ? count : 1);
        } else {
          setError(true);
        }
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="rb-download-title"
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
            <h2 className="rb-modal-title" id="rb-download-title">{t('download.title')}</h2>
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
          <WechatBrowserBanner action="download" />

          {blocked ? (
            <p className={styles.blocked} role="alert">
              {t('export.blocked', { count: blockedCount })}
            </p>
          ) : null}

          <label className={styles.legend} htmlFor="rb-download-name">
            {t('export.name_label')}
          </label>
          <select
            id="rb-download-name"
            className={styles.select}
            value={nameStyle}
            onChange={(e) => setNameStyle(e.target.value as FileNameStyle)}
          >
            {FILE_NAME_STYLES.map((s) => (
              <option key={s} value={s}>
                {t(`export.name.${s}`)}
              </option>
            ))}
          </select>

          {FORMATS.map((f) => {
            const off = busy !== null || (blocked && (f.id === 'pdf' || f.id === 'docx'));
            return (
              <button
                key={f.id}
                type="button"
                className="rb-download-row"
                onClick={() => handle(f.id)}
                disabled={off}
                style={off ? { opacity: busy === f.id ? 1 : 0.5 } : undefined}
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
            );
          })}

          {aiAssisted ? (
            <p className={styles.aiNote}>
              <AiGeneratedBadge kind="document" />
              <span>{t('export.ai_note')}</span>
            </p>
          ) : null}

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
