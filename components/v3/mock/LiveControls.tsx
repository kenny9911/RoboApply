'use client';

// LiveControls — the right-stage action row (proto `.iv-controls`). Cam toggle
// (video only), mic toggle, restart, and the primary "Submit & next" /
// "Submit & finish" button that advances the live loop (mock.nextTurn) or ends
// it (mock.score). The primary button stretches to fill (flex: 1).

import { useTranslations } from 'next-intl';

interface Props {
  video: boolean;
  camOn: boolean;
  micOn: boolean;
  isLastQuestion: boolean;
  submitting: boolean;
  onToggleCam: () => void;
  onToggleMic: () => void;
  onRestart: () => void;
  onSubmit: () => void;
}

export function LiveControls({
  video,
  camOn,
  micOn,
  isLastQuestion,
  submitting,
  onToggleCam,
  onToggleMic,
  onRestart,
  onSubmit,
}: Props) {
  const t = useTranslations('mock');
  return (
    <div className="iv-controls">
      {video ? (
        <button type="button" className="btn" onClick={onToggleCam}>
          {camOn ? t('live.controls.camOn') : t('live.controls.camOff')}
        </button>
      ) : null}
      <button type="button" className="btn" onClick={onToggleMic}>
        {micOn ? t('live.controls.mute') : t('live.controls.mic')}
      </button>
      <button type="button" className="btn" onClick={onRestart}>
        {t('live.controls.restart')}
      </button>
      <button
        type="button"
        className="btn primary"
        style={{ flex: 1 }}
        onClick={onSubmit}
        disabled={submitting}
      >
        {submitting
          ? t('live.controls.submitting')
          : isLastQuestion
            ? t('live.controls.submitFinish')
            : t('live.controls.submitNext')}
      </button>
    </div>
  );
}
