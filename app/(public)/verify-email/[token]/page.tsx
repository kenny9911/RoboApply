// /verify-email/[token] — confirm an email address (WP-10; F-ACCT-02), or
// finish a LINE sign-up that needed a confirmed email.

import type { Metadata } from 'next';
import { VerifyEmailView } from '../../../../components/features/auth/VerifyEmailView';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function VerifyEmailTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VerifyEmailView token={token} />;
}
