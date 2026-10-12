'use client';

// GoogleMethod — "Continue with Google" (RoboApply; PRODUCT_PLAN.md O0 row 2,
// F-ACCT-01). Rendered by login/signup through components/auth/methods/
// registry.ts only when `auth.google` is on (credentials configured), so a
// missing client id never shows a dead button. New Google users skip the
// password and the verification email: Google verified the address.

import type { AuthMethodProps } from './registry';
import { OAuthButton } from './OAuthButton';

export function GoogleMethod({ mode, next }: AuthMethodProps) {
  return <OAuthButton provider="google" mode={mode} next={next} />;
}

export default GoogleMethod;
