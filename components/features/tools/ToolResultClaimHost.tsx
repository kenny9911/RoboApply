'use client';

// ToolResultClaimHost — keeps the resume from a visitor's free check in the
// account they just created or signed in to (WP-57; acceptance "signup
// carries from=resume-check and the result id"). Renders nothing.
//
// It claims only a result the visitor explicitly asked to keep: the entry is
// written when they click the signup / sign-in link under their report, in
// this tab only, and is valid for 30 minutes (./pendingResult.ts). It is read
// once and cleared before the claim, so a later sign-in on the same browser
// never picks it up. A signed-in user who ran a check and did not press
// "Keep it" has no entry. Mount it once inside the signed-in shell (INT
// request). No session or no entry → no request.

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import { useAuth } from '../../../lib/auth/useAuth';
import { claimToolResult } from '../../../lib/api/tools';
import { toast } from '../../v3/primitives';
import { takePendingResult } from './pendingResult';

export function ToolResultClaimHost() {
  const t = useTranslations('tools');
  const { status } = useAuth();
  const started = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated' || started.current) return;
    started.current = true;
    const pending = takePendingResult();
    if (!pending) return;
    claimToolResult(pending.id)
      .then(() => toast({ message: t('claim.done'), tone: 'ok' }))
      .catch(() => {
        // Expired, unknown, from another browser, or a full resume list: the
        // tool page (`next=/tools/<slug>`) still shows the result with the reason.
      });
  }, [status, t]);

  return null;
}
