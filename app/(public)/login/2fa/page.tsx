// /login/2fa — the second step of signing in (WP-79). A sign-in route
// (password, password reset, email link, Google / LINE, phone code, WeChat)
// answered `two_factor_required` and set the httpOnly challenge cookie; the
// card asks for the authenticator code or a recovery code.

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { TwoFactorChallenge } from '../../../../components/features/account-v2';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function LoginTwoFactorPage() {
  return (
    <Suspense fallback={null}>
      <TwoFactorChallenge />
    </Suspense>
  );
}
