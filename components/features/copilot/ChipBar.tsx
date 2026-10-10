'use client';

// ChipBar — quick questions about the job the chat is about (F-ORION-02):
// Why I fit · What I'm missing · Resume tips · Tailor my resume · Write a
// cover letter · Practice for this job · Similar jobs.
//
// Question chips send a turn with the chip id (the server picks the right
// tool). "Tailor my resume" is the tailoring area's own button (WP-36a, it
// hides itself when AI tailoring is off) and "Practice for this job" opens
// the practice setup (WP-43); neither spends anything until the user starts.

import { useTranslations } from 'next-intl';

import type { CopilotChip } from '../../../hooks/copilot';
import { useLaunchPractice } from '../../../hooks/shared/useLaunchPractice';
import { TailorButton } from '../tailor';
import styles from './copilot.module.css';

export const ASK_CHIPS = ['why_fit', 'whats_missing', 'resume_tips', 'cover_letter', 'similar_jobs'] as const;
type AskChip = (typeof ASK_CHIPS)[number];

export interface ChipBarProps {
  jobId: string;
  disabled?: boolean;
  onAsk: (text: string, chip: CopilotChip) => void;
  onNavigate?: () => void;
}

export function ChipBar({ jobId, disabled = false, onAsk, onNavigate }: ChipBarProps) {
  const t = useTranslations('assistant');
  const launchPractice = useLaunchPractice();
  const ask = (chip: AskChip) => onAsk(t(`chipPrompts.${chip}`), chip);
  return (
    <div className={styles.chipBar} role="group" aria-label={t('chips.label')}>
      <p className={styles.chipLabel}>{t('context.job')}</p>
      <div className={styles.chips}>
        {(['why_fit', 'whats_missing', 'resume_tips'] as const).map((chip) => (
          <button key={chip} type="button" className={styles.chip} disabled={disabled} onClick={() => ask(chip)} data-chip={chip}>
            {t(`chips.${chip}`)}
          </button>
        ))}
        <span onClickCapture={onNavigate}>
          <TailorButton jobId={jobId} from="assistant" className={styles.chip} />
        </span>
        <button type="button" className={styles.chip} disabled={disabled} onClick={() => ask('cover_letter')} data-chip="cover_letter">
          {t('chips.cover_letter')}
        </button>
        <button
          type="button"
          className={styles.chip}
          data-chip="practice"
          onClick={() => {
            onNavigate?.();
            launchPractice({ jobId, from: 'assistant' });
          }}
        >
          {t('chips.practice')}
        </button>
        <button type="button" className={styles.chip} disabled={disabled} onClick={() => ask('similar_jobs')} data-chip="similar_jobs">
          {t('chips.similar_jobs')}
        </button>
      </div>
    </div>
  );
}
