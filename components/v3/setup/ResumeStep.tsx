'use client';

// ResumeStep — step 1 of 2. "Add your resume."
//
// The one mandatory input in the product: with no parsed resume the scorer has
// nothing to compare a job against, so the feed is the whole corpus in posting
// order and every later screen is decoration. Four doors, all visible at once,
// because the reason a first-run user stalls here is never that they refused —
// it is that the one door on screen is the one they cannot use right now.
//
//   1. Drop / browse a file  — a REAL drop target. The component this replaces
//      was a <label> wrapping an <input>: the copy said "Drop your resume here"
//      and dropping did nothing at all, which is a lie told at the exact moment
//      the user is deciding whether this product works.
//   2. Paste the text        — routed through the UPLOAD path, see PASTE below.
//   3. Import from LinkedIn  — deployment-gated, as today.
//   4. Use a resume you already have — rendered only when the account has one,
//      so it never appears on a genuine first run.
//
// ─── PASTE (this is not an implementation detail) ─────────────────────────
//
// Pasting used to call `POST /v2/resumes`, which writes `resumeMarkdown` and a
// content hash and NOTHING else: no `parsedData`, no summary, `parseStatus`
// null. The deterministic seed reads `parsedData`, so every user who pasted
// would have reached step 2 with an empty screen — the one state the confirm
// design says must not exist. So paste wraps the text as a text/plain File and
// posts it to `POST /v2/resumes/upload` instead; `detectFormat` accepts txt and
// the full parse runs. One path in, one parse, one seed.
//
// ─── NOBODY IS TRAPPED ────────────────────────────────────────────────────
//
// The panel renders in the page slot INSIDE the authenticated shell, so the
// Topbar, sidebar, avatar menu, sign out and settings are all still one tap
// away behind it — and this step carries its own close control. Step 1 has no
// "skip", because there is no honest skip to design when the alternative is an
// unranked corpus; it has an exit, which is a different promise.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { IconCheck, IconUpload, IconX } from '../primitives/Iconset';
import {
  useImportLinkedInMutation,
  useLinkedInImportConfig,
  useResumeList,
  useUploadResumeMutation,
} from '../../../hooks/useResumes';
import { resumeErrorKey } from '../../../hooks/useSetup';

/** In lockstep with the backend truth set (`DocumentParsingService`). RTF is
 *  NOT supported server-side, so it is not offered here. */
export const ACCEPT_RESUME = '.pdf,.doc,.docx,.txt,.md,application/pdf';

/** `MAX_RESUME_UPLOAD_BYTES` — server/src/roboapply/v2/routes/resumes.ts.
 *  Checked here too so a 40 MB scan fails in zero seconds instead of after a
 *  long upload the user watched. */
export const MAX_RESUME_BYTES = 15 * 1024 * 1024;

const ACCEPTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt', '.md'];

/** `.btn` is 8px of vertical padding around 13px text — about 34px tall, under
 *  the 44×44 tap-target floor. It is an inline-flex box with centred content
 *  already, so a `minHeight` is the whole fix. Applied here rather than in
 *  styles/v3.css because this panel is what the ruling is about; the shared
 *  class is used by desktop-first surfaces too. */
const BTN_TOUCH: React.CSSProperties = { minHeight: 'var(--control-lg)' };

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Wrap pasted text as an uploadable file. Exported for the unit test — the
 * whole point of this step is that paste and upload converge on ONE parse, and
 * a regression here is invisible until step 2 renders empty.
 */
export function pastedTextToFile(text: string): File {
  return new File([text], 'pasted-resume.txt', { type: 'text/plain' });
}

interface Props {
  /** A parseable variant exists — the panel bootstraps against it. */
  onReady: (resumeVariantId: string) => void;
  /** Bootstrap is in flight; the doors lock but the step stays on screen. */
  busy?: boolean;
  /** A bootstrap-level failure, as a `jobs.setup.*` key. */
  errorKey?: string | null;
  /** Close the panel. Present so the user is never trapped. */
  onClose: () => void;
}

export function ResumeStep({ onReady, busy = false, errorKey, onClose }: Props) {
  const t = useTranslations('jobs.setup');
  const locale = useLocale();

  const resumeList = useResumeList();
  const linkedinConfig = useLinkedInImportConfig();
  const uploadResume = useUploadResumeMutation();
  const importLinkedIn = useImportLinkedInMutation();

  const variants = resumeList.data?.resumes ?? [];

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);
  // dragenter/dragleave fire for every child element the pointer crosses, so a
  // boolean flickers the highlight off the moment the cursor passes over the
  // icon. Count entries instead and clear at zero.
  const dragDepth = useRef(0);

  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<{ name: string; size: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [linkedinOpen, setLinkedinOpen] = useState(false);
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [localErrorKey, setLocalErrorKey] = useState<string | null>(null);

  const pending =
    busy || uploadResume.isPending || importLinkedIn.isPending;

  // `empty_text` means a scanned PDF: there is no text in the document at all.
  // The recovery is not "try again" — the same file fails the same way — it is
  // pasting, so the textarea opens underneath the message on its own.
  useEffect(() => {
    if (localErrorKey === 'error_empty_text') setPasteOpen(true);
  }, [localErrorKey]);

  // Focus lands in a SEPARATE effect, and that is the whole point: calling
  // `pasteRef.current.focus()` in the same tick as `setPasteOpen(true)` focuses
  // a textarea that React has not mounted yet, so it silently did nothing —
  // both from the scanned-PDF path above and from the button below. Opening a
  // field the user is then told to type in, without putting the caret in it,
  // is a recovery that only works with a mouse.
  useEffect(() => {
    if (pasteOpen) pasteRef.current?.focus();
  }, [pasteOpen]);

  async function acceptFile(file: File | null) {
    if (!file || pending) return;
    setLocalErrorKey(null);

    // Both guards below name the real problem before any bytes move.
    if (!hasAcceptedExtension(file.name)) {
      setPicked(null);
      setLocalErrorKey('error_unsupported_format');
      return;
    }
    if (file.size > MAX_RESUME_BYTES) {
      setPicked(null);
      setLocalErrorKey('error_file_too_large');
      return;
    }

    setPicked({ name: file.name, size: humanSize(file.size) });
    try {
      const created = await uploadResume.mutateAsync({ file });
      onReady(created.id);
    } catch (err) {
      setPicked(null);
      setLocalErrorKey(resumeErrorKey(err));
    }
  }

  async function submitPaste() {
    const text = pasteText.trim();
    if (!text || pending) return;
    setLocalErrorKey(null);
    // A markdown H1 is the most common first line of a pasted resume and it is
    // almost always the person's name — a better variant name than "Pasted
    // resume", and free.
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    try {
      const created = await uploadResume.mutateAsync({
        file: pastedTextToFile(text),
        name: heading || t('resume_paste_name'),
      });
      onReady(created.id);
    } catch (err) {
      setLocalErrorKey(resumeErrorKey(err));
    }
  }

  async function submitLinkedIn() {
    const url = linkedinUrl.trim();
    if (!url || pending) return;
    setLocalErrorKey(null);
    try {
      const created = await importLinkedIn.mutateAsync({
        mode: 'url',
        linkedinUrl: url,
      });
      onReady(created.id);
    } catch (err) {
      setLocalErrorKey(resumeErrorKey(err));
    }
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
  }
  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    void acceptFile(e.dataTransfer?.files?.[0] ?? null);
  }

  const shownErrorKey = localErrorKey ?? errorKey ?? null;
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <div>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 'var(--sp-3)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* `data-setup-heading` + tabIndex -1: SetupPanel moves focus here on
           *  open and on every step change, which is what announces the step to
           *  a screen reader and stops focus falling to <body> when the card
           *  swaps in place. */}
          <h2
            data-setup-heading
            tabIndex={-1}
            style={{
              outline: 'none',
              fontSize: 'var(--fs-title)',
              fontWeight: 600,
              letterSpacing: 'var(--ls-title)',
              lineHeight: 'var(--lh-title)',
              margin: '0 0 var(--sp-2)',
              color: 'var(--text)',
            }}
          >
            {t('resume_title')}
          </h2>
          <p
            style={{
              fontSize: 'var(--fs-body)',
              color: 'var(--text-2)',
              lineHeight: 'var(--lh-body)',
              margin: 0,
            }}
          >
            {t('resume_lead')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          style={{
            display: 'grid',
            placeItems: 'center',
            // 44, not 32: this is the exit on the first screen of the product,
            // reached with a thumb (ruling: minimum 44×44 tap target).
            width: 'var(--control-lg)',
            height: 'var(--control-lg)',
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--rule)',
            background: 'var(--surface)',
            color: 'var(--text-2)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <IconX size={16} strokeWidthValue={2.2} />
        </button>
      </header>

      {/* ── Door 1: the drop zone. A div, not a label, because a label cannot
       *     carry drag handlers without swallowing the drop on its input. ── */}
      <div
        className={`upload-zone ${picked ? 'has-file' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={t('resume_drop')}
        aria-disabled={pending}
        onClick={() => !pending && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!pending) fileInputRef.current?.click();
          }
        }}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          textAlign: 'center',
          borderColor: dragging ? 'var(--action)' : undefined,
          background: dragging ? 'var(--action-subtle)' : undefined,
        }}
      >
        {/* Visually hidden, but `.sr-only` is a clip — not `display:none` —
         *  so it stays focusable AND stays in the tab order. A keyboard user
         *  therefore hit an invisible second tab stop immediately after the
         *  drop zone and could not see where focus had gone. The zone above is
         *  the labelled activator; the input is plumbing.
         *  `display:none` is NOT the fix: iOS Safari refuses to open the
         *  picker for a display:none input, which would delete the browse door
         *  on the platform this screen is designed for. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_RESUME}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void acceptFile(e.target.files?.[0] ?? null);
            // Reset so re-picking the SAME file after a parse failure still
            // fires a change event.
            e.target.value = '';
          }}
        />
        {picked ? (
          <div className="check-row">
            <div className="check">
              {pending ? (
                <span className="spinner" />
              ) : (
                <IconCheck size={20} strokeWidthValue={3} />
              )}
            </div>
            <div style={{ textAlign: 'left' }}>
              <div className="file">{picked.name}</div>
              <div
                style={{
                  fontSize: 'var(--fs-meta)',
                  color: 'var(--text-2)',
                  marginTop: 'var(--sp-1)',
                }}
              >
                {t('resume_received', { name: picked.name, size: picked.size })}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="ic">
              <IconUpload size={22} strokeWidthValue={2.2} />
            </div>
            <h3>{t('resume_drop')}</h3>
            <div className="formats">{t('resume_formats')}</div>
          </>
        )}
      </div>

      {/* The accepted-file line lives INSIDE role="button", whose children are
       *  presentational — so the one confirmation that anything happened was
       *  never announced. Same string, said out loud, once. */}
      <p role="status" className="sr-only">
        {picked ? t('resume_received', { name: picked.name, size: picked.size }) : ''}
      </p>

      {shownErrorKey ? (
        <div role="alert" style={{ marginTop: 'var(--sp-3)' }}>
          <p
            style={{
              margin: 0,
              color: 'var(--warn)',
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
            }}
          >
            {t(shownErrorKey)}
          </p>
          <div
            style={{
              display: 'flex',
              gap: 'var(--sp-2)',
              flexWrap: 'wrap',
              marginTop: 'var(--sp-2)',
            }}
          >
            {shownErrorKey === 'error_empty_text' ? (
              <button
                type="button"
                className="btn ghost"
                style={BTN_TOUCH}
                onClick={() => setPasteOpen(true)}
              >
                {t('error_empty_action')}
              </button>
            ) : (
              <button
                type="button"
                className="btn ghost"
                style={BTN_TOUCH}
                onClick={() => {
                  setLocalErrorKey(null);
                  fileInputRef.current?.click();
                }}
              >
                {t('error_retry')}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {/* ── The other three doors ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          margin: 'var(--sp-4) 0 var(--sp-3)',
        }}
      >
        <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
        <span
          style={{
            fontSize: 'var(--fs-label)',
            color: 'var(--text-muted)',
            fontWeight: 500,
          }}
        >
          {t('resume_or')}
        </span>
        <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
      </div>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn ghost"
          style={BTN_TOUCH}
          aria-expanded={pasteOpen}
          onClick={() => setPasteOpen((v) => !v)}
          disabled={pending}
        >
          {t('resume_paste')}
        </button>
        {linkedinConfig.data?.urlImportEnabled ? (
          <button
            type="button"
            className="btn ghost"
            style={BTN_TOUCH}
            aria-expanded={linkedinOpen}
            onClick={() => setLinkedinOpen((v) => !v)}
            disabled={pending}
          >
            {t('resume_linkedin')}
          </button>
        ) : null}
      </div>

      {pasteOpen ? (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <textarea
            ref={pasteRef}
            className="intent-input"
            style={{ minHeight: 180, fontSize: 'var(--fs-body)' }}
            value={pasteText}
            placeholder={t('resume_paste_placeholder')}
            aria-label={t('resume_paste')}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button
            type="button"
            className="btn primary"
            style={{ ...BTN_TOUCH, marginTop: 'var(--sp-2)' }}
            disabled={!pasteText.trim() || pending}
            onClick={() => void submitPaste()}
          >
            {t('resume_paste_submit')}
          </button>
        </div>
      ) : null}

      {linkedinOpen && linkedinConfig.data?.urlImportEnabled ? (
        <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
          <input
            type="url"
            value={linkedinUrl}
            placeholder={t('resume_linkedin_placeholder')}
            aria-label={t('resume_linkedin')}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: '1px solid var(--rule)',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface)',
              color: 'var(--text)',
              padding: 'var(--sp-2) var(--sp-3)',
              fontFamily: 'inherit',
              fontSize: 'var(--fs-meta)',
              fontWeight: 400,
              minHeight: 'var(--control-lg)',
            }}
          />
          <button
            type="button"
            className="btn ghost"
            style={BTN_TOUCH}
            disabled={!linkedinUrl.trim() || pending}
            onClick={() => void submitLinkedIn()}
          >
            {t('resume_linkedin')}
          </button>
        </div>
      ) : null}

      {/* ── Door 4: never rendered on a genuine first run. ── */}
      {variants.length > 0 ? (
        <section style={{ marginTop: 'var(--sp-5)' }}>
          <h3
            style={{
              fontSize: 'var(--fs-body)',
              fontWeight: 600,
              color: 'var(--text)',
              margin: '0 0 var(--sp-2)',
            }}
          >
            {t('resume_pick_existing')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            {variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                disabled={pending}
                onClick={() => onReady(variant.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-3)',
                  padding: 'var(--sp-3) var(--sp-4)',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid var(--rule)',
                  background: 'var(--surface-2)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--fs-body)',
                      fontWeight: 600,
                      color: 'var(--text)',
                    }}
                  >
                    {variant.name}
                    {variant.isPrimary ? (
                      <span
                        style={{
                          marginLeft: 'var(--sp-2)',
                          fontSize: 'var(--fs-label)',
                          fontWeight: 500,
                          color: 'var(--action)',
                        }}
                      >
                        {t('resume_primary_badge')}
                      </span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: 'var(--fs-label)',
                      color: 'var(--text-2)',
                      marginTop: 'var(--sp-1)',
                    }}
                  >
                    {t('resume_last_edited', {
                      date: dateFormatter.format(new Date(variant.lastEditedAt)),
                    })}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <p
        style={{
          marginTop: 'var(--sp-4)',
          marginBottom: 0,
          fontSize: 'var(--fs-label)',
          color: 'var(--text-muted)',
          lineHeight: 'var(--lh-meta)',
        }}
      >
        {t('resume_privacy')}
      </p>
    </div>
  );
}
