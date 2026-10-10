'use client';

// Cheatsheet — "What you can ask": six groups of example questions
// (F-ORION-06). Picking one puts it in the box; it is never sent without the
// user pressing Send. "Find jobs" also offers the sort question (the
// Assistant answers it with a link to /jobs?sort=…, which the feed honours).
// That question follows the one switch for the sort link
// (`ACTION_CARD_CAPS.sortLink`): with it off the question is not offered, so
// the cheatsheet never invites an answer the Assistant cannot give.

import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { ACTION_CARD_CAPS } from './cards/ActionCard';
import styles from './copilot.module.css';

export const CHEATSHEET_GROUPS = ['find', 'search', 'job', 'documents', 'interview', 'applications'] as const;
const QUESTIONS = ['q1', 'q2', 'q3'] as const;
/** Extra questions of a group, after the three every group has. */
export const CHEATSHEET_EXTRA: Partial<Record<(typeof CHEATSHEET_GROUPS)[number], readonly string[]>> = { find: ['sort'] };

/** The extra questions offered now: the sort question only while the sort link is on. Pure. */
export function cheatsheetExtra(group: (typeof CHEATSHEET_GROUPS)[number], caps: { sortLink: boolean } = ACTION_CARD_CAPS): readonly string[] {
  return (CHEATSHEET_EXTRA[group] ?? []).filter((q) => q !== 'sort' || caps.sortLink);
}

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
              {[...QUESTIONS, ...cheatsheetExtra(g)].map((q) => {
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
