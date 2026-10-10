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
//   - GoApply (INT-08): the first-value screen (deadline reminders, then the
//     tour of what is on for this user) normally shows on the onboarding
//     page right after the confirm step. A user who left before finishing it
//     is still at stage `tour`; they get it once more here, on /jobs or
//     /resume (the first-value pages inside the app shell), instead of the
//     RoboApply cards. Finishing or closing it completes onboarding.
//   - Never blocks the page; no avatar; no countdown; no offer.

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';

import { useCompleteOnboarding } from '../../../hooks/onboarding/useOnboarding';
import { useAuth } from '../../../lib/auth/useAuth';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import { markToursSeen } from '../../../lib/api/uiState';
import { UI_STATE_QUERY_KEY, usePopupGate } from '../../../lib/ui/popupGate';
import { Btn } from '../../v3/primitives/Btn';
import { Modal } from '../../v3/primitives/Modal';
import { CnFirstValueScreen } from '../onboarding-cn';
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

/** Completing the tour stage: POST /onboarding/complete, refresh /auth/me, mark the tour seen. Once. */
function useFinishTour() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const complete = useCompleteOnboarding();
  const [done, setDone] = useState(false);
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
  return { done, finish };
}

function TourGate() {
  const { done, finish } = useFinishTour();
  const { granted } = usePopupGate('onboarding:tour', 'announcement', { essential: true });
  return <FirstVisitTour open={granted && !done} onDone={finish} />;
}

/** GoApply: the first-value screen for a user who left it unfinished. */
function CnTourGate() {
  const t = useTranslations('onboarding.tour');
  const { done, finish } = useFinishTour();
  const { granted } = usePopupGate('onboarding:tour', 'announcement', { essential: true });
  return (
    <Modal open={granted && !done} onClose={finish} ariaLabel={t('label')} maxWidth="xl">
      <CnFirstValueScreen onFinish={finish} />
    </Modal>
  );
}

/** Pages inside the app shell that can be GoApply's first-value page (R-14; /campus has its own shell). */
const CN_FIRST_VALUE_PAGES = ['/jobs', '/resume'];

export function TourOverlay(_props: TourOverlayProps = {}) {
  const pathname = usePathname() ?? '';
  const auth = useAuth();
  const brandId = useBrandId();
  const onboarding = auth.me?.onboarding;
  if (auth.status !== 'authenticated' || !onboarding) return null;
  if (brandId === 'goapply') {
    if (onboarding.step === 'tour') return CN_FIRST_VALUE_PAGES.includes(pathname) ? <CnTourGate /> : null;
    return pathname === '/jobs' && onboarding.completed ? <OnboardingPromptDock /> : null;
  }
  if (pathname !== '/jobs') return null;
  if (onboarding.step === 'tour') return <TourGate />;
  if (onboarding.completed) return <OnboardingPromptDock />;
  return null;
}

export default TourOverlay;
