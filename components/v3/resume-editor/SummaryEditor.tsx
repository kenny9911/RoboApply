'use client';

// SummaryEditor — the summary textarea + the "give me 3 rewrites" flow.
// Source: RoboApply_V3/resume-editor.jsx SummaryEditor. The 3 options come from
// `resumes.rewrite({ mode:'summary' })` (the stub returns Tight / Numeric /
// Personality). Option text renders through the V3 Markdown primitive (LLM
// output may contain markdown).

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Markdown } from '../primitives';
import type {
  ResumeRewriteBody,
  ResumeRewriteResponse,
} from '../../../lib/api/v2/types';

interface RewriteOption {
  label: string;
  text: string;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** The page's `useResumeRewrite(id).mutateAsync`. */
  runRewrite: (body: ResumeRewriteBody) => Promise<ResumeRewriteResponse>;
}

export function SummaryEditor({ value, onChange, runRewrite }: Props) {
  const t = useTranslations('resumeEditor');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<RewriteOption[] | null>(null);
  const [error, setError] = useState(false);

  async function rewrite() {
    setBusy(true);
    setError(false);
    try {
      const res = await runRewrite({ mode: 'summary', text: value });
      setOptions(res.options ?? []);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const charCount = value.length;

  return (
    <div className="rb-summary">
      <textarea
        className="rb-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={t('summary.placeholder')}
      />
      <div className="rb-summary-bar">
        <button
          type="button"
          className="rb-ai-chip"
          onClick={rewrite}
          disabled={busy}
        >
          {busy ? (
            <>
              <span className="rb-ai-spinner" /> {t('summary.rewriting')}
            </>
          ) : (
            <>
              <span className="rb-ai-spark">✦</span> {t('summary.give_rewrites')}
            </>
          )}
        </button>
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: 'var(--mono)',
          }}
        >
          {t('summary.char_hint', { count: charCount })}
        </div>
      </div>

      {error ? (
        <p style={{ fontSize: 12, color: 'var(--warn)' }}>{t('rewrite.error')}</p>
      ) : null}

      {options ? (
        <div className="rb-options">
          {options.map((opt, i) => (
            <div key={i} className="rb-option">
              <div className="rb-option-lbl">
                {t('summary.option', { n: i + 1 })} · {opt.label}
              </div>
              <div className="rb-option-text">
                <Markdown>{opt.text}</Markdown>
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onChange(opt.text);
                  setOptions(null);
                }}
              >
                {t('summary.use_this')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn ghost"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setOptions(null)}
          >
            {t('summary.keep_current')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
