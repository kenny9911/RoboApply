// /onboarding/[step] — one onboarding screen per stage (PRODUCT_PLAN.md §4.3
// RoboApply O1–O7, §4.5 GoApply G1–G7; WP-30). Renders inside the
// (onboarding) layout. A stage the current brand does not have is a 404, so
// /onboarding/consent never exists on RoboApply and /onboarding/goal never on
// GoApply. GoApply's own screens come from components/features/onboarding-cn
// (WP-31) through OnboardingStepPage.

import { notFound } from 'next/navigation';

import { OnboardingStepPage } from '../../../../components/features/onboarding';
import { getServerBrandId } from '../../../../lib/server/brand';
import { isOnboardingScreen } from '../steps';

export default async function OnboardingStepRoute({ params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  const brandId = await getServerBrandId();
  if (!isOnboardingScreen(brandId, step)) notFound();
  return <OnboardingStepPage step={step} />;
}
