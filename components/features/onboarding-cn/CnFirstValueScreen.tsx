'use client';

// GoApply first value, wired (stage `tour`; PRODUCT_PLAN.md §4.5 G7; INT-08).
//
// `CnFirstValueTour` takes plain props; this screen reads them for the
// signed-in user and renders it:
//   classYear, cities   the stored G2 / G4 answers (GET /onboarding/state);
//   campusCalendar      the `jobs.campusCalendar` capability (R-14; off = no
//                       reminder prompt and no calendar card);
//   aiAllowed           the brand has an AI model (`ai.text`) AND the user's
//                       AI processing consent is on in the consent ledger.
//                       Unknown or unreadable = off: nothing is advertised
//                       that the user may not be able to use.
// The onboarding page shows it after the confirm step; the app shell shows it
// once more on the first-value page when the user left before finishing it.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useFlag } from '../../../lib/flags';
import { useCnOnboardingApi } from './api';
import { CnFirstValueTour } from './CnFirstValueTour';
import { proseLocale } from './ConsentStep';
import { stepAnswers } from './logic';
import { useStoredAnswers } from './parts';
import styles from './OnboardingCn.module.css';

/**
 * May AI features be shown to this user? null while the answer is loading.
 * True only with the brand's AI capability and a granted `ai_resume_parsing`
 * record; a failed read counts as "no".
 */
export function useCnAiAllowed(): boolean | null {
  const api = useCnOnboardingApi();
  const locale = useLocale();
  const capability = useFlag('ai.text');
  const [granted, setGranted] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getMyConsents(proseLocale(locale))
      .then((items) => live && setGranted(items.find((i) => i.type === 'ai_resume_parsing')?.granted === true))
      .catch(() => live && setGranted(false));
    return () => {
      live = false;
    };
  }, [api, locale]);
  if (granted === null) return null;
  return capability && granted;
}

export interface CnFirstValueScreenProps {
  /** The tour was finished or dismissed (the caller moves the stage to `done`). */
  onFinish: () => void;
  /** A problem finishing (already in plain language). */
  error?: string | null;
}

export function CnFirstValueScreen({ onFinish, error }: CnFirstValueScreenProps) {
  const t = useTranslations('onboardingCn');
  const campusCalendar = useFlag('jobs.campusCalendar');
  const aiAllowed = useCnAiAllowed();
  const { answers, loaded } = useStoredAnswers();

  if (!loaded || aiAllowed === null) {
    return (
      <p className={styles.note} role="status">
        {t('common.loading')}
      </p>
    );
  }
  const classYearRaw = stepAnswers(answers, 'identity').graduationClass;
  const citiesRaw = stepAnswers(answers, 'intent').cities;
  return (
    <>
      <CnFirstValueTour
        classYear={typeof classYearRaw === 'number' ? classYearRaw : null}
        cities={Array.isArray(citiesRaw) ? citiesRaw.filter((c): c is string => typeof c === 'string') : []}
        campusCalendar={campusCalendar}
        aiAllowed={aiAllowed}
        onFinish={onFinish}
      />
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
