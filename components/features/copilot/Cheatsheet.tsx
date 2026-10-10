'use client';

// Cheatsheet — "What you can ask": six groups of example questions
// (F-ORION-06). Picking one puts it in the box; it is never sent without the
// user pressing Send.

import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import styles from './copilot.module.css';

export const CHEATSHEET_GROUPS = ['find', 'search', 'job', 'documents', 'interview', 'applications'] as const;
const QUESTIONS = ['q1', 'q2', 'q3'] as const;

export function Cheatsheet({ onPick, wide = false, showTitle = true }: { onPick: (text: string) => void; wide?: boolean; showTitle?: boolean }) {
  const t = useTranslations('assistant.cheatsheet');
  return (
    <section className={cn(styles.panel, wide && styles.wide)} aria-label={t('title')} data-testid="assistant-cheatsheet">
      {showTitle ? <h3 className={styles.panelTitle}>{t('title')}</h3> : null}
      <p className={styles.panelIntro}>{t('intro')}</p>
      <div className={styles.groups}>
        {CHEATSHEET_GROUPS.map((g) => (
          <div key={g} className={styles.group}>
            <h4 className={styles.groupTitle}>{t(`groups.${g}.title`)}</h4>
            <ul className={styles.promptList}>
              {QUESTIONS.map((q) => {
                const text = t(`groups.${g}.${q}`);
                return (
                  <li key={q}>
                    <button type="button" className={styles.prompt} onClick={() => onPick(text)}>
                      {text}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
