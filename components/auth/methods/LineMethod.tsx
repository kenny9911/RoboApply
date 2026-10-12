'use client';

// LineMethod — "Continue with LINE" (RoboApply, Taiwan; TW-05, CN plan
// WP-AUTH-CORE). Shown only when `auth.line` is on (LINE Login channel
// configured) and listed first for zh-TW visitors and visitors from Taiwan.
// When LINE shares no email, the callback page asks for one and the account
// is created only after that email is confirmed.

import type { AuthMethodProps } from './registry';
import { OAuthButton } from './OAuthButton';

export function LineMethod({ mode, next }: AuthMethodProps) {
  return <OAuthButton provider="line" mode={mode} next={next} />;
}

export default LineMethod;
