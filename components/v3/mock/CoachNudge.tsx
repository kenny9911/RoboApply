'use client';

// CoachNudge — the live coach tip surfaced mid-answer (proto `.iv-coach`). Two
// tones: 'good' (lime) and 'careful' (amber). The tip text is LLM/stub-authored
// → rendered through the sanitized Markdown primitive. Dismissible.

import { useTranslations } from 'next-intl';
import { IconX } from '../primitives/Iconset';
import { Markdown } from '../primitives/Markdown';
import type { RAMockCoachTip } from '../../../lib/api/v2/types';

interface Props {
  tip: RAMockCoachTip;
  onDismiss: () => void;
}

export function CoachNudge({ tip, onDismiss }: Props) {
  const t = useTranslations('mock');
  return (
    <div className={`iv-coach ${tip.kind === 'careful' ? 'careful' : ''}`}>
      <div className="iv-coach-orb" />
      <div className="iv-coach-body">
        <div className="iv-coach-lbl">{t('live.coachLive')}</div>
        <div className="iv-coach-text">
          <Markdown>{tip.text}</Markdown>
        </div>
      </div>
      <button
        type="button"
        className="iv-coach-close"
        onClick={onDismiss}
        aria-label={t('live.dismiss')}
      >
        <IconX size={11} />
      </button>
    </div>
  );
}
