'use client';

// GoogleMethod — Continue with Google (RoboApply)
// (PRODUCT_PLAN.md F-ACCT-01; TASK_PLAN.md WP-10).
//
// STUB (FND repair, Wave 1). Owner: WP-10. Renders nothing. Rendered by
// login/signup through components/auth/methods/registry.ts (`google`)
// only when the method's capability is on, so a method whose keys are
// missing never shows a dead button. A redirect method starts its OAuth round
// trip at `startUrl` (GET /auth/methods).

import type { AuthMethodProps } from './registry';

export function GoogleMethod(_props: AuthMethodProps): null {
  return null;
}

export default GoogleMethod;
