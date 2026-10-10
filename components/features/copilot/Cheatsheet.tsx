'use client';

// Cheatsheet — "What you can ask": six groups of example questions
// (F-ORION-06). Picking one puts it in the box; it is never sent without the
// user pressing Send. "Find jobs" also offers the sort question (the
// Assistant answers it with a link to /jobs?sort=…, which the feed honours).
// That question follows the one switch for the sort link
// (`ACTION_CARD_CAPS.sortLink`): with it off the question is not offered, so
// the cheatsheet never invites an answer the Assistant cannot give.
//
// Questions about "this job" (the groups "About a job" and "Resume and cover
// letters") need a job in context. Without one they used to be offered
// anyway, the answer was "Which job do you mean?" and the message was spent.
// Now such a group says to open a job first, with a link to the jobs list.
// On a job page whose chat is about something else (a conversation under way
// is never replaced) the group offers a new chat about the job on screen
// instead (`onAskPageJob`): telling the user to open a job they are already
// looking at would be wrong.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { cn } from '../../../lib/utils';
import { ACTION_CARD_CAPS } from './cards/ActionCard';
import styles from './copilot.module.css';

export const CHEATSHEET_GROUPS = ['find', 'search', 'job', 'documents', 'interview', 'applications'] as const;
const QUESTIONS = ['q1', 'q2', 'q3'] as const;
/** Extra questions of a group, after the three every group has. */
export const CHEATSHEET_EXTRA: Partial<Record<(typeof CHEATSHEET_GROUPS)[number], readonly string[]>> = { find: ['sort'] };

/** Groups whose questions are all about "this job": offered only with a job in context. */
export const JOB_BOUND_GROUPS: ReadonlySet<(typeof CHEATSHEET_GROUPS)[number]> = new Set(['job', 'documents']);

/** The extra questions offered now: the sort question only while the sort link is on. Pure. */
export function cheatsheetExtra(group: (typeof CHEATSHEET_GROUPS)[number], caps: { sortLink: boolean } = ACTION_CARD_CAPS): readonly string[] {
  return (CHEATSHEET_EXTRA[group] ?? []).filter((q) => q !== 'sort' || caps.sortLink);
}

export interface CheatsheetProps {
  onPick: (text: string) => void;
  wide?: boolean;
  showTitle?: boolean;
  /** The chat is about a job: the "this job" questions can be asked. Default false. */
  hasJob?: boolean;
  /** Called before the "Open your jobs" link navigates (the rail closes on a phone). */
  onNavigate?: () => void;
  /** The page is a job this chat is not about: start a new chat about it. */
  onAskPageJob?: () => void;
}

export function Cheatsheet({ onPick, wide = false, showTitle = true, hasJob = false, onNavigate, onAskPageJob }: CheatsheetProps) {
  const t = useTranslations('assistant.cheatsheet');
  const tContext = useTranslations('assistant.context');
  return (
    <section className={cn(styles.panel, wide && styles.wide)} aria-label={t('title')} data-testid="assistant-cheatsheet">
      {showTitle ? <h3 className={styles.panelTitle}>{t('title')}</h3> : null}
      <p className={styles.panelIntro}>{t('intro')}</p>
      <div className={styles.groups}>
        {CHEATSHEET_GROUPS.map((g) => (
          <div key={g} className={styles.group}>
            <h4 className={styles.groupTitle}>{t(`groups.${g}.title`)}</h4>
            {JOB_BOUND_GROUPS.has(g) && !hasJob && onAskPageJob ? (
              <div className={styles.row} data-testid={`cheatsheet-page-job-${g}`}>
                <p className={styles.panelIntro}>{t('needsJobHere')}</p>
                <button type="button" className={styles.chip} onClick={onAskPageJob}>
                  {tContext('askPageJob')}
                </button>
              </div>
            ) : JOB_BOUND_GROUPS.has(g) && !hasJob ? (
              <p className={styles.panelIntro} data-testid={`cheatsheet-needs-job-${g}`}>
                {t('needsJob')}{' '}
                <Link href="/jobs" className={styles.link} onClick={onNavigate}>
                  {t('openJobs')}
                </Link>
              </p>
            ) : (
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
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
