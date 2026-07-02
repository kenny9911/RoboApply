'use client';

// JobApplyingGate — route guard for the JOB_APPLYING_ENABLED master switch.
//
// When job-applying is OFF, the auto-apply surfaces (Today /home, Review queue
// /queue, Pipeline /tracker, Activity log /activity) are hidden from the nav —
// this gate is the matching URL-level guard so a direct link or bookmark to one
// of those routes redirects to the product home (Mock Interview) instead of
// rendering a hidden screen.
//
// Loading-tolerant (mirrors ResumeGate / RoboApplyAccessGate): while the flag
// is still unknown (`null`, /auth/me in flight) we render the route's spinner
// rather than its content, and only commit to rendering or redirecting once we
// KNOW the flag value — so an enabled deploy never bounces a valid page and a
// disabled deploy never flashes a hidden one.

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth/AuthProvider';
import {
  isJobApplyRoute,
  isQueueRoute,
  JOB_APPLY_OFF_LANDING,
  QUEUE_REVIEW_ENABLED,
  useJobApplyingEnabled,
} from '../lib/jobApplying';

export function JobApplyingGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { status } = useAuth();
  const enabled = useJobApplyingEnabled();

  const onHiddenRoute = isJobApplyRoute(pathname);
  // Block (and redirect) only when we positively know the flag is OFF.
  const blocking = enabled === false && onHiddenRoute;
  // /queue is additionally hidden for launch (QUEUE_REVIEW_ENABLED). When the
  // master switch is OFF `blocking` wins (→ /mock-interview, unchanged); when
  // it's ON, direct hits/bookmarks to /queue bounce to /home instead.
  const queueBlocked =
    !QUEUE_REVIEW_ENABLED && enabled === true && isQueueRoute(pathname);
  // Hold rendering on a hidden route ONLY while the session is still resolving
  // (status === 'loading'), so a disabled deploy never flashes Today/Queue/
  // Pipeline/Activity before redirecting. Once auth has resolved, `enabled` is
  // a real boolean for authenticated users; an UNauthenticated user is handled
  // by AuthGate (redirect to /login). `enabled` is also null when the session
  // was cleared — we must NOT hold then, or the route hangs on a spinner
  // forever (the blank-page bug). Gate on `status` so null-while-loading holds
  // but null-while-unauthenticated does not.
  const holding = onHiddenRoute && enabled === null && status === 'loading';

  useEffect(() => {
    if (blocking) router.replace(JOB_APPLY_OFF_LANDING);
    else if (queueBlocked) router.replace('/home');
  }, [blocking, queueBlocked, router]);

  if (blocking || queueBlocked || holding) {
    return (
      <div
        className="dark-canvas v3-root"
        style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}
      >
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  return <>{children}</>;
}
