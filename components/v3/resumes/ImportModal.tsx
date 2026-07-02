'use client';

// ImportModal — the library's create flow (.rb-modal / .rb-modal-card). Source:
// RoboApply_V3/resume.jsx ImportModal. Three sources × three stages:
//
//   source  ∈ 'scratch' | 'file' | 'linkedin'
//   stage   ∈ 'input'   | 'parsing' | 'done'
//
//   • input   — scratch: pick a template · file: drop zone · linkedin: URL field
//   • parsing — animated "what I picked up" ingest rows (cosmetic) WHILE the real
//               `onCreate` mutation runs in the background
//   • done    — success check; "Open editor" hands the created variant to the page
//
// The actual resume creation is the parent's `onCreate(source, ctx)` async fn
// (it owns the `useCreateResumeMutation` hook + the localized default name). We
// advance to `done` only once BOTH the ingest animation finished AND the create
// promise resolved — so a create failure surfaces as an error, never a fake
// success. On "Open editor" the page routes to `/resumes/[id]` (Lane F).
//
// SOLID PANEL per the CLAUDE.md modal rule: `.rb-modal-card` already paints
// `var(--bg)` (a :root literal in V3, so it can't bleed through), and we pin a
// literal `#0A0B10` inline as defense-in-depth at the call site.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RAResumeVariant } from '../../../lib/api/v2/types';
import { IconBolt, IconArrow, IconCheck, IconUpload, IconX } from '../primitives';

export type ImportSource = 'scratch' | 'file' | 'linkedin';

/** Context the page needs to build the create body. */
export interface ImportCreateContext {
  source: ImportSource;
  /** chosen template key (scratch) */
  templateKey: string;
  /** uploaded file name (file) — display label */
  fileName: string | null;
  /** the real uploaded File (file source) — sent to the upload endpoint */
  file: File | null;
  /** pasted LinkedIn URL (linkedin) — display only in the stub */
  linkedinUrl: string;
}

/** Accepted résumé upload types (mirrors the backend accepted-MIME list —
 *  RTF is NOT supported server-side, so it is intentionally excluded). */
const ACCEPT_RESUME = '.pdf,.doc,.docx,.txt,.md,application/pdf';

/** LinkedIn "Save to PDF" produces a PDF — steer the picker to it. */
const ACCEPT_LINKEDIN = '.pdf,application/pdf';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pull the backend error code off a thrown API error so we can show a specific
 *  message. RoboApiError normalizes its `.code` (e.g. a 422 → 'unknown'), so the
 *  raw backend code (`invalid_url`, `parse_failed`, …) lives on `.payload.code`;
 *  fall back to a non-normalized `.code` for other throwers. */
function readApiErrorCode(err: unknown): string | null {
  const e = err as { payload?: { code?: unknown }; code?: unknown } | null;
  const fromPayload = e?.payload?.code;
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
  if (typeof e?.code === 'string' && e.code && e.code !== 'unknown') return e.code;
  return null;
}

interface IngestItem {
  k: string;
  v: string;
}

interface Labels {
  titleScratch: string;
  titleFile: string;
  titleLinkedin: string;
  badgeScratch: string;
  badgeFile: string;
  badgeLinkedin: string;
  // scratch templates
  templateClassic: string;
  templateModern: string;
  templateEditorial: string;
  scratchHint: string;
  // file drop
  dropTitle: string;
  dropSub: string;
  fileReady: string;
  // linkedin — guided "Save to PDF" upload (+ optional URL path)
  linkedinStepsTitle: string;
  linkedinStep1: string;
  linkedinStep2: string;
  linkedinStep3: string;
  linkedinUploadTitle: string;
  linkedinUploadSub: string;
  linkedinReady: string;
  linkedinOr: string;
  linkedinUrlLabel: string;
  linkedinPlaceholder: string;
  linkedinHint: string;
  // ingest
  ingestTitleScratch: string;
  ingestTitleParse: string;
  working: string;
  // done
  doneTitleScratch: string;
  doneTitleImport: string;
  doneBodyScratch: string;
  doneBodyImport: string;
  // footer
  cancel: string;
  createDraft: string;
  parseWithAi: string;
  openEditor: string;
  error: string;
  // demo file (stub) — the prototype hardcodes a sample upload
  demoFileName: string;
  demoFileSize: string;
}

interface Props {
  source: ImportSource;
  labels: Labels;
  /** Whether the optional LinkedIn URL-import path is available on this
   *  deployment. When false (the default), only the PDF-export uploader shows. */
  linkedinUrlEnabled?: boolean;
  /** Localized failure copy keyed by backend error code (invalid_url,
   *  fetch_failed, parse_failed, …). Falls back to `labels.error` when a code
   *  is unmapped or absent. */
  errorMessages?: Record<string, string>;
  /** Per-source ingest rows shown during the parsing animation. */
  ingestRows: (source: ImportSource, ctx: ImportCreateContext) => IngestItem[];
  /** Creates the variant for real; resolves with the new variant. */
  onCreate: (ctx: ImportCreateContext) => Promise<RAResumeVariant>;
  onClose: () => void;
  /** Fired on "Open editor" with the created variant (page routes to it). */
  onDone: (variant: RAResumeVariant) => void;
}

type Stage = 'input' | 'parsing' | 'done';

const TEMPLATES: { key: string; lblKey: keyof Labels }[] = [
  { key: 'classic-ats', lblKey: 'templateClassic' },
  { key: 'modern-two-col', lblKey: 'templateModern' },
  { key: 'editorial-serif', lblKey: 'templateEditorial' },
];

export function ImportModal({
  source,
  labels,
  linkedinUrlEnabled = false,
  errorMessages,
  ingestRows,
  onCreate,
  onClose,
  onDone,
}: Props) {
  const [stage, setStage] = useState<Stage>('input');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<{ name: string; size: string } | null>(null);
  const [realFile, setRealFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [templateKey, setTemplateKey] = useState(TEMPLATES[0].key);
  const [parsed, setParsed] = useState<IngestItem[]>([]);
  const [created, setCreated] = useState<RAResumeVariant | null>(null);
  const [error, setError] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Guard against state writes after the modal unmounts mid-animation.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const list = timers.current;
    return () => {
      list.forEach((id) => clearTimeout(id));
    };
  }, []);

  const title =
    source === 'scratch'
      ? labels.titleScratch
      : source === 'file'
        ? labels.titleFile
        : labels.titleLinkedin;
  const badge =
    source === 'scratch'
      ? labels.badgeScratch
      : source === 'file'
        ? labels.badgeFile
        : labels.badgeLinkedin;

  const canStart =
    source === 'scratch' ||
    (source === 'file' && !!file) ||
    (source === 'linkedin' &&
      (!!file || (linkedinUrlEnabled && url.trim().length > 8)));

  // ESC closes (mirror the V3 Modal primitive) + lock scroll while open.
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );
  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    document.documentElement.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.documentElement.style.overflow = '';
    };
  }, [handleKey]);

  const start = useCallback(() => {
    setError(false);
    setErrorCode(null);
    setStage('parsing');

    const ctx: ImportCreateContext = {
      source,
      templateKey,
      fileName: file?.name ?? null,
      file: realFile,
      linkedinUrl: url.trim(),
    };

    // Cosmetic ingest reveal.
    const items = ingestRows(source, ctx);
    setParsed([]);
    let animDone = false;
    let createResult: RAResumeVariant | null = null;
    let createFailed = false;
    let createErrorCode: string | null = null;

    const tryFinish = () => {
      if (!animDone) return;
      if (createFailed) {
        setError(true);
        setErrorCode(createErrorCode);
        setStage('input');
        return;
      }
      if (createResult) {
        setCreated(createResult);
        setStage('done');
      }
    };

    items.forEach((it, i) => {
      timers.current.push(
        setTimeout(() => setParsed((cur) => [...cur, it]), 350 + i * 350),
      );
    });
    timers.current.push(
      setTimeout(
        () => {
          animDone = true;
          tryFinish();
        },
        350 + items.length * 350 + 400,
      ),
    );

    // Real create runs in parallel with the animation.
    onCreate(ctx)
      .then((variant) => {
        createResult = variant;
        tryFinish();
      })
      .catch((err) => {
        createFailed = true;
        createErrorCode = readApiErrorCode(err);
        tryFinish();
      });
  }, [source, templateKey, file, realFile, url, ingestRows, onCreate]);

  // Resolve the failure message: specific per-code copy when we have it, else
  // the generic label.
  const errorText =
    (errorCode && errorMessages?.[errorCode]) || labels.error;

  return (
    <div className="rb-modal" onClick={onClose}>
      <div
        className="rb-modal-card"
        // Defense-in-depth literal solid bg (CLAUDE.md modal rule).
        style={{ background: 'var(--surface)' }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rb-modal-head">
          <div>
            <div className="iv-step-num" style={{ display: 'inline-block', marginBottom: 8 }}>
              {badge}
            </div>
            <h2 className="rb-modal-title">{title}</h2>
          </div>
          <button type="button" className="iv-coach-close" onClick={onClose} aria-label={labels.cancel}>
            <IconX size={16} />
          </button>
        </div>

        {stage === 'input' && (
          <div className="rb-modal-body">
            {source === 'scratch' && (
              <div>
                <div className="rb-scratch-templates">
                  {TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.key}
                      type="button"
                      className={`rb-template${templateKey === tpl.key ? ' active' : ''}`}
                      onClick={() => setTemplateKey(tpl.key)}
                    >
                      <div className="rb-template-thumb">
                        <div
                          className="rb-mini"
                          style={{ transform: 'scale(0.8)', transformOrigin: 'top center' }}
                          aria-hidden="true"
                        >
                          <div className="rb-mini-name">Aa</div>
                          <div className="rb-mini-line" style={{ width: '60%' }} />
                          <div className="rb-mini-spacer" />
                          <div className="rb-mini-line" style={{ width: '90%' }} />
                          <div className="rb-mini-line" style={{ width: '80%' }} />
                          <div className="rb-mini-line" style={{ width: '70%' }} />
                        </div>
                      </div>
                      <div className="rb-template-lbl">{labels[tpl.lblKey]}</div>
                    </button>
                  ))}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--muted)',
                    marginTop: 14,
                    textAlign: 'center',
                  }}
                >
                  {labels.scratchHint}
                </div>
              </div>
            )}

            {source === 'file' && (
              <button
                type="button"
                className={`upload-zone ${file ? 'has-file' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                style={{ width: '100%', textAlign: 'center' }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_RESUME}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (f) {
                      setRealFile(f);
                      setFile({ name: f.name, size: humanSize(f.size) });
                      setError(false);
                    }
                  }}
                />
                {!file ? (
                  <>
                    <div className="ic">
                      <IconUpload size={22} strokeWidthValue={2.2} />
                    </div>
                    <h3>{labels.dropTitle}</h3>
                    <p>{labels.dropSub}</p>
                    <div className="formats">
                      <span>PDF</span> · <span>DOCX</span> · <span>Pages</span> · <span>RTF</span>
                    </div>
                  </>
                ) : (
                  <div className="check-row">
                    <div className="check">
                      <IconCheck size={20} strokeWidthValue={3} />
                    </div>
                    <div>
                      <div className="file">{file.name}</div>
                      <div
                        style={{
                          fontSize: 12.5,
                          color: 'var(--text-2)',
                          marginTop: 4,
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        {file.size} · {labels.fileReady}
                      </div>
                    </div>
                  </div>
                )}
              </button>
            )}

            {source === 'linkedin' && (
              <>
                {/* How to export the profile as a PDF (the always-available path). */}
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: 'var(--text)',
                      marginBottom: 8,
                    }}
                  >
                    {labels.linkedinStepsTitle}
                  </div>
                  <ol
                    style={{
                      margin: 0,
                      paddingLeft: 18,
                      fontSize: 12.5,
                      color: 'var(--text-2)',
                      lineHeight: 1.7,
                    }}
                  >
                    <li>{labels.linkedinStep1}</li>
                    <li>{labels.linkedinStep2}</li>
                    <li>{labels.linkedinStep3}</li>
                  </ol>
                </div>

                {/* LinkedIn PDF drop zone — shares realFile/file state with the
                    file source; only one source renders per modal instance. */}
                <button
                  type="button"
                  className={`upload-zone ${file ? 'has-file' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ width: '100%', textAlign: 'center' }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPT_LINKEDIN}
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      if (f) {
                        setRealFile(f);
                        setFile({ name: f.name, size: humanSize(f.size) });
                        setUrl(''); // a picked PDF takes precedence over a URL
                        setError(false);
                      }
                    }}
                  />
                  {!file ? (
                    <>
                      <div className="ic">
                        <IconUpload size={22} strokeWidthValue={2.2} />
                      </div>
                      <h3>{labels.linkedinUploadTitle}</h3>
                      <p>{labels.linkedinUploadSub}</p>
                      <div className="formats">
                        <span>PDF</span>
                      </div>
                    </>
                  ) : (
                    <div className="check-row">
                      <div className="check">
                        <IconCheck size={20} strokeWidthValue={3} />
                      </div>
                      <div>
                        <div className="file">{file.name}</div>
                        <div
                          style={{
                            fontSize: 12.5,
                            color: 'var(--text-2)',
                            marginTop: 4,
                            fontFamily: 'var(--mono)',
                          }}
                        >
                          {file.size} · {labels.linkedinReady}
                        </div>
                      </div>
                    </div>
                  )}
                </button>

                {/* Optional URL path — only when an enrichment provider is set. */}
                {linkedinUrlEnabled && (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        margin: '16px 0 12px',
                        color: 'var(--muted)',
                        fontSize: 12,
                      }}
                    >
                      <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
                      <span>{labels.linkedinOr}</span>
                      <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
                    </div>
                    <div
                      style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}
                    >
                      {labels.linkedinUrlLabel}
                    </div>
                    <div className="rb-input-row">
                      <div className="rb-input-prefix" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20.5 2h-17A1.5 1.5 0 0 0 2 3.5v17A1.5 1.5 0 0 0 3.5 22h17a1.5 1.5 0 0 0 1.5-1.5v-17A1.5 1.5 0 0 0 20.5 2ZM8 19H5V8h3v11Zm-1.5-12.3a1.7 1.7 0 1 1 0-3.5 1.7 1.7 0 0 1 0 3.5ZM19 19h-3v-5.6c0-1.4-.5-2.3-1.8-2.3-1 0-1.5.6-1.8 1.3 0 .2-.1.5-.1.8V19h-3V8h3v1.4c.4-.6 1.1-1.5 2.7-1.5 2 0 3.5 1.3 3.5 4V19Z" />
                        </svg>
                      </div>
                      <input
                        className="rb-input"
                        placeholder={labels.linkedinPlaceholder}
                        value={url}
                        onChange={(e) => {
                          setUrl(e.target.value);
                          if (e.target.value.trim()) {
                            // a typed URL takes precedence over a picked file
                            setRealFile(null);
                            setFile(null);
                          }
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: 'var(--muted)',
                        marginTop: 10,
                        lineHeight: 1.5,
                      }}
                    >
                      {labels.linkedinHint}
                    </div>
                  </>
                )}
              </>
            )}

            {error ? (
              <p style={{ marginTop: 14, fontSize: 13, color: 'var(--warn)' }} role="alert">
                {errorText}
              </p>
            ) : null}
          </div>
        )}

        {stage === 'parsing' && (
          <div className="rb-modal-body">
            <div className="ingest">
              <div className="ingest-title">
                <IconBolt size={11} fill="currentColor" stroke="none" />
                {source === 'scratch' ? labels.ingestTitleScratch : labels.ingestTitleParse}
              </div>
              {parsed.map((it, i) => (
                <div key={i} className="ingest-row" style={{ animation: 'expand 0.25s ease' }}>
                  <div className="ic">
                    <IconCheck size={12} strokeWidthValue={3.5} />
                  </div>
                  <div>{it.k}</div>
                  <div className="extracted">{it.v}</div>
                </div>
              ))}
              <div className="ingest-row pending">
                <div className="ic">
                  <div className="spinner" />
                </div>
                <div>{labels.working}</div>
              </div>
            </div>
          </div>
        )}

        {stage === 'done' && (
          <div className="rb-modal-body" style={{ textAlign: 'center', padding: '30px 20px' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'var(--ok)',
                color: 'var(--bg)',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 16px',
                boxShadow: '0 0 30px rgba(74, 222, 128, 0.4)',
              }}
            >
              <IconCheck size={28} strokeWidthValue={3} />
            </div>
            <h3
              style={{
                fontSize: 22,
                fontWeight: 600,
                margin: '0 0 6px',
                letterSpacing: '-0.02em',
              }}
            >
              {source === 'scratch' ? labels.doneTitleScratch : labels.doneTitleImport}
            </h3>
            <p
              style={{
                fontSize: 13.5,
                color: 'var(--text-2)',
                maxWidth: 360,
                margin: '0 auto 6px',
              }}
            >
              {source === 'scratch' ? labels.doneBodyScratch : labels.doneBodyImport}
            </p>
          </div>
        )}

        <div className="rb-modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {labels.cancel}
          </button>
          {stage === 'input' && (
            <button
              type="button"
              className="btn primary"
              disabled={!canStart}
              style={{ opacity: canStart ? 1 : 0.4, pointerEvents: canStart ? 'auto' : 'none' }}
              onClick={start}
            >
              <IconBolt size={14} fill="currentColor" stroke="none" />
              {source === 'scratch' ? labels.createDraft : labels.parseWithAi}
            </button>
          )}
          {stage === 'done' && created && (
            <button type="button" className="btn primary" onClick={() => onDone(created)}>
              {labels.openEditor} <IconArrow size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
