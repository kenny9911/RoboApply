'use client';

// ImportModal — the library's create flow (.rb-modal / .rb-modal-card). Source:
// RoboApply_V3/resume.jsx ImportModal. Three sources × three stages:
//
//   source  ∈ 'scratch' | 'file' | 'linkedin'
//   stage   ∈ 'input'   | 'parsing' | 'done'
//
//   • input   — scratch: pick a template · file: drop zone · linkedin: the user's own PDF export (no URL import, TASK_PLAN.md H9)
//   • parsing — the real `onCreate` request is running. For a file there is
//               one pending row ("Reading <file>…") and nothing else: no step
//               is ticked before the server has answered (D3 — the rows used
//               to tick "Experience ✓ Roles · titles · dates" on a timer
//               whatever the file held). A new draft from a template shows
//               what the template is while it is created.
//   • done    — success check, and for a file what was ACTUALLY read
//               (`doneFacts`, built by the page from the saved resume);
//               "Open editor" hands the created variant to the page
//
// The actual resume creation is the parent's `onCreate(source, ctx)` async fn
// (it owns the `useCreateResumeMutation` hook + the localized default name). We
// advance to `done` only once the create promise resolved (and, for a draft,
// the template rows were shown) — so a create failure surfaces as an error,
// never a fake success. On "Open editor" the page routes to `/resumes/[id]`
// (Lane F).
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
}

/** Accepted résumé upload types (mirrors the backend accepted-MIME list —
 *  RTF and Apple Pages are NOT read server-side, so they are not offered). */
const ACCEPT_RESUME = '.pdf,.doc,.docx,.txt,.md,application/pdf';

/** The same list as the user reads it (file-type names, not copy). */
export const RESUME_UPLOAD_FORMATS = ['PDF', 'DOC', 'DOCX', 'TXT', 'MD'] as const;

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
  /** False for something the file did not have (shown without a tick). */
  found?: boolean;
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
  checkResumes: string;
  error: string;
  // demo file (stub) — the prototype hardcodes a sample upload
  demoFileName: string;
  demoFileSize: string;
}

interface Props {
  source: ImportSource;
  labels: Labels;
  /** Localized failure copy keyed by backend error code (invalid_url,
   *  fetch_failed, parse_failed, …). Falls back to `labels.error` when a code
   *  is unmapped or absent. */
  errorMessages?: Record<string, string>;
  /** Codes that mean the response was lost in transit rather than that the
   *  create failed — the résumé may well have been saved. For these the modal
   *  offers `onCheckList` instead of the start button, because pressing "read
   *  this file" again is what mints the duplicate. */
  lostResponseCodes?: readonly string[];
  /** Recovery for a lost-response failure: refetch the library list so the user
   *  can see whether the résumé actually landed. */
  onCheckList?: () => void;
  /** What a new draft from a template is made of (shown while it is created). Not used for files. */
  ingestRows: (source: ImportSource, ctx: ImportCreateContext) => IngestItem[];
  /** The pending line while a file is being read ("Reading resume.pdf…"). */
  readingLabel?: (fileName: string) => string;
  /** What was actually read from an uploaded file, from the saved resume (shown when done). */
  doneFacts?: (variant: RAResumeVariant) => IngestItem[];
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
  errorMessages,
  lostResponseCodes,
  onCheckList,
  ingestRows,
  readingLabel,
  doneFacts,
  onCreate,
  onClose,
  onDone,
}: Props) {
  const [stage, setStage] = useState<Stage>('input');
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
    (source === 'linkedin' && !!file);

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
    };

    // A file: nothing is revealed until the server has read it (D3). A draft
    // from a template: what the template is, while it is created.
    const items = source === 'scratch' ? ingestRows(source, ctx) : [];
    setParsed([]);
    let animDone = items.length === 0;
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
    if (items.length > 0) {
      timers.current.push(
        setTimeout(
          () => {
            animDone = true;
            tryFinish();
          },
          350 + items.length * 350 + 400,
        ),
      );
    }

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
  }, [source, templateKey, file, realFile, ingestRows, onCreate]);

  // Resolve the failure message: specific per-code copy when we have it, else
  // the generic label.
  const errorText =
    (errorCode && errorMessages?.[errorCode]) || labels.error;

  // A lost response is not a failed create — we cannot tell from here whether
  // the résumé saved, so the recovery is "go look", not "try again".
  const lostResponse =
    !!errorCode && !!onCheckList && !!lostResponseCodes?.includes(errorCode);

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
                    color: 'var(--text-muted)',
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
                    {/* Only the types the server reads. */}
                    <div className="formats">
                      {RESUME_UPLOAD_FORMATS.map((f, i) => (
                        <span key={f}>
                          {i > 0 ? ' · ' : ''}
                          <span>{f}</span>
                        </span>
                      ))}
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
                          fontSize: 'var(--fs-meta)',
                          color: 'var(--text-2)',
                          marginTop: 4,
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
                            fontSize: 'var(--fs-meta)',
                            color: 'var(--text-2)',
                            marginTop: 4,
                          }}
                        >
                          {file.size} · {labels.linkedinReady}
                        </div>
                      </div>
                    </div>
                  )}
                </button>

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
              <div className="ingest-row pending" role="status" aria-live="polite">
                <div className="ic">
                  <div className="spinner" />
                </div>
                <div>{source !== 'scratch' && file && readingLabel ? readingLabel(file.name) : labels.working}</div>
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
            {/* What the saved resume really holds (never a fixed list). */}
            {source !== 'scratch' && created && doneFacts ? (
              <div className="ingest" style={{ textAlign: 'left', marginTop: 16 }} data-testid="import-facts">
                {doneFacts(created).map((it, i) => (
                  <div key={i} className={`ingest-row${it.found === false ? ' pending' : ''}`} data-found={it.found === false ? 'false' : 'true'}>
                    <div className="ic">{it.found === false ? <span aria-hidden="true">–</span> : <IconCheck size={12} strokeWidthValue={3.5} />}</div>
                    <div>{it.k}</div>
                    <div className="extracted">{it.v}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}

        <div className="rb-modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            {labels.cancel}
          </button>
          {stage === 'input' && lostResponse && (
            <button type="button" className="btn primary" onClick={onCheckList}>
              {labels.checkResumes} <IconArrow size={14} />
            </button>
          )}
          {stage === 'input' && !lostResponse && (
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
