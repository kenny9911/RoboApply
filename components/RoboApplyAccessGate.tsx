'use client';

// Gates the authenticated RoboApply shell by RoboHire role.
//
// RoboHire recruiters (user/internal/agency) share the session_token cookie
// with RoboApply (COOKIE_DOMAIN=.robohire.io) and so can reach this app, but
// the candidate product is not for them — they're full-page redirected to the
// robohire.io/job-seeker bridge (where they're told to make a separate
// candidate account with a different email). Job-seekers ('seeker'), GoHire
// candidates ('candidate'), and admins pass through untouched.
//
// We deliberately do NOT block during the initial `loading` window — pages
// render eagerly (see AuthProvider) and only a CONFIRMED recruiter is bounced,
// so legit users never see a gating spinner.

import { useEffect, type ReactNode } from 'react';
import { useAuth } from '../lib/auth/AuthProvider';
import { isRecruiterRole } from '../lib/roles';
import { getRoboHireUrl } from '../lib/config';

export function RoboApplyAccessGate({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const blocked = status === 'authenticated' && isRecruiterRole(user?.role);

  useEffect(() => {
    if (blocked) window.location.replace(getRoboHireUrl('/job-seeker'));
  }, [blocked]);

  if (blocked) {
    return (
      <div
        style={{ background: 'var(--bg)', color: 'var(--muted)' }}
        className="flex min-h-screen items-center justify-center px-6 text-center text-sm"
      >
        Redirecting you to RoboHire…
      </div>
    );
  }

  return <>{children}</>;
}
