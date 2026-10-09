// /reset-password/[token] — choose a new password from a reset link (WP-10).
// The link works once, for 30 minutes; saving signs out every other session.

import type { Metadata } from 'next';
import { ResetPasswordView } from '../../../../components/features/auth/PasswordResetViews';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function ResetPasswordTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ResetPasswordView token={token} />;
}
