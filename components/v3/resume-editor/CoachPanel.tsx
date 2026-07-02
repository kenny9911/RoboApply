'use client';

// CoachPanel — the floating AI-coach card (.rb-coach) that cycles through coach
// tips every 4.5s. Source: RoboApply_V3/resume-editor.jsx coach block. Tips
// come from `resumes.coachTips(id)` (the stub returns 4). Tip text renders via
// the V3 Markdown primitive (LLM-authored).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Markdown, IconX } from '../primitives';
import type { RAResumeCoachTip } from '../../../lib/api/v2/types';

interface Props {
  tips: RAResumeCoachTip[];
  onClose: () => void;
}

export function CoachPanel({ tips, onClose }: Props) {
  const t = useTranslations('resumeEditor');
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (tips.length <= 1) return;
    const handle = setInterval(
      () => setIdx((i) => (i + 1) % tips.length),
      4500,
    );
    return () => clearInterval(handle);
  }, [tips.length]);

  if (tips.length === 0) return null;
  const tip = tips[Math.min(idx, tips.length - 1)];

  // Tips are deterministic on the backend, which emits a stable `code` so we
  // can render them in the user's language. Fall back to the English `text`
  // for an unmapped code (or an older backend that doesn't send one).
  const tipText =
    tip.code && t.has(`coach.tips.${tip.code}`)
      ? t(`coach.tips.${tip.code}`, tip.params ?? {})
      : tip.text;

  return (
    <div className="rb-coach">
      <div className="rb-coach-head">
        <div className="iv-coach-orb" />
        <div>
          <div className="iv-coach-lbl">{t('coach.label')}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {t('coach.sub')}
          </div>
        </div>
        <button
          type="button"
          className="iv-coach-close"
          onClick={onClose}
          style={{ marginLeft: 'auto' }}
          aria-label={t('coach.hide')}
        >
          <IconX size={12} />
        </button>
      </div>

      <div className={`rb-coach-tip ${tip.kind === 'careful' ? 'careful' : ''}`}>
        <Markdown>{tipText}</Markdown>
      </div>

      <div className="rb-coach-foot">
        <div className="rb-coach-pips">
          {tips.map((_, i) => (
            <span key={i} className={i === idx ? 'on' : ''} />
          ))}
        </div>
        <button
          type="button"
          className="btn ghost"
          style={{ padding: '4px 0', fontSize: 11.5 }}
          onClick={() => setIdx((i) => (i + 1) % tips.length)}
        >
          {t('coach.next')}
        </button>
      </div>
    </div>
  );
}
