// Layout for the public auth-entry pages (login, signup, password reset,
// email confirmation, bind-phone). A consumer-facing split screen: a brand +
// value-prop panel on the left (desktop only) and the form card on the
// right. Visuals live in styles/auth.css (.auth-*) and
// components/features/auth/auth.module.css, built on the Clarity tokens so
// dark/light and both brands track automatically. The brand panel reads the
// entry query (`from`, `action`, `job`), hence the Suspense boundary.

import { Suspense, type ReactNode } from 'react';
import { AuthBrandPanel, AuthUtilities } from '../../components/auth/AuthShell';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-split">
      <Suspense fallback={null}>
        <AuthBrandPanel />
      </Suspense>
      <div className="auth-pane">
        <AuthUtilities />
        {children}
      </div>
    </div>
  );
}
