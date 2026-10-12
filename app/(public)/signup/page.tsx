// /signup — create an account (WP-10; PRODUCT_PLAN.md O0). Stage `account`:
// on success the account sits at onboarding stage 'account' and the visitor
// continues to the first onboarding screen. Agreements: marketing unchecked,
// "I'm 16 or older" required, the PDPA notice for zh-TW / Taiwan visitors.

import { Suspense } from 'react';
import { AuthEntryView } from '../../../components/features/auth/AuthEntryView';

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <AuthEntryView mode="signup" />
    </Suspense>
  );
}
