'use client';

// GettingStartedChecklist — "Tailor a resume for a job · Do a practice
// interview · Save a job for later"; finishing all three grants one practice
// interview credit, once (PRODUCT_PLAN.md O8 item 5, F-GROW-05; TASK_PLAN.md
// WP-23). The reward is deterministic, not a raffle, and its size comes from
// the server (`ChecklistView.reward`), never from copy.
//
// Progress is server state: a step completes only through
// `growth.markChecklistStep()` on the server (WP-34 save, WP-36a tailor
// finalize, WP-43 completed practice). This card reads it and offers a link
// to each action; it never marks a step itself. It renders nothing while
// loading, when signed out, when the area is not available
// (`feature_disabled`), after the user closes it, and once the reward has
// been granted and the user has closed the done state.

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useChecklist, useDismissChecklist } from '../../../hooks/growth/useChecklist';
import { track } from '../../../lib/analytics';
import type { ChecklistStep } from '../../../lib/api/contracts/growth';
import { IconCheck, IconX } from '../../v3/primitives/Iconset';
import { Btn } from '../../v3/primitives/Btn';
import styles from './growth.module.css';

export interface GettingStartedChecklistProps {
  /** 'card' on the jobs page; 'compact' in narrow places (the More sheet). */
  variant?: 'card' | 'compact';
}

/** Display order and where each step's action lives. */
const STEPS: ReadonlyArray<{ step: ChecklistStep; href: string }> = [
  { step: 'tailor', href: '/jobs' },
  { step: 'practice', href: '/practice' },
  { step: 'save_job', href: '/jobs' },
];

export function GettingStartedChecklist({ variant = 'card' }: GettingStartedChecklistProps = {}) {
  const t = useTranslations('growth.checklist');
  const { data } = useChecklist();
  const dismiss = useDismissChecklist();
  const viewed = useRef(false);

  const doneCount = data ? STEPS.filter(({ step }) => data.steps[step]).length : 0;
  const visible = !!data && !data.dismissed;

  useEffect(() => {
    if (!visible || viewed.current) return;
    viewed.current = true;
    track('checklist_viewed', { doneCount });
  }, [visible, doneCount]);

  if (!data || !visible) return null;

  const total = STEPS.length;
  const allDone = doneCount === total;
  const credits = data.reward.credits;

  const onClose = () => {
    track('checklist_dismissed', { doneCount });
    dismiss.mutate();
  };

  return (
    <section className={`${styles.checklist} ${variant === 'compact' ? styles.compact : ''}`} aria-label={t('regionLabel')}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>{t('title')}</h2>
          {!allDone && <p className={styles.intro}>{t('intro', { credits })}</p>}
          <p className={styles.progress}>{t('progress', { done: doneCount, total })}</p>
        </div>
        <Btn variant="ghost" className={styles.close} onClick={onClose} aria-label={t('closeLabel')} title={t('close')}>
          <IconX aria-hidden="true" />
        </Btn>
      </div>

      <ul className={styles.steps}>
        {STEPS.map(({ step, href }) => {
          const done = data.steps[step];
          return (
            <li key={step} className={styles.step}>
              <span className={`${styles.mark} ${done ? styles.markDone : ''}`} aria-hidden="true">
                {done ? <IconCheck width={14} height={14} /> : null}
              </span>
              <span className={`${styles.stepLabel} ${done ? styles.stepLabelDone : ''}`}>
                {t(`steps.${step}`)}
                <span className={styles.srOnly}> — {done ? t('done') : t('notDone')}</span>
              </span>
              {!done && (
                <Link className={`btn ${styles.stepAction}`} href={href} onClick={() => track('checklist_item_clicked', { step })}>
                  {t(`actions.${step}`)}
                </Link>
              )}
            </li>
          );
        })}
      </ul>

      {allDone && (
        <p className={styles.outcome} role="status">
          {data.rewarded ? t('rewarded', { credits }) : t('pendingReward')}
        </p>
      )}
    </section>
  );
}

export default GettingStartedChecklist;
