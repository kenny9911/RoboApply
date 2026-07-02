// Layout for the public auth-entry pages (login / signup). A consumer-facing
// split screen: a brand + value-prop hero on the left (desktop only) and the
// form card on the right. All visuals live in styles/auth.css (.auth-*), built
// on the V3 bare tokens so dark/light tracks automatically.

import type { ReactNode } from 'react';
import { AuthBrandPanel } from '../../components/auth/AuthShell';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-split">
      <AuthBrandPanel />
      <div className="auth-pane">{children}</div>
    </div>
  );
}
