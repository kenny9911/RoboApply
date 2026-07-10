// /choose-plan is a top-level route (outside the (auth) shell — chromeless
// post-signup moment), so it does not inherit the shell's AuthGate. The edge
// proxy only checks that the session cookie EXISTS; a dead session (revoked/
// expired row) would otherwise render the page with every API call 401ing.
// Safe for the signup → /choose-plan handoff: the signup page `await
// refresh()`es the auth context before navigating, so the gate sees
// `authenticated`.

import type { ReactNode } from 'react';
import { AuthGate } from '../../components/AuthGate';

export default function ChoosePlanLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
