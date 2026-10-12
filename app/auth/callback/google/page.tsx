// /auth/callback/google — the OAuth redirect URI for Google sign-in (WP-10). No
// app shell: a transitional page that finishes the sign-in through the API
// and moves on (or asks for the signup agreements / an email first).

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { OAuthCallbackView } from '../../../../components/features/auth/OAuthCallbackView';

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default function AuthCallbackGooglePage() {
  return (
    <Suspense fallback={null}>
      <OAuthCallbackView provider="google" />
    </Suspense>
  );
}
