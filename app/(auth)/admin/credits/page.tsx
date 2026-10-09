// /admin/credits — credit limits per brand and plan, per-user overrides, the
// Taiwan reference rate and the Taiwan revenue monitor (WP-21b UI over
// WP-21a's admin API). Admin only; the console checks the role and the API
// enforces it.

import { AdminCreditsConsole } from '../../../../components/features/credits';

export default function AdminCreditsPage() {
  return <AdminCreditsConsole />;
}
