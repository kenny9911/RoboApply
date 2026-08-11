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
  className?: string;
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
  className,
}: Props) {
  const t = useTranslations('practice');
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safeCurrent = safeTotal > 0
    ? Math.min(
      Number.isFinite(currentIndex) ? Math.max(0, Math.floor(currentIndex)) : 0,
      safeTotal - 1,
    )
    : 0;
  const safeElapsed = Number.isFinite(elapsedSec) ? Math.max(0, Math.floor(elapsedSec)) : 0;
  const showProgress = safeTotal > 0;

  return (
    <header className={`iv-live-bar${className ? ` ${className}` : ''}`}>
      <button type="button" className="btn ghost" onClick={onBack} aria-label={t('live.backToSetup')}>
        <span className="iv-live-back-label">{t('live.backToSetup')}</span>
      </button>
      <div className="iv-live-bar-center iv-live-context">
        <div className="iv-live-primary">
          <span className="iv-live-pill">
            <span className="rec" aria-hidden />
            {t('live.livePill')}
          </span>
          <span className="iv-live-meta">{role}</span>
        </div>
        <div className="iv-live-secondary">
          <span>{typeLabel}</span>
          <span className="iv-live-sep" aria-hidden>·</span>
          <span>{format === 'video' ? t('live.modeVideo') : t('live.modeVoice')}</span>
        </div>
      </div>
      <div className="iv-live-session">
        <time className="iv-live-time" dateTime={`PT${safeElapsed}S`}>
          {fmtTime(safeElapsed)}
        </time>
        {showProgress && (
          <div
            className="iv-live-progress"
            aria-label={t('live.progress', { current: safeCurrent + 1, total: safeTotal })}
          >
            {Array.from({ length: safeTotal }).map((_, i) => (
              <span
                key={i}
                aria-hidden
                className={`iv-pip ${i < safeCurrent ? 'done' : i === safeCurrent ? 'active' : ''}`}
              />
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
