// /admin/visitors — who came to the site, where from, and how many created an
// account (visitor conversion; the visitor records of server
// features/growth/visitors.ts).
// Admin only: the console checks the role and every API route enforces it.

import { VisitorsConsole } from '../../../../components/v3/admin';

export default function AdminVisitorsPage() {
  return <VisitorsConsole />;
}
