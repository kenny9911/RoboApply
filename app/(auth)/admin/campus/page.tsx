// /admin/campus — 校招日历 curation: official sources only, a person checks
// every entry before it is published (WP-58). Admin only; the console checks
// the role and the API enforces it.

import { CampusAdmin } from '../../../../components/features/campus';

export default function AdminCampusPage() {
  return <CampusAdmin />;
}
