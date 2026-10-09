// /verify-email/[token] — route shell (FND-6b). Email verification link.
//
// STUB. Owner: WP-10, who replaces this page. Renders inside the (public) sign-in layout.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function VerifyEmailTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <div hidden data-route-stub="/verify-email/[token]" data-owner="WP-10" data-param={token} />;
}
