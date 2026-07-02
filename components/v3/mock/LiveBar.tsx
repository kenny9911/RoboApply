'use client';

// LiveBar — the live session header (proto `.iv-live-bar`). Back-to-setup link,
// a LIVE pill, the role · type · mode meta, the running timer, and the
// question-progress pips. The whole live route is full-focus (the (auth) layout
// hides the sidebar), so this bar is the only chrome.

import { useTranslations } from 'next-intl';
import type { RAMockFormat } from '../../../lib/api/v2/types';

interface Props {
  role: string;
  typeLabel: string;
  format: RAMockFormat;
  elapsedSec: number;
  currentIndex: number;
  total: number;
  onBack: () => void;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function LiveBar({
  role,
  typeLabel,
  format,
  elapsedSec,
  currentIndex,
  total,
  onBack,
}: Props) {
  const t = useTranslations('mock');
  return (
    <div className="iv-live-bar">
      <button type="button" className="btn ghost" onClick={onBack}>
        {t('live.backToSetup')}
      </button>
      <div className="iv-live-bar-center">
        <span className="iv-live-pill">
          <span className="rec" />
          {t('live.livePill')}
        </span>
        <span className="iv-live-meta">{role}</span>
        <span className="iv-live-sep">·</span>
        <span className="iv-live-meta">{typeLabel}</span>
        <span className="iv-live-sep">·</span>
        <span className="iv-live-meta" style={{ color: 'var(--accent-text)' }}>
          {format === 'video' ? t('live.modeVideo') : t('live.modeVoice')}
        </span>
        <span className="iv-live-sep">·</span>
        <span className="iv-live-time">{fmtTime(elapsedSec)}</span>
      </div>
      <div className="iv-live-progress" aria-label={t('live.progress', { current: currentIndex + 1, total })}>
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`iv-pip ${i < currentIndex ? 'done' : i === currentIndex ? 'active' : ''}`}
          />
        ))}
      </div>
    </div>
  );
}
