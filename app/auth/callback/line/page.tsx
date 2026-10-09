// /auth/callback/line — route shell (FND-6b). LINE sign-in return (V2, hidden until configured).
//
// STUB. Owner: WP-10, who replaces this page. No shell: a transitional page.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthCallbackLinePage() {
  return <div hidden data-route-stub="/auth/callback/line" data-owner="WP-10" />;
}
