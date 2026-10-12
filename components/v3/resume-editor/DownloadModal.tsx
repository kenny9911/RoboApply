'use client';

// DownloadModal — the export chooser (.rb-modal). Source:
// RoboApply_V3/resume-editor.jsx DownloadModal. PDF + DOCX are server-rendered
// exports of the resume with its saved layout (GET /resumes/:id/export,
// lib/api/resumes downloadResumeExport). TXT/MD are client-side files of the
// current text: Markdown as written, plain text with the markup removed
// (plainText.ts).
//
// WP-36b: file-name presets; export refused while inserted details are not
// verified (ruling C12; the server answers 409 unverified_claims too); an
// "AI wrote part of this resume" line with the GoApply AI badge; the WeChat
// in-app browser banner on downloads; `trackerEntryId` records the exact file
// on an application.
//
// The Verify-details block covers EVERY format: plain text and Markdown are
// the same unchecked AI text as the PDF. The message names the real reason
// (details not checked yet) and links to Verify details.
//
// Unfilled placeholders ("[X]", "[n=__]" left by an accepted AI suggestion):
// the lines are listed and nothing downloads until the user fills them in or
// says, in so many words, to download with the blanks. The dialog finds them
// itself in the text it is about to hand out, so every place that opens it
// (the editor, an application in the tracker) gets the same hold; a caller
// may pass its own list (the editor's, taken from unsaved edits).
//
// WP-65: `photo` (a data URL kept on this device) travels in the POST body and
// the renderer places it; it is never stored. A file recorded on an
// application (`trackerEntryId`) is stored, so the server makes it without
// the photo on every brand (X-Photo-Omitted).
//
// Modal panel uses a LITERAL solid background (CLAUDE.md rule).

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { IconX, IconArrow } from '../primitives';
import { apiErrorCode, apiErrorDetails, apiErrorReason } from '../../../lib/api/contracts/wire';
import { FILE_NAME_STYLES, downloadResumeExport, type FileNameStyle } from '../../../lib/api/resumes';
import { placeholderLinesOfMarkdown } from '../../../lib/resumeAnalyzer';
import { WechatBrowserBanner } from '../../features/auth-cn';
import { AiGeneratedBadge } from '../../features/market';
import styles from '../../features/resume/ResumeHub.module.css';
import { resumePlainText } from './plainText';

type Format = 'pdf' | 'docx' | 'txt' | 'md';

/** Lines listed in the placeholder warning (the rest are counted). */
const MAX_PLACEHOLDER_LINES = 3;

/**
 * How many inserted details block this download, or null when the failure is
 * something else. Read from where the server puts it (INT-10 audit):
 *   - the export route answers 409 `{ error, code: 'unverified_claims',
 *     details: { count } }` — the reason is in `code`;
 *   - the tailor-session routes answer `code: 'unverified_claims'` with
 *     `details: { pending }`;
 *   - a platform-envelope answer would carry `code: 'conflict'` with
 *     `details.reason: 'unverified_claims'`.
 * All three block the same way. A count that is missing or not a positive
 * number is shown as 1 (something is unverified; we do not invent how many).
 */
export function unverifiedClaimsOf(err: unknown): number | null {
  if (apiErrorCode(err) !== 'unverified_claims' && apiErrorReason(err) !== 'unverified_claims') return null;
  const details = apiErrorDetails<{ count?: unknown; pending?: unknown }>(err);
  const n = Number(details?.count ?? details?.pending);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

interface Props {
  resumeId: string;
  resumeName: string;
  resumeMarkdown: string;
  /** Inserted details still to verify (>0 blocks every format). */
  unverifiedClaims?: number;
  /** Where "Verify details" opens for this version (`/resume?tailorSession=<id>`), when known. */
  verifyHref?: string | null;
  /**
   * Lines that still carry a blank like "[X]". Left out, they are read from
   * `resumeMarkdown` (lib/resumeAnalyzer placeholderLinesOfMarkdown).
   */
  placeholderLines?: readonly string[];
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
  verifyHref = null,
  placeholderLines: givenPlaceholderLines,
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
  // Blanks an AI suggestion left for the user: nothing downloads until they
  // are filled in, or the user ticks "download with the blanks".
  const [withBlanks, setWithBlanks] = useState(false);
  const placeholderLines = useMemo(
    () => givenPlaceholderLines ?? placeholderLinesOfMarkdown(resumeMarkdown),
    [givenPlaceholderLines, resumeMarkdown],
  );
  const hasBlanks = placeholderLines.length > 0;
  const held = blocked || (hasBlanks && !withBlanks);

  async function handle(format: Format) {
    if (busy || held) return;
    // Server-rendered exports of the actual resume (not a print of the editor).
    if (format === 'pdf' || format === 'docx') {
      setBusy(format);
      setError(false);
      try {
        await downloadResumeExport(resumeId, { format, nameStyle, trackerEntryId, ...(photo ? { photo } : {}) }, resumeName);
        onClose();
      } catch (err) {
        const unverified = unverifiedClaimsOf(err);
        if (unverified !== null) setBlockedCount(unverified);
        else setError(true);
      } finally {
        setBusy(null);
      }
      return;
    }
    // TXT / MD — client-side file of the current text. Plain text carries no
    // markdown syntax (it is for pasting into web forms).
    if (typeof window !== 'undefined') {
      const blob = new Blob([format === 'md' ? resumeMarkdown : resumePlainText(resumeMarkdown)], {
        type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
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
            <div className={styles.blocked} role="alert" data-block="unverified">
              <p style={{ margin: 0 }}>{t('export.unverified', { count: blockedCount })}</p>
              {verifyHref ? (
                <a className={styles.blockedLink} href={verifyHref}>
                  {t('export.verify_cta')}
                </a>
              ) : null}
            </div>
          ) : null}

          {hasBlanks ? (
            <div className={styles.blocked} role="alert" data-block="placeholders">
              <p style={{ margin: 0 }}>{t('export.placeholders', { count: placeholderLines.length })}</p>
              <ul className={styles.blockedList}>
                {placeholderLines.slice(0, MAX_PLACEHOLDER_LINES).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <label className={styles.blockedCheck}>
                <input type="checkbox" checked={withBlanks} onChange={(e) => setWithBlanks(e.target.checked)} />
                <span>{t('export.placeholders_anyway')}</span>
              </label>
            </div>
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
            const off = busy !== null || held;
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
