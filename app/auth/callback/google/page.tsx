// /auth/callback/google — route shell (FND-6b). Google sign-in return.
//
// STUB. Owner: WP-10, who replaces this page. No shell: a transitional page.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthCallbackGooglePage() {
  return <div hidden data-route-stub="/auth/callback/google" data-owner="WP-10" />;
}
