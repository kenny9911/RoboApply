// components/v3/pipeline/columns.ts
//
// The /applications board column model — the single place the
// `RATrackerStatus` → column mapping is defined. Each column is keyed by ONE
// canonical status so a drag target writes an unambiguous
// `tracker.patch({ status })`; additional statuses fold into a column for
// display + counts only (e.g. `applying` shows under Applied, `accepted`
// under Offer).
//
// COPY: `labelKey` resolves under `applications.columns.*`. Ruling C1 fixes
// the user-facing ladder at seven rungs — Saved · Applied · First call ·
// Interviewing · Final round · Offer · Rejected — and en.json carries all
// seven today. Only four render, because `RATrackerStatus` has no
// `first_call` / `final_round` member yet; adding them is the data change
// C32 enumerates (RATrackerService ALL_STATUSES, routes/tracker VALID_STATUSES,
// lib/api/v2/types, this file, lib/stub/raV2.stub).
//
// Terminal statuses (`rejected`, `withdrawn`) are NOT shown on the board — the
// board tracks jobs still in progress, matching the "N in progress" eyebrow.
// They're still counted out of the board total.

import type { RATrackerStatus } from '../../../lib/api/v2';

/** A board column: a canonical drop status + the statuses it displays. */
export interface PipelineColumnDef {
  /** Stable key + the status written when a card is dropped here. */
  status: RATrackerStatus;
  /** i18n key suffix under `applications.columns.*`. */
  labelKey: string;
  /** Tone class appended to `.pipe-head` (drives the accent hairline/color). */
  tone: '' | 'accent' | 'violet' | 'warn';
  /** All statuses that render in this column (includes `status`). */
  members: RATrackerStatus[];
}

export const PIPELINE_COLUMNS: PipelineColumnDef[] = [
  { status: 'bookmarked', labelKey: 'saved', tone: 'warn', members: ['bookmarked'] },
  {
    status: 'applied',
    labelKey: 'applied',
    tone: '',
    members: ['applying', 'applied'],
  },
  {
    status: 'interviewing',
    labelKey: 'interviewing',
    tone: 'accent',
    members: ['interviewing'],
  },
  {
    status: 'negotiating',
    labelKey: 'offer',
    tone: 'violet',
    members: ['negotiating', 'accepted'],
  },
];

/** Statuses that never appear on the board (terminal). */
export const HIDDEN_STATUSES: ReadonlySet<RATrackerStatus> = new Set([
  'rejected',
  'withdrawn',
]);

/** Build a `status → column index` lookup once for O(1) bucketing. */
const STATUS_TO_COLUMN: Partial<Record<RATrackerStatus, number>> = (() => {
  const map: Partial<Record<RATrackerStatus, number>> = {};
  PIPELINE_COLUMNS.forEach((col, idx) => {
    for (const m of col.members) map[m] = idx;
  });
  return map;
})();

/** The column index a status belongs to, or `null` if hidden/unmapped. */
export function columnIndexForStatus(status: RATrackerStatus): number | null {
  const idx = STATUS_TO_COLUMN[status];
  return idx === undefined ? null : idx;
}
