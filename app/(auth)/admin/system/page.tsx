// /admin/system — platform health, cost by SKU × brand × day, Assistant
// feedback and GoApply content safety (WP-74; ARCHITECTURE.md §10.4).
// Admin only: the console checks the role and every API route enforces it.

import { SystemConsole } from '../../../../components/v3/admin';

export default function AdminSystemPage() {
  return <SystemConsole />;
}
