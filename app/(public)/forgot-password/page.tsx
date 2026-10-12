// /forgot-password — request a password reset link (WP-10; F-ACCT-02).
// Renders inside the (public) sign-in layout. Never reveals whether an email
// has an account.

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ForgotPasswordView } from '../../../components/features/auth/PasswordResetViews';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordView />
    </Suspense>
  );
}
