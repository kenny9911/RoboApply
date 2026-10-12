// /admin/invites — GoApply invite codes for the invite-only beta (TASK_PLAN.md
// WP-11). Renders inside the (auth) app shell; the API is admin-only and the
// page shows a not-authorized state to everyone else.

import { AdminInvites } from '../../../../components/features/auth-cn';

export default function AdminInvitesPage() {
  return <AdminInvites />;
}
