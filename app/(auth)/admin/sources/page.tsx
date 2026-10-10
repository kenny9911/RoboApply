// /admin/sources — company job boards read through their public posting APIs
// (TASK_PLAN.md WP-42). Renders inside the (auth) app shell; the API is
// admin-only and the panel shows a not-authorized state to everyone else.

import { CareerSourcesPanel } from '../../../../components/features/market/tw';

export default function AdminSourcesPage() {
  return <CareerSourcesPanel />;
}
