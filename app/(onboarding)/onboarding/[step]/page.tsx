// /onboarding/[step] — route shell (FND-6b). One onboarding screen per stage
// (PRODUCT_PLAN.md §4.3 RoboApply O1–O7, §4.5 GoApply G1–G7).
//
// STUB. Owner: WP-30, who replaces this page (GoApply screens come from
// components/features/onboarding-cn, WP-31). Renders inside the (onboarding)
// layout. A stage the current brand does not have is a 404, so
// /onboarding/consent never exists on RoboApply and /onboarding/goal never on
// GoApply.

import { notFound } from 'next/navigation';

import { getServerBrandId } from '../../../../lib/server/brand';
import { isOnboardingScreen } from '../steps';

export default async function OnboardingStepPage({ params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  const brandId = await getServerBrandId();
  if (!isOnboardingScreen(brandId, step)) notFound();
  return <div hidden data-route-stub="/onboarding/[step]" data-owner="WP-30" data-param={step} />;
}
