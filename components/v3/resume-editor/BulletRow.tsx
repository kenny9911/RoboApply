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
// Rewrite output renders through the V3 Markdown primitive (LLM output may
// contain markdown). The bullet display text is plain (parsed markdown body),
// rendered inline through Markdown too so any **bold** in a bullet reads.

import { useState } from 'react';
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
  onAccept: (next: string) => void;
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

export function BulletRow({ text, onAccept, runRewrite, targetJobId }: Props) {
  const t = useTranslations('resumeEditor');
  const [active, setActive] = useState<RAResumeRewriteAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const weak = isWeakBullet(text);

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

  const activeLabel = active ? t(`action.${active}.label`) : '';

  return (
    <div className={`rb-bullet ${weak ? 'weak' : ''}`}>
      <div className="rb-bullet-row">
        <span className="rb-bullet-dot">•</span>
        <span className="rb-bullet-text">
          <Markdown>{text}</Markdown>
        </span>
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
