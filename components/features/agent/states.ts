// components/features/agent/states.ts — how each kit state is named and
// coloured (R-19 states; PRODUCT F-AGENT-05). Only real states are shown:
// there is no "submitted" state and no progress claim beyond them (D1).

import type { PillTone } from '../../v3/primitives';
import type { QueueState } from '../../../lib/api/contracts/agent';

export const STATE_TONE: Record<QueueState, PillTone> = {
  picked: 'muted',
  preparing: 'violet',
  ready_for_review: 'accent',
  approved: 'accent',
  opened: 'ok',
  applied: 'ok',
  skipped: 'muted',
  expired: 'warn',
  failed: 'warn',
};

/** Path of the kit review page for a job. */
export function kitHref(jobId: string): string {
  return `/ready/${encodeURIComponent(jobId)}`;
}

export const SETUP_HREF = '/ready/setup';

/** Setup at one step (`#answers` is the anchor the profile links to). */
export function setupStepHref(step: 'profile' | 'calibrate' | 'answers' | 'weekly' | 'extension'): string {
  return `${SETUP_HREF}#${step}`;
}

/** The application in the tracker. */
export function applicationHref(trackerEntryId: string | null): string {
  return trackerEntryId ? `/applications?entry=${encodeURIComponent(trackerEntryId)}` : '/applications';
}
