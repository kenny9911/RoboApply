// /invite — invite friends (PRODUCT_PLAN.md F-GROW-01; TASK_PLAN.md WP-60;
// flag `invites`). Renders inside the (auth) app shell; the proxy requires a
// session. The page content is a client component (it reads the person's link
// and progress); with the capability off it says invites are not available.

import type { Metadata } from 'next';

import { InviteFriends } from '../../../components/features/growth';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function InvitePage() {
  return <InviteFriends />;
}
