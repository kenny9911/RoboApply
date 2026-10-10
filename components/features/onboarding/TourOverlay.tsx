'use client';

// TourOverlay — onboarding stage `tour` on /jobs (PRODUCT O8; WP-30), mounted
// once by the app shell (FND-6a slot).
//
//   - While `/auth/me.onboarding.step === 'tour'` and the page is /jobs: a
//     dismissible 4-card overlay, shown once: "Why you fit and what's
//     missing" · "A tailored resume for each job" · "Ready-to-apply kits — you
//     submit" · "Practice the interview". CTA "Start". It goes through the
//     popup gate as essential (it takes the page view's one slot, never two
//     prompts at once). Start or close → POST /onboarding/complete (stage
//     done) and `markToursSeen(['jobs.firstVisit'])`.
//   - Otherwise on /jobs: the first-visit prompt dock (finish banner or the
//     next tip, one at a time; FirstVisitPrompts.tsx).
//   - Never blocks the page; no avatar; no countdown; no offer.

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { useCompleteOnboarding } from '../../../hooks/onboarding/useOnboarding';
import { useAuth } from '../../../lib/auth/useAuth';
import { markToursSeen } from '../../../lib/api/uiState';
import { UI_STATE_QUERY_KEY, usePopupGate } from '../../../lib/ui/popupGate';
import { Btn } from '../../v3/primitives/Btn';
import { Modal } from '../../v3/primitives/Modal';
import { OnboardingPromptDock } from './FirstVisitPrompts';
import { UI_KEYS } from './options';
import styles from './onboarding.module.css';

export type TourOverlayProps = Record<string, never>;

const CARDS = ['fit', 'tailor', 'ready', 'practice'] as const;

/** The 4-card overlay itself (exported for tests and stories). */
export function FirstVisitTour({ open, onDone }: { open: boolean; onDone: () => void }) {
  const t = useTranslations('onboarding.tour');
  return (
    <Modal
      open={open}
      onClose={onDone}
      title={t('title')}
      ariaLabel={t('label')}
      maxWidth="xl"
      footer={
        <Btn type="button" variant="primary" onClick={onDone} className={styles.touch}>
          {t('start')}
        </Btn>
      }
    >
      <ul className={styles.tourCards}>
        {CARDS.map((c) => (
          <li key={c} className={styles.tourCard}>
            <p className={styles.tourCardTitle}>{t(`cards.${c}`)}</p>
            <p className={styles.panelText}>{t(`cards.${c}Body`)}</p>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function TourGate() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const complete = useCompleteOnboarding();
  const [done, setDone] = useState(false);
  const { granted } = usePopupGate('onboarding:tour', 'announcement', { essential: true });

  const finish = () => {
    if (done) return;
    setDone(true);
    complete.mutate(undefined, {
      onSettled: () => {
        void refresh?.();
      },
    });
    void markToursSeen([UI_KEYS.tour])
      .then((res) => qc.setQueryData(UI_STATE_QUERY_KEY, res))
      .catch(() => undefined);
  };

  return <FirstVisitTour open={granted && !done} onDone={finish} />;
}

export function TourOverlay(_props: TourOverlayProps = {}) {
  const pathname = usePathname() ?? '';
  const auth = useAuth();
  const onboarding = auth.me?.onboarding;
  if (auth.status !== 'authenticated' || pathname !== '/jobs' || !onboarding) return null;
  if (onboarding.step === 'tour') return <TourGate />;
  if (onboarding.completed) return <OnboardingPromptDock />;
  return null;
}

export default TourOverlay;
