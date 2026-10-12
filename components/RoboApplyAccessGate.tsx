'use client';

// Gates the authenticated seeker shell by role (WP-10).
//
// Only a CONFIRMED recruiter account (role user/internal/agency/sales/
// customer_success, lib/roles.ts) is sent to the RoboHire recruiter site's
// /job-seeker bridge, with a localized line saying why. Seekers ('seeker'),
// GoHire candidates ('candidate') and admins pass straight through, on both
// brands — a seeker is never bounced, and nothing is decided while auth is
// still `loading` (pages render eagerly; see AuthProvider).

import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../lib/auth/AuthProvider';
import { isRecruiterRole } from '../lib/roles';
import { getRoboHireUrl } from '../lib/config';
import { useOptionalTranslations } from '../lib/auth/optionalTranslations';

/** The recruiter product's name; a source/product name, not this app's brand. */
const RECRUITER_SITE = 'RoboHire';

export function RoboApplyAccessGate({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const t = useOptionalTranslations('auth');
  const blocked = status === 'authenticated' && isRecruiterRole(user?.role);

  useEffect(() => {
    if (blocked) window.location.replace(getRoboHireUrl('/job-seeker'));
  }, [blocked]);

  if (blocked) {
    const line = t('gate.redirecting', `This app is for job seekers. Redirecting you to ${RECRUITER_SITE}…`, { site: RECRUITER_SITE });
    return (
      <div
        role="status"
        style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}
        className="flex min-h-screen items-center justify-center px-6 text-center text-sm"
      >
        {line}
      </div>
    );
  }

  return <>{children}</>;
}
