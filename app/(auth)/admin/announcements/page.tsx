// /admin/announcements — "What's new" announcements per site, language and
// audience (WP-61; F-NOTIF-09). Admin only; the console checks the role and
// the API enforces it. Renders inside the (auth) app shell.

import { AnnouncementsAdmin } from './AnnouncementsAdmin';

export default function AdminAnnouncementsPage() {
  return <AnnouncementsAdmin />;
}
