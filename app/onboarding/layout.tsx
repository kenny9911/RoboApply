// /onboarding stays OUTSIDE the (auth) route group (fullscreen overlay — no
// Sidebar/Topbar), so it does not inherit the shell's AuthGate. The edge
// proxy alone is not enough here: it only checks that the session cookie
// EXISTS, so a browser with a dead session (row revoked/expired — e.g. the
// 2026-07 DB split invalidated every earlier session) lands on the page and
// every API call 401s — the chat never bootstraps and resume uploads surface
// as parse failures. The gate turns that into an immediate
// /login?next=/onboarding bounce once /auth/me resolves unauthenticated.

import type { ReactNode } from 'react';
import { AuthGate } from '../../components/AuthGate';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
