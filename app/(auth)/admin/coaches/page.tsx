// /admin/coaches — the coach list for both sites (WP-72). Admin only; the
// console checks the role and the API enforces it. Renders inside the (auth)
// app shell.

import { AdminCoachesConsole } from '../../../../components/features/coaching';

export default function AdminCoachesPage() {
  return <AdminCoachesConsole />;
}
