// /activity — legacy route. The activity log is now the second tab of the
// Tracker page (/tracker/activity). Kept as a permanent redirect so old links,
// bookmarks, and the /auth/me deep-links still resolve.

import { redirect } from 'next/navigation';

export default function ActivityRedirect() {
  redirect('/tracker/activity');
}
