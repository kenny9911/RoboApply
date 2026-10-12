// /login — sign in (WP-10). The card is components/features/auth/AuthEntryView:
// the brand's configured methods, the in-app browser guard, contextual title,
// carried query parameters, the cross-brand notice and sign-in routing to the
// unfinished onboarding screen (or `next`, or /jobs).

import { Suspense } from 'react';
import { AuthEntryView } from '../../../components/features/auth/AuthEntryView';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <AuthEntryView mode="login" />
    </Suspense>
  );
}
