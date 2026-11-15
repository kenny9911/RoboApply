// /onboarding/start — RoboApply's two-screen setup (docs/agent-driven/REDESIGN.md §4):
// "Start with your resume", then "Is this what you're looking for?", then the
// search runs on the same page and the user lands on Today.
//
// A static segment, so it wins over /onboarding/[step]. It is a screen of the
// web only, not a server stage: the stage machine is unchanged, and the
// component saves its steps in the server's order.
//
// RoboApply only. GoApply's setup has consent and identity steps the law
// requires, so this route does not exist there (a 404, like /onboarding/goal).
// Who is sent here, and who is sent on from here, is decided in the browser
// from GET /onboarding/state (components/features/onboarding/flow.ts).
// Renders inside the (onboarding) layout.

import { notFound } from 'next/navigation';

import { ExpressOnboarding } from '../../../../components/features/onboarding';
import { getServerBrandId } from '../../../../lib/server/brand';

export default async function OnboardingStartRoute() {
  if ((await getServerBrandId()) !== 'roboapply') notFound();
  return <ExpressOnboarding />;
}
