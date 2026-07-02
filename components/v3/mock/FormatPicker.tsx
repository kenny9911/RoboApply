'use client';

// FormatPicker — Step 04 (proto format section → `.iv-format-card`). Two big
// cards: Video call (recommended) vs Voice only (low-pressure). Maps to the
// `RAMockFormat` ('video' | 'voice') the live screen reads.

import { useTranslations } from 'next-intl';
import type { RAMockFormat } from '../../../lib/api/v2/types';

const VideoIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M23 7l-7 5 7 5V7Z" />
    <rect x="1" y="5" width="15" height="14" rx="2" />
  </svg>
);

const VoiceIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
    <path d="M12 19v3" />
  </svg>
);

interface Props {
  value: RAMockFormat;
  onChange: (format: RAMockFormat) => void;
}

export function FormatPicker({ value, onChange }: Props) {
  const t = useTranslations('mock');
  return (
    <section className="iv-step">
      <div className="iv-step-head">
        <span className="iv-step-num">04</span>
        <div>
          <div className="iv-step-title">{t('setup.format.title')}</div>
          <div className="iv-step-sub">{t('setup.format.sub')}</div>
        </div>
      </div>
      <div className="iv-format-grid">
        <button
          type="button"
          className={`iv-format-card ${value === 'video' ? 'active' : ''}`}
          onClick={() => onChange('video')}
        >
          <div className="iv-format-icon iv-format-icon-video">
            <VideoIcon />
          </div>
          <div className="iv-format-body">
            <div className="iv-format-head">
              <span>{t('setup.format.video.title')}</span>
              <span className="iv-format-tag recommended">
                {t('setup.format.video.tag')}
              </span>
            </div>
            <div className="iv-format-desc">{t('setup.format.video.desc')}</div>
            <ul className="iv-format-bullets">
              <li>{t('setup.format.video.b1')}</li>
              <li>{t('setup.format.video.b2')}</li>
              <li>{t('setup.format.video.b3')}</li>
            </ul>
          </div>
        </button>
        <button
          type="button"
          className={`iv-format-card ${value === 'voice' ? 'active' : ''}`}
          onClick={() => onChange('voice')}
        >
          <div className="iv-format-icon iv-format-icon-voice">
            <VoiceIcon />
          </div>
          <div className="iv-format-body">
            <div className="iv-format-head">
              <span>{t('setup.format.voice.title')}</span>
              <span className="iv-format-tag">{t('setup.format.voice.tag')}</span>
            </div>
            <div className="iv-format-desc">{t('setup.format.voice.desc')}</div>
            <ul className="iv-format-bullets">
              <li>{t('setup.format.voice.b1')}</li>
              <li>{t('setup.format.voice.b2')}</li>
              <li>{t('setup.format.voice.b3')}</li>
            </ul>
          </div>
        </button>
      </div>
    </section>
  );
}
