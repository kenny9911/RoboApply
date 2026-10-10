'use client';

// Composer — the question box: Enter sends, Shift+Enter is a new line, Stop
// while an answer streams, voice input where the browser has it, and the
// credit line ("Uses 1 of your N left today") so the cost is known before
// sending (one `assistant` credit per message). `compact` (the rail) uses the
// short hint text: the long one does not fit the narrow box on one line.

import { forwardRef, useId, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import { bucketSummary, useCredits } from '../../../hooks/shared/useCredits';
import { Btn, CreditNotice, HonestyLine } from '../../v3/primitives';
import { VoiceInput } from './VoiceInput';
import styles from './copilot.module.css';

export const COMPOSER_MAX = 4000;

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  /** A narrow box (the rail): the short hint text. Default false. */
  compact?: boolean;
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ value, onChange, onSend, onStop, streaming, compact = false }, ref) {
  const t = useTranslations('assistant.composer');
  const credits = useCredits();
  const hintId = useId();
  const inputId = useId();
  const tooLong = value.length > COMPOSER_MAX;
  const canSend = !streaming && value.trim().length > 0 && !tooLong;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <div className={styles.composerBox}>
        <label htmlFor={inputId} className="sr-only">
          {t('label')}
        </label>
        <textarea
          ref={ref}
          id={inputId}
          className={styles.input}
          rows={1}
          value={value}
          placeholder={t(compact ? 'placeholderShort' : 'placeholder')}
          aria-describedby={hintId}
          aria-invalid={tooLong || undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="assistant-input"
        />
        <VoiceInput disabled={streaming} onText={(text) => onChange(value ? `${value} ${text}` : text)} />
        {streaming ? (
          <Btn type="button" className={styles.sendBtn} onClick={onStop} data-testid="assistant-stop">
            {t('stop')}
          </Btn>
        ) : (
          <Btn type="submit" variant="primary" className={styles.sendBtn} disabled={!canSend} data-testid="assistant-send">
            {t('send')}
          </Btn>
        )}
      </div>
      <div className={styles.composerFoot}>
        <p id={hintId}>{tooLong ? t('tooLong', { max: COMPOSER_MAX }) : t('hint')}</p>
        <CreditNotice bucket={bucketSummary(credits.data?.summary, 'assistant')} />
      </div>
      <HonestyLine kind="ai_written" />
    </form>
  );
});
