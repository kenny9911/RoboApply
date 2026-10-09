// /bind-phone — route shell (FND-6b). GoApply: bind a phone number after WeChat sign-in.
//
// STUB. Owner: WP-11, who replaces this page. Renders inside the (public) sign-in layout.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function BindPhonePage() {
  return <div hidden data-route-stub="/bind-phone" data-owner="WP-11" />;
}
