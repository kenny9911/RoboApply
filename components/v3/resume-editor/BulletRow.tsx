'use client';

// BulletRow — one experience bullet with a hover-revealed inline-AI action
// menu (the 6 actions) and a rewrite panel. Source:
// RoboApply_V3/resume-editor.jsx BulletRow.
//
// Data: `RAResumeVariant.resumeMarkdown` parses to plain bullet strings (no
// `weak` flag in StructuredExperience — see lib/resumeStructure.ts), so we
// derive a conservative client-side "weak" heuristic to flag vague bullets,
// matching the proto's intent. The rewrite itself comes from
// `resumes.rewrite({ mode:'bullet', action })`; Accept writes the new text back.
//
// Editing: the bullet is directly typeable — Markdown display swaps to an
// autosizing textarea on click (empty bullets render the textarea straight
// away so "+ Add bullet" is immediately typeable). Enter adds a bullet below;
// Backspace on an empty bullet removes it. Bullets are single-line in the
// markdown contract (`- text`), so newlines are folded to spaces.
//
// Rewrite output renders through the V3 Markdown primitive (LLM output may
// contain markdown). The bullet display text is plain (parsed markdown body),
// rendered inline through Markdown too so any **bold** in a bullet reads.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Markdown, IconX, IconCheck, IconRefresh } from '../primitives';
import { AI_ACTIONS } from './constants';
import type {
  RAResumeRewriteAction,
  ResumeRewriteBody,
  ResumeRewriteResponse,
} from '../../../lib/api/v2/types';

interface Props {
  text: string;
  /** AI-accept — writes the rewrite back (kept distinct from onChange so the
   *  rewrite panel flow reads unchanged). */
  onAccept: (next: string) => void;
  /** Live typing. */
  onChange: (next: string) => void;
  /** Enter — insert a new bullet below this one. */
  onAddBelow: () => void;
  /** Backspace on empty / the hover ✕ button. `focusPrev` = keyboard path. */
  onRemove: (opts?: { focusPrev?: boolean }) => void;
  /** Hover reorder buttons; undefined = edge (disabled). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Focus this bullet's editor on mount (freshly inserted row). */
  requestFocus?: boolean;
  /** Ack for requestFocus so the page clears its pending-focus token. */
  onFocusHandled?: () => void;
  runRewrite: (body: ResumeRewriteBody) => Promise<ResumeRewriteResponse>;
  /** Optional job context to bias the rewrite. */
  targetJobId?: string | null;
}

/** Conservative weak-bullet heuristic: short bullets that open with a vague
 *  verb and carry no number. Mirrors the proto's hand-flagged `weak: true`. */
function isWeakBullet(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const hasNumber = /\d/.test(t);
  const vagueOpener =
    /^(worked|helped|assisted|responsible|involved|participated|contributed|supported|handled)\b/.test(
      t,
    );
  return vagueOpener && !hasNumber;
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export function BulletRow({
  text,
  onAccept,
  onChange,
  onAddBelow,
  onRemove,
  onMoveUp,
  onMoveDown,
  requestFocus = false,
  onFocusHandled,
  runRewrite,
  targetJobId,
}: Props) {
  const t = useTranslations('resumeEditor');
  const [active, setActive] = useState<RAResumeRewriteAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // One-shot "focus the textarea once it renders" latch — set on
  // click-to-edit and when a focus request lands before the textarea exists.
  const focusWhenRenderedRef = useRef(false);
  // Whether that deferred focus should also ack the page's pending token
  // (only for page-driven focus requests, not local click-to-edit).
  const ackFocusRef = useRef(false);

  // Focus requests target both freshly mounted rows (insert-below) and
  // already-mounted ones (Backspace-remove focuses the previous bullet), so
  // this reacts to the prop rather than reading it once at mount.
  useEffect(() => {
    if (!requestFocus) return;
    setEditing(true);
    const el = taRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      onFocusHandled?.();
    } else {
      focusWhenRenderedRef.current = true;
      ackFocusRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestFocus]);

  const weak = isWeakBullet(text);
  // Empty bullets are always in edit mode — a read-only empty row is untypeable.
  const showEditor = editing || !text.trim();

  async function runAction(actionId: RAResumeRewriteAction) {
    setActive(actionId);
    setBusy(true);
    setDraft(null);
    setError(false);
    try {
      const res = await runRewrite({
        mode: 'bullet',
        action: actionId,
        text,
        targetJobId: targetJobId ?? undefined,
      });
      setDraft(res.rewrite ?? '');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    setDraft(null);
    setActive(null);
    setError(false);
  }

  function beginEdit() {
    focusWhenRenderedRef.current = true;
    setEditing(true);
  }

  function bindTextarea(el: HTMLTextAreaElement | null) {
    taRef.current = el;
    if (!el) return;
    autosize(el);
    if (focusWhenRenderedRef.current) {
      focusWhenRenderedRef.current = false;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      if (ackFocusRef.current) {
        ackFocusRef.current = false;
        onFocusHandled?.();
      }
    }
  }

  const activeLabel = active ? t(`action.${active}.label`) : '';

  return (
    <div className={`rb-bullet ${weak ? 'weak' : ''}`}>
      <div className="rb-bullet-row">
        <span className="rb-bullet-dot">•</span>
        {showEditor ? (
          <textarea
            className="rb-bullet-input"
            rows={1}
            value={text}
            placeholder={t('bullet.placeholder')}
            ref={bindTextarea}
            onChange={(e) => {
              // Bullets are single markdown lines — fold pasted newlines.
              onChange(e.target.value.replace(/\n+/g, ' '));
              autosize(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAddBelow();
              } else if (e.key === 'Backspace' && text === '') {
                e.preventDefault();
                onRemove({ focusPrev: true });
              }
            }}
            onBlur={() => setEditing(false)}
          />
        ) : (
          <span
            className="rb-bullet-text"
            onClick={beginEdit}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                beginEdit();
              }
            }}
          >
            <Markdown>{text}</Markdown>
          </span>
        )}
        <div className="rb-bullet-actions">
          {AI_ACTIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`rb-bact ${active === a.id ? 'active' : ''}`}
              title={`${t(`action.${a.id}.label`)} — ${t(`action.${a.id}.desc`)}`}
              onClick={() => runAction(a.id)}
            >
              <span className="rb-bact-ic">{a.icon}</span>
              <span className="rb-bact-lbl">{t(`action.${a.id}.label`)}</span>
            </button>
          ))}
          <span className="rb-bact-sep" aria-hidden="true" />
          <button
            type="button"
            className="rb-bact"
            title={t('entry.move_up')}
            aria-label={t('entry.move_up')}
            disabled={!onMoveUp}
            onClick={onMoveUp}
          >
            <span className="rb-bact-ic">↑</span>
          </button>
          <button
            type="button"
            className="rb-bact"
            title={t('entry.move_down')}
            aria-label={t('entry.move_down')}
            disabled={!onMoveDown}
            onClick={onMoveDown}
          >
            <span className="rb-bact-ic">↓</span>
          </button>
          <button
            type="button"
            className="rb-bact"
            title={t('entry.remove')}
            aria-label={t('entry.remove')}
            onClick={() => onRemove()}
          >
            <span className="rb-bact-ic">✕</span>
          </button>
        </div>
      </div>

      {weak && !draft && !busy ? (
        <div className="rb-bullet-flag">
          <span aria-hidden="true">⚠</span> {t('bullet.flag')}
        </div>
      ) : null}

      {busy || draft || error ? (
        <div className="rb-rewrite">
          <div className="rb-rewrite-head">
            <div className="iv-coach-orb" style={{ width: 22, height: 22 }} />
            <div className="rb-rewrite-lbl">
              {busy ? (
                <>
                  {t('rewrite.rewriting')} ·{' '}
                  <span className="rb-rewrite-action">{activeLabel}</span>
                </>
              ) : (
                <>
                  {t('rewrite.suggested')} ·{' '}
                  <span className="rb-rewrite-action">{activeLabel}</span>
                </>
              )}
            </div>
            {!busy ? (
              <button
                type="button"
                className="iv-coach-close"
                onClick={dismiss}
                style={{ marginLeft: 'auto' }}
                aria-label={t('rewrite.discard')}
              >
                <IconX size={11} />
              </button>
            ) : null}
          </div>

          {busy ? (
            <div className="rb-rewrite-busy">
              <div className="rb-shimmer" />
              <div className="rb-shimmer" style={{ width: '85%' }} />
              <div className="rb-shimmer" style={{ width: '65%' }} />
            </div>
          ) : error ? (
            <>
              <p style={{ fontSize: 13, color: 'var(--warn)', margin: '0 0 12px' }}>
                {t('rewrite.error')}
              </p>
              <div className="rb-rewrite-foot">
                <button
                  type="button"
                  className="btn"
                  onClick={() => active && runAction(active)}
                >
                  <IconRefresh size={12} /> {t('rewrite.regenerate')}
                </button>
                <button type="button" className="btn ghost" onClick={dismiss}>
                  {t('rewrite.discard')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="rb-rewrite-text">
                <Markdown>{draft ?? ''}</Markdown>
              </div>
              <div className="rb-rewrite-foot">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    if (draft) onAccept(draft);
                    dismiss();
                  }}
                >
                  <IconCheck size={12} /> {t('rewrite.accept')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => active && runAction(active)}
                >
                  <IconRefresh size={12} /> {t('rewrite.regenerate')}
                </button>
                <button type="button" className="btn ghost" onClick={dismiss}>
                  {t('rewrite.discard')}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
