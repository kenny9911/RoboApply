// /admin/questions — practice-question moderation (WP-59): questions users
// shared (checked before they show), reported and hidden questions, and
// staff-written general questions. Admin only; the console checks the role
// and the API enforces it.

import { AdminQuestionsConsole } from '../../../../components/features/prep';

export default function AdminQuestionsPage() {
  return <AdminQuestionsConsole />;
}
