'use client';

// PhoneMethod — GoApply sign-in/sign-up with a +86 phone number and an SMS
// code (PRODUCT_PLAN.md §4.5 G0; TASK_PLAN.md WP-11).
//
// STUB (FND-6b). Owner: WP-11. Renders nothing. Rendered by login/signup
// through components/auth/methods/registry.ts (`phone_otp`) only when the
// `auth.phoneOtp` capability is on, so a missing SMS provider never shows a
// dead form.

import type { AuthMethodProps } from '../../auth/methods/registry';

export function PhoneMethod(_props: AuthMethodProps): null {
  return null;
}

export default PhoneMethod;
