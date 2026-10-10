'use client';

// /onboarding — sends the user to where their setup stands (WP-30):
// GET /onboarding/state → `nextRoute` (the current or left-at screen), or the
// jobs page once setup is finished. The "Finish setting up" banner links here.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useOnboardingState } from '../../../hooks/onboarding/useOnboarding';

export default function OnboardingIndexPage() {
  const t = useTranslations('onboarding.frame');
  const router = useRouter();
  const state = useOnboardingState();
  const target = state.data ? (state.data.completed ? '/jobs' : (state.data.nextRoute ?? '/jobs')) : state.isError ? '/jobs' : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return (
    <p role="status" style={{ padding: 'var(--sp-6) var(--sp-4)', color: 'var(--text-muted)' }}>
      {t('loading')}
    </p>
  );
}
