// /admin/sources — where this site's jobs come from (GOAPPLY_PARITY_PLAN.md §3.9)
// and the company job boards read through their public posting APIs
// (TASK_PLAN.md WP-42). Both brands, each showing its own sources: RoboApply
// keeps its company-boards panel as it was, followed by the shared job
// sources panel; GoApply gets the sources panel and its own boards.
// Renders inside the (auth) app shell; the API is admin-only and the panels
// show a not-authorized state to everyone else.

import { CareerSourcesPanel } from '../../../../components/features/market/tw';
import { SourcesConsole } from '../../../../components/v3/admin';

export default function AdminSourcesPage() {
  return <SourcesConsole intlBoards={<CareerSourcesPanel />} />;
}
