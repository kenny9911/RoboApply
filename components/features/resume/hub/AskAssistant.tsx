'use client';

// AskAssistant — three questions about the main resume the user can start an
// Assistant chat with (F-RES-11). A question is put in the Assistant's box,
// scoped to the main resume; nothing is sent until the user presses Send. The
// page renders this only when the Assistant is on and AI may run (R-04).

import { useId } from 'react';
import { useTranslations } from 'next-intl';

import { IconChat } from '../../../v3/primitives';
import styles from './Hub.module.css';

const PROMPTS = ['fix_first', 'summary', 'lead'] as const;

export interface AskAssistantProps {
  /** Opens the Assistant with the question in its box. */
  onAsk: (prompt: string) => void;
}

export function AskAssistant({ onAsk }: AskAssistantProps) {
  const t = useTranslations('resume.hub.studio');
  const titleId = useId();
  return (
    <section className={styles.ask} aria-labelledby={titleId}>
      <h2 className={styles.askTitle} id={titleId}>
        <IconChat size={16} aria-hidden="true" />
        {t('ask')}
      </h2>
      <ul className={styles.askList}>
        {PROMPTS.map((key) => (
          <li key={key}>
            <button type="button" className={styles.askChip} onClick={() => onAsk(t(`prompts.${key}`))}>
              {t(`prompts.${key}`)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
