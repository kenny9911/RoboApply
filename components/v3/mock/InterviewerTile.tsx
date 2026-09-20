'use client';

// InterviewerTile — the left-stage interviewer presence (proto
// `InterviewerVideoTile` for video, `.iv-interviewer` orb for voice). Pulses /
// shows "Speaking" while the interviewer is asking, "Listening" otherwise.
//
// `aiState` drives the visual:
//   'asking'    → speaking (orb glows, rings pulse, bars animate)
//   'listening' → listening
//   'thinking'  → thinking

import { useTranslations } from 'next-intl';
import type { RAMockInterviewer } from '../../../lib/api/v2/types';

export type AiState = 'asking' | 'listening' | 'thinking';

interface Props {
  interviewer: RAMockInterviewer;
  aiState: AiState;
  video: boolean;
}

export function InterviewerTile({ interviewer, aiState, video }: Props) {
  const t = useTranslations('practice');
  const speaking = aiState === 'asking';

  if (video) {
    return (
      <div className={`iv-video-tile interviewer ${speaking ? 'speaking' : ''}`}>
        <div className="iv-vt-canvas">
          <div className="iv-vt-grid" />
          <div
            className="iv-vt-orb"
            style={{
              background: 'var(--grad-brand)',
            }}
          />
          <div className={`iv-vt-rings ${speaking ? 'on' : ''}`}>
            <span />
            <span />
            <span />
          </div>
          <div className="iv-vt-scanlines" />
          {speaking ? (
            <div className="iv-vt-bars">
              {Array.from({ length: 5 }).map((_, i) => (
                <span key={i} style={{ animationDelay: `${i * 100}ms` }} />
              ))}
            </div>
          ) : null}
        </div>

        <div className="iv-vt-badge">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2 9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7Z" />
          </svg>
          {t('live.aiInterviewer')}
        </div>

        <div className="iv-vt-state-pill">
          <span className={`dot ${aiState === 'asking' ? 'speaking' : aiState}`} />
          {aiState === 'asking'
            ? t('live.state.speaking')
            : aiState === 'listening'
              ? t('live.state.listening')
              : t('live.state.thinking')}
        </div>

        <div className="iv-vt-name-overlay">
          <div className="iv-vt-name">{interviewer.name}</div>
          <div className="iv-vt-role">
            {interviewer.role} · {interviewer.company}
          </div>
        </div>
      </div>
    );
  }

  // Voice mode — orb in a crater.
  return (
    <div className={`iv-interviewer ${speaking ? 'speaking' : ''}`}>
      <div
        className="iv-interviewer-orb"
        style={{
          background: 'var(--grad-brand)',
        }}
      />
      <div className="iv-interviewer-rings">
        <span />
        <span />
        <span />
      </div>
      <div className="iv-interviewer-name">{interviewer.name}</div>
      <div className="iv-interviewer-role">{interviewer.role}</div>
      <div className="iv-interviewer-state">
        <span className={`dot ${aiState === 'asking' ? 'speaking' : aiState}`} />
        {aiState === 'asking'
          ? t('live.state.asking')
          : aiState === 'listening'
            ? t('live.state.listening')
            : t('live.state.thinking')}
      </div>
    </div>
  );
}
