'use client';

// /onboarding — route shell (FND-6b). The bare path used to redirect to /jobs
// in next.config.mjs (FND-6a removed that rule so /onboarding/<stage> can
// exist). Until WP-30 sends the user to their current stage (from
// /auth/me.onboarding.nextRoute), it keeps the old behaviour: go to the
// brand's home destination — the first visible nav entry (/jobs on
// RoboApply) — once the capability flags are known.
//
// Owner: WP-30, who replaces this page.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { homeHref, useVisibleNav } from '../../../components/v3/shell/destinations';
import { useCapabilities } from '../../../lib/flags';

export default function OnboardingIndexPage() {
  const router = useRouter();
  const nav = useVisibleNav();
  const { status } = useCapabilities();
  const target = status === 'loading' ? null : homeHref(nav);

  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  return <div hidden data-route-stub="/onboarding" data-owner="WP-30" />;
}
