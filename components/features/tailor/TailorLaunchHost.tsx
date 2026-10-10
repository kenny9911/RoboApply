'use client';

// TailorLaunchHost — runs the tailor flow from the URL (WP-36a). It implements
// the route contract of hooks/shared/useLaunchTailor:
//
//   /resume?tailor=<jobId>                 pick a base resume, then tailor
//   /resume/<resumeId>?tailor=<jobId>      tailor that resume for the job
//   …&tailorSession=<sessionId>            re-open a session (Verify details)
//   ?tailorSession=<sessionId>             re-open a session on its own (a pasted
//                                          posting has no job); the session's own
//                                          base resume is used, no picker
//
// Mount it once on the resume hub and the resume page (WP-36b owns those
// routes): `<TailorLaunchHost resumeId={params.id} />`. Closing removes the
// query parameters; "Open this resume" goes to /resume/<resultVariantId>.

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { TailorSheet } from './TailorSheet';

export const TAILOR_QUERY = 'tailor';
export const TAILOR_SESSION_QUERY = 'tailorSession';

export interface TailorLaunchHostProps {
  /** The resume of the current page, when there is one. */
  resumeId?: string | null;
}

export function TailorLaunchHost({ resumeId = null }: TailorLaunchHostProps) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const jobId = params?.get(TAILOR_QUERY)?.trim() || null;
  const sessionId = params?.get(TAILOR_SESSION_QUERY)?.trim() || null;

  const close = useCallback(() => {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.delete(TAILOR_QUERY);
    next.delete(TAILOR_SESSION_QUERY);
    next.delete('from');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [params, pathname, router]);

  if (!jobId && !sessionId) return null;
  return (
    <TailorSheet
      key={`${jobId}:${resumeId ?? ''}:${sessionId ?? ''}`}
      open
      onClose={close}
      jobId={jobId}
      resumeId={resumeId}
      sessionId={sessionId}
      onOpenResume={(id) => router.push(`/resume/${encodeURIComponent(id)}`)}
    />
  );
}
