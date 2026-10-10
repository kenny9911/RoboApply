'use client';

// hooks/copilot/useServerNudge.ts — ask the server which proactive nudge holds
// (WP-93 #1; F-ORION-08).
//
// `GET /copilot/nudge` derives at most one nudge from the user's real signals
// (a low feed rating in the last week, a job they reported while agency posts
// show, no minimum pay while many posts in their search list pay, a followed
// GoApply 网申 deadline within a week). The rail calls this hook; it asks on
// mount and again when the route changes, while a nudge could still be shown:
//   - `enabled` (the floating Ask button is on screen for a user who may ask);
//   - no nudge was shown this session and none is waiting.
// The answer's `kind` goes to `offerAssistantNudge({ kind })`, which the rail
// shows through the popup gate. `NudgeView.prompt` (debug English) is never
// read here: the chip and the composer text come from the i18n keys of the
// kind, so every user sees and sends text in their own language.
//
// A failed or empty answer offers nothing (no nudge is ever invented).

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getNudge } from '../../lib/api/copilot';
import { isNudgeKind, nudgeSessionShown, offerAssistantNudge, usePendingNudge } from './nudges';

export const NUDGE_QUERY_KEY = ['copilot', 'nudge'] as const;
/** The signals change slowly: one read per route at most every five minutes. */
const STALE_MS = 5 * 60_000;

export interface ServerNudgeOptions {
  /** The rail could show a nudge now (Ask is offered and the rail is closed). */
  enabled: boolean;
  /** The current route: a change asks again (once per route, cached for five minutes). */
  route: string;
}

export function useServerNudge({ enabled, route }: ServerNudgeOptions): void {
  const pending = usePendingNudge();
  const wanted = enabled && !pending && !nudgeSessionShown();
  const query = useQuery({
    queryKey: [...NUDGE_QUERY_KEY, route],
    queryFn: ({ signal }) => getNudge({ signal }),
    enabled: wanted,
    staleTime: STALE_MS,
    retry: false,
  });
  const kind = query.data?.nudge?.kind;
  useEffect(() => {
    if (!wanted || !isNudgeKind(kind)) return;
    offerAssistantNudge({ kind });
  }, [wanted, kind]);
}
