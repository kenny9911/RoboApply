// /auth/callback/wechat — route shell (FND-6b). WeChat sign-in return.
//
// STUB. Owner: WP-11, who replaces this page. No shell: a transitional page.
// Nothing links here until the owner ships and INT flips the entry.

import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthCallbackWechatPage() {
  return <div hidden data-route-stub="/auth/callback/wechat" data-owner="WP-11" />;
}
