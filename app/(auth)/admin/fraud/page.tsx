// /admin/fraud — 可疑职位待审核 / "Suspicious jobs to review": GoApply job
// fraud review and the employer block list (WP-41; CN-E-08). Admin only; the
// console checks the role and the API enforces it.

import { FraudQueue } from '../../../../components/features/market/cn';

export default function AdminFraudPage() {
  return <FraudQueue />;
}
