'use client';

// EmailMethod — Email + password sign-in and sign-up (the existing method; works on both brands, GoApply's fallback)
// (PRODUCT_PLAN.md F-ACCT-01; TASK_PLAN.md WP-10).
//
// STUB (FND repair, Wave 1). Owner: WP-10. Renders nothing. Rendered by
// login/signup through components/auth/methods/registry.ts (`email_password`, form)
// only when the method's capability is on, so a method whose keys are
// missing never shows a dead button.

import type { AuthMethodProps } from './registry';

export function EmailMethod(_props: AuthMethodProps): null {
  return null;
}

export default EmailMethod;
