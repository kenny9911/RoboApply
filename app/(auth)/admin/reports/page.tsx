// /admin/reports — "Reports to review": job reports and scam signals, GoApply
// referral codes, personal-data requests (WP-74; PRODUCT F-TRUST-04).
// Admin only: the console checks the role and every API route enforces it.

import { ReportsConsole } from '../../../../components/v3/admin';

export default function AdminReportsPage() {
  return <ReportsConsole />;
}
