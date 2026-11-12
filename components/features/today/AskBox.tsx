'use client';

// AskBox — "Ask" on /today (docs/agent-driven/REDESIGN.md §5.6): one labelled
// input that opens the Assistant with the question. The question is put in the
// Assistant's own box; nothing is sent until the user presses Send there
// (hooks/shared/useOpenAssistant `prompt`). Rendered only when the `copilot`
// capability is on (R-04: a disabled feature has no entry).

import { useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { useOpenAssistant } from '../../../hooks/shared/useOpenAssistant';
import { Lane } from './parts';
import styles from './today.module.css';

/** Longest question the box takes. */
export const ASK_MAX_LENGTH = 500;

export function AskBox() {
  const t = useTranslations('today');
  const openAssistant = useOpenAssistant();
  const [question, setQuestion] = useState('');
  const inputId = useId();
  const hintId = useId();
  const text = question.trim();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!text) return;
    // False when the Assistant is not available: the question stays in the box.
    if (openAssistant({ prompt: text, source: 'other' })) setQuestion('');
  };

  return (
    <Lane title={t('ask.title')} testId="today-ask">
      <form className={styles.ask} onSubmit={onSubmit}>
        <label htmlFor={inputId} className={styles.askLabel}>
          {t('ask.label')}
        </label>
        <div className={styles.askRow}>
          <input
            id={inputId}
            className={styles.askInput}
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('ask.placeholder')}
            aria-describedby={hintId}
            maxLength={ASK_MAX_LENGTH}
            autoComplete="off"
            enterKeyHint="send"
          />
          <Btn type="submit" disabled={!text}>
            {t('ask.submit')}
          </Btn>
        </div>
        <p id={hintId} className={styles.note}>
          {t('ask.hint')}
        </p>
      </form>
    </Lane>
  );
}
