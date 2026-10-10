// components/v3/pipeline/columns.ts
//
// The /applications "By stage" column model — the single place the tracker
// status → column mapping is defined on the web. Each column is keyed by ONE
// canonical status so a drop (or the card's stage menu) writes an
// unambiguous `{ status }`; other statuses fold into a column for display and
// counts only (legacy `applying` under Applied, `negotiating`/`accepted`
// under Offer, `withdrawn`/`closed` under the last column, whose cards say
// who ended it).
//
// Ladders (WP-38; must match server/src/features/tracker/stages.ts and
// features/cn/tracker/ladder.ts — __tests__ parity test):
//   RoboApply (ruling C1): Saved · Applied · First call · Interviewing ·
//     Final round · Offer · Rejected
//   GoApply: 收藏 · 网申 · 测评 · 笔试 · AI面试 · 面试 · Offer · 三方 · 未通过
//
// COPY: `labelKey` resolves under `applications.columns.*`.

import type { TrackerStatus } from '../../../lib/api/contracts/tracker';

export type TrackerMarket = 'intl' | 'cn';

/** A board column: a canonical drop status + the statuses it displays. */
export interface PipelineColumnDef {
  /** Stable key + the status written when a card is dropped here. */
  status: TrackerStatus;
  /** i18n key suffix under `applications.columns.*` (and `applications.empty.*`). */
  labelKey: string;
  /** Tone class appended to `.pipe-head` (drives the accent hairline/color). */
  tone: '' | 'accent' | 'violet' | 'warn';
  /** All statuses that render in this column (includes `status`). */
  members: TrackerStatus[];
  /** The application has ended (the last column). */
  terminal?: boolean;
}

const SAVED: PipelineColumnDef = { status: 'bookmarked', labelKey: 'saved', tone: 'warn', members: ['bookmarked'] };
const APPLIED: PipelineColumnDef = { status: 'applied', labelKey: 'applied', tone: '', members: ['applying', 'applied'] };
const OFFER: PipelineColumnDef = { status: 'offer', labelKey: 'offer', tone: 'violet', members: ['offer', 'negotiating', 'accepted'] };
const ENDED: PipelineColumnDef = {
  status: 'rejected',
  labelKey: 'rejected',
  tone: '',
  members: ['rejected', 'withdrawn', 'closed'],
  terminal: true,
};

export const INTL_COLUMNS: PipelineColumnDef[] = [
  SAVED,
  APPLIED,
  { status: 'first_call', labelKey: 'first_call', tone: 'accent', members: ['first_call'] },
  // GoApply-only stages (never written on RoboApply) display here if a row carries one.
  { status: 'interviewing', labelKey: 'interviewing', tone: 'accent', members: ['interviewing', 'assessment', 'written_test', 'ai_interview'] },
  { status: 'final_round', labelKey: 'final_round', tone: 'accent', members: ['final_round'] },
  { ...OFFER, members: ['offer', 'negotiating', 'accepted', 'signed'] },
  ENDED,
];

export const CN_COLUMNS: PipelineColumnDef[] = [
  SAVED,
  APPLIED,
  { status: 'assessment', labelKey: 'assessment', tone: 'accent', members: ['assessment'] },
  { status: 'written_test', labelKey: 'written_test', tone: 'accent', members: ['written_test'] },
  { status: 'ai_interview', labelKey: 'ai_interview', tone: 'accent', members: ['ai_interview'] },
  { status: 'interviewing', labelKey: 'interviewing', tone: 'accent', members: ['interviewing', 'first_call', 'final_round'] },
  OFFER,
  { status: 'signed', labelKey: 'signed', tone: 'violet', members: ['signed'] },
  ENDED,
];

/** RoboApply columns (kept under the pre-WP-38 name for existing importers). */
export const PIPELINE_COLUMNS: PipelineColumnDef[] = INTL_COLUMNS;

export function columnsFor(market: TrackerMarket): PipelineColumnDef[] {
  return market === 'cn' ? CN_COLUMNS : INTL_COLUMNS;
}

/** Ended applications: shown in the last column, never counted as "in progress". */
export const HIDDEN_STATUSES: ReadonlySet<TrackerStatus> = new Set<TrackerStatus>(['rejected', 'withdrawn', 'closed']);

const lookups = new WeakMap<PipelineColumnDef[], Map<string, number>>();
function lookup(columns: PipelineColumnDef[]): Map<string, number> {
  let map = lookups.get(columns);
  if (!map) {
    map = new Map();
    columns.forEach((col, idx) => col.members.forEach((m) => map!.set(m, idx)));
    lookups.set(columns, map);
  }
  return map;
}

/** The column index a status belongs to, or `null` when the ladder has no column for it. */
export function columnIndexForStatus(status: string, columns: PipelineColumnDef[] = PIPELINE_COLUMNS): number | null {
  const idx = lookup(columns).get(status);
  return idx === undefined ? null : idx;
}

/** The i18n key suffix (`applications.columns.*`) naming a status. */
export function stageLabelKey(status: string, columns: PipelineColumnDef[] = PIPELINE_COLUMNS): string {
  if (status === 'withdrawn' || status === 'closed') return status;
  const exact = columns.find((c) => c.status === status);
  if (exact) return exact.labelKey;
  const idx = columnIndexForStatus(status, columns);
  return idx === null ? 'applied' : columns[idx]!.labelKey;
}

/** Still in progress (not ended). */
export function isInProgress(status: string): boolean {
  return !HIDDEN_STATUSES.has(status as TrackerStatus);
}
