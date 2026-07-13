// /plans — legacy route. Plans now live inside the unified Account area as the
// "Plans / Upgrade" tab (/account/plans). Kept as a permanent redirect so old
// links, bookmarks, and any in-flight checkout return paths still resolve.

import { redirect } from 'next/navigation';

export default function PlansRedirect() {
  redirect('/account/plans');
}
