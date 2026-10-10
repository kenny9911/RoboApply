// /admin/reports/invites — invite rewards held for review (WP-60's risk
// check; INT-08). Approve gives the practice credits that are due (the friend's,
// and the inviter's unless they are at the yearly limit); reject means the
// invite does not count. Admin only: the console checks the role and every
// API route enforces it.

import { InviteRewardsConsole } from '../../../../../components/v3/admin';

export default function AdminInviteRewardsPage() {
  return <InviteRewardsConsole />;
}
