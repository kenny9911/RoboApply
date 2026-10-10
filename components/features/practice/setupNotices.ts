// setupNotices — which one-line notices /practice shows (pure; WP-43).

import type { PracticeFirstState, PracticeSetup } from '../../../lib/api/interviewEngine';
import type { PracticeNoticeKind } from './PracticeNotices';

export interface SetupNoticeInput {
  /** Server setup state, or null while unknown (nothing is claimed then). */
  setup: PracticeSetup | null;
  /** The ?job= id answered 404. */
  jobNotFound: boolean;
  /** The credit balance is known and does not cover this practice. */
  creditsShort: boolean;
  /** The first-practice state carried by a 402, if the last Start returned one. */
  firstPracticeFrom402?: PracticeFirstState | null;
}

export function setupNotices({ setup, jobNotFound, creditsShort, firstPracticeFrom402 }: SetupNoticeInput): PracticeNoticeKind[] {
  const out: PracticeNoticeKind[] = [];
  if (jobNotFound) out.push('jobNotFound');
  if (setup) {
    if (setup.ai.reason === 'phone_binding_required') out.push('gatePhone');
    else if (setup.ai.reason === 'ai_consent_required') out.push('gateConsent');
    else if (!setup.voice.available && setup.voice.reason === 'voice_unavailable') out.push('voiceUnavailable');
  }
  // C42: the free first practice is waiting on verification — say how to get
  // it only when the user is actually short of credits.
  const first = firstPracticeFrom402 ?? setup?.firstPractice ?? null;
  if (first && !first.verified && (creditsShort || firstPracticeFrom402)) {
    const kind: PracticeNoticeKind = first.method === 'phone' ? 'firstPhone' : 'firstEmail';
    // One phone prompt is enough.
    if (!(kind === 'firstPhone' && out.includes('gatePhone'))) out.push(kind);
  }
  return out;
}
