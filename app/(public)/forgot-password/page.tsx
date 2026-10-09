// /forgot-password — route shell (FND-6b). Request a password reset link.
//
// STUB. Owner: WP-10, who replaces this page. Renders inside the (public) sign-in layout.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  return <div hidden data-route-stub="/forgot-password" data-owner="WP-10" />;
}
