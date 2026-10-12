// server/src/features/tracker/stages.ts — the stage ladder per market and the
// rules that validate a status / stage-detail write (WP-38).
//
// RoboApply follows ruling C1: Saved · Applied · First call · Interviewing ·
// Final round · Offer · Rejected. GoApply follows the cn ladder
// (features/cn/tracker). Both accept the terminal `withdrawn` / `closed`
// (outcome control) and the pre-clone legacy statuses, so old rows and old
// clients keep working.

import { CN_TRACKER_LADDER, isCnStageDetail } from '../cn/tracker/index.js';
import {
  LEGACY_TRACKER_STATUSES,
  OUTCOME_STATUS,
  TERMINAL_STATUSES,
  type TrackerOutcome,
  type TrackerStatus,
} from './contract.js';

export type TrackerMarket = 'intl' | 'cn';

export const INTL_TRACKER_LADDER = [
  'bookmarked',
  'applied',
  'first_call',
  'interviewing',
  'final_round',
  'offer',
  'rejected',
] as const satisfies readonly TrackerStatus[];

export function ladderFor(market: TrackerMarket): readonly TrackerStatus[] {
  return market === 'cn' ? CN_TRACKER_LADDER : INTL_TRACKER_LADDER;
}

/** Every status a user of this market may write. */
export function allowedStatuses(market: TrackerMarket): ReadonlySet<TrackerStatus> {
  return new Set<TrackerStatus>([...ladderFor(market), ...TERMINAL_STATUSES, ...LEGACY_TRACKER_STATUSES]);
}

export function isStatusAllowed(market: TrackerMarket, status: string): status is TrackerStatus {
  return allowedStatuses(market).has(status as TrackerStatus);
}

/**
 * Stage detail rules: on GoApply only the interview rounds (一面 / 二面 / HR面)
 * at `interviewing`; on RoboApply a short free label (e.g. "Panel") on any
 * non-terminal status.
 */
export function isStageDetailAllowed(market: TrackerMarket, status: string, detail: string | null): boolean {
  if (detail === null) return true;
  if (market === 'cn') return isCnStageDetail(status, detail);
  return !(TERMINAL_STATUSES as readonly string[]).includes(status) && detail.length > 0 && detail.length <= 60;
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The outcome implied by a terminal status (null for non-terminal statuses). */
export function outcomeForStatus(status: string): TrackerOutcome | null {
  for (const [outcome, s] of Object.entries(OUTCOME_STATUS) as Array<[TrackerOutcome, TrackerStatus]>) {
    if (s === status) return outcome;
  }
  return null;
}
