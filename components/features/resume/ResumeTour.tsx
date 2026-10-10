'use client';

// ResumeTour — the 4-step resume check tour (WP-65; PRODUCT_PLAN.md F-RES-07).
//
//   1 grade    what the grade means (a checklist result, never a chance of passing)
//   2 filters  issues by priority
//   3 issues   open an issue: see why, fix it here or in the editor
//   4 recheck  check again after editing; the comparison shows what changed
//
// A small card in the corner points at each part (the part gets an outline);
// it never blocks the page. "Seen" is stored per user in RAUserUiState
// (`tours['resume.checkTour']`), so it shows once across devices. The first
// automatic start goes through the popup gate; "Show me around" replays it.
// Escape or "End tour" closes it.

import { useEffect, useId, useRef } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { useResumeTour } from '../../../hooks/resume/useResumeTour';
import styles from './builder/Builder.module.css';
import checkStyles from './ResumeCheck.module.css';

export const RESUME_TOUR_STEPS = ['grade', 'filters', 'issues', 'recheck'] as const;
export type ResumeTourStep = (typeof RESUME_TOUR_STEPS)[number];

export interface ResumeTourProps {
  /** The report is on screen (the tour points at its parts). */
  enabled: boolean;
  /** Start by itself on the first visit (default true). */
  autoStart?: boolean;
}

export function ResumeTour({ enabled, autoStart = true }: ResumeTourProps) {
  const t = useTranslations('resumeBuilder.tour');
  const tour = useResumeTour({ enabled, autoStart });
  if (!enabled) return null;
  return (
    <>
      <button type="button" className={checkStyles.linkBtn} onClick={tour.start}>
        {t('replay')}
      </button>
      {tour.open ? <ResumeTourCard step={tour.step} onStep={tour.setStep} onFinish={tour.finish} /> : null}
    </>
  );
}

/** The coach-mark card (exported for tests). */
export function ResumeTourCard({ step, onStep, onFinish }: { step: number; onStep: (n: number) => void; onFinish: () => void }) {
  const t = useTranslations('resumeBuilder.tour');
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const key = RESUME_TOUR_STEPS[Math.max(0, Math.min(RESUME_TOUR_STEPS.length - 1, step))]!;
  const last = step >= RESUME_TOUR_STEPS.length - 1;

  // Outline the part this step is about and bring it into view.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector<HTMLElement>(`[data-tour="${key}"]`);
    if (!el) return;
    el.setAttribute('data-tour-active', 'true');
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    return () => el.removeAttribute('data-tour-active');
  }, [key]);

  useEffect(() => {
    titleRef.current?.focus();
  }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFinish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onFinish]);

  return (
    <div className={styles.tour} role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="resume-tour">
      <p className={styles.tourStep}>{t('progress', { current: step + 1, total: RESUME_TOUR_STEPS.length })}</p>
      <h2 id={titleId} ref={titleRef} tabIndex={-1} className={styles.tourTitle}>
        {t(`steps.${key}.title`)}
      </h2>
      <p className={styles.hint}>{t(`steps.${key}.body`)}</p>
      <div className={styles.nav}>
        <Btn type="button" variant="ghost" onClick={onFinish}>
          {t('end')}
        </Btn>
        <div className={styles.navEnd}>
          {step > 0 ? (
            <Btn type="button" variant="ghost" onClick={() => onStep(step - 1)}>
              {t('back')}
            </Btn>
          ) : null}
          <Btn type="button" variant="primary" onClick={() => (last ? onFinish() : onStep(step + 1))}>
            {last ? t('done') : t('next')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
