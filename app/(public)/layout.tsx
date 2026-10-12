// Layout for the public auth-entry pages (login, signup, password reset,
// email confirmation, bind-phone). A consumer-facing split screen: a brand +
// value-prop panel on the left (desktop only) and the form card on the
// right. Visuals live in styles/auth.css (.auth-*) and
// components/features/auth/auth.module.css, built on the Clarity tokens so
// dark/light and both brands track automatically. The brand panel reads the
// entry query (`from`, `action`, `job`), hence the Suspense boundary.
//
// Under the card the pane keeps room for the analytics consent banner while
// it is open (one column; zero height otherwise), so the banner never covers
// the card's last link ("Already have an account? Sign in").

import { Suspense, type ReactNode } from 'react';
import { AuthBrandPanel, AuthUtilities } from '../../components/auth/AuthShell';
import styles from '../../components/features/auth/auth.module.css';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-split">
      <Suspense fallback={null}>
        <AuthBrandPanel />
      </Suspense>
      <div className="auth-pane">
        <AuthUtilities />
        {children}
        <div className={styles.consentReserve} aria-hidden="true" data-consent-reserve="" />
      </div>
    </div>
  );
}
