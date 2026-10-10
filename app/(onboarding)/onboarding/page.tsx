'use client';

// /onboarding — sends the user to where their setup stands (WP-30):
// GET /onboarding/state → `nextRoute` (the current or left-at screen), or the
// first-value page once setup is finished (RoboApply: /jobs; GoApply: /campus,
// /jobs or /resume by what is on). The "Finish setting up" banner links here.
//
// GoApply at stage `tour` (confirm saved, the first-value screen not finished):
// the server's `nextRoute` is already the first-value page, which may be
// /campus — a page outside the app shell, where nothing would ever finish
// setup. So the user goes back to /onboarding/confirm, which shows the
// first-value screen at that stage and completes onboarding when it is closed
// (`onboardingIndexTarget`, components/features/onboarding/flow.ts).

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { onboardingIndexTarget } from '../../../components/features/onboarding/flow';
import { useOnboardingState } from '../../../hooks/onboarding/useOnboarding';

export default function OnboardingIndexPage() {
  const t = useTranslations('onboarding.frame');
  const router = useRouter();
  const state = useOnboardingState();
  const target = state.data ? onboardingIndexTarget(state.data) : state.isError ? '/jobs' : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return (
    <p role="status" style={{ padding: 'var(--sp-6) var(--sp-4)', color: 'var(--text-muted)' }}>
      {t('loading')}
    </p>
  );
}
