'use client';

// OnboardTop — the onboarding overlay header bar (.onboard-top). Brand mark on
// the left, a mono stage label + a 4-dot progress row in the middle
// (Resume → Chat → Matches → Done, driven by the server-echoed chat state),
// and a Skip button on the right. Skip calls the onboarding skip endpoint
// (page-wired) and then routes /home — it must never trap the user.

import { useTranslations } from 'next-intl';
import { IconSparkle } from '../primitives/Iconset';

/** The 4 progress stages, in order. */
export type OnboardingStage = 'resume' | 'chat' | 'matches' | 'done';

const STAGES: OnboardingStage[] = ['resume', 'chat', 'matches', 'done'];

interface Props {
  stage: OnboardingStage;
  onSkip: () => void;
  /** Disables the Skip button while the skip call is in flight. */
  skipping?: boolean;
}

export function OnboardTop({ stage, onSkip, skipping = false }: Props) {
  const t = useTranslations('onboarding');
  const stageIndex = STAGES.indexOf(stage);

  return (
    <div className="onboard-top">
      <div className="brand">
        <div className="brand-mark">
          <IconSparkle
            size={20}
            stroke="var(--accent-text)"
            strokeWidthValue={2.2}
          />
        </div>
        <div className="brand-name">
          RoboApply
          <small>{t('brand_sub')}</small>
        </div>
      </div>

      <div className="onboard-step">
        {t(`chat.progress_${stage}`)}
        <span className="pip-row">
          {STAGES.map((s, i) => (
            <span key={s} className={`pip ${i <= stageIndex ? 'on' : ''}`} />
          ))}
        </span>
      </div>

      <button
        type="button"
        className="btn ghost"
        onClick={onSkip}
        disabled={skipping}
      >
        {t('skip')}
      </button>
    </div>
  );
}
