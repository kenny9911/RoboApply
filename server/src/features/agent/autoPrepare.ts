// server/src/features/agent/autoPrepare.ts — "Prepare my weekly list
// automatically" (docs/agent-driven/REDESIGN.md §9): where the opt-in is kept
// and which new jobs one automatic run starts. Pure: no database, no model.
//
// Where it is kept. No schema change (production safety): the user's UI state
// (`RAUserUiState.state.values`, features/uistate), a per-user JSON document
// whose reader keeps every value it does not know and whose writer merges
// operations key by key with an optimistic check, so another tab's write
// never drops these. `RAAgentSettings` has no free JSON column: its
// `filterOverrides` is read as a filter patch for every list (any key there
// would narrow the lists, and "Use my main search only" clears the column),
// and `calibration` is a strict list of ratings rewritten on each rating.
// The keys below are written by this area's own route only: the generic
// PATCH /ui-state refuses them (uistate SERVER_OWNED_VALUE_PREFIXES), so the
// option is never switched on anywhere its cost is not stated.
//
// What one run starts. The jobs a list build newly picked, in pick order,
// while every running total (one application from the weekly allowance each;
// a tailoring credit each when AI is available and "Tailor my resume for each
// job" is on; a cover letter credit for each job whose post asks for one, or
// always, by the settings) fits what is left in its bucket. It stops at the
// first job that does not fit and never skips ahead to a cheaper one, so it
// spends on a prefix of the list and leaves the rest in "To prepare".

import type { AutoPrepareRunView, AutoPrepareStop, AutoPrepareView, PrepareCreditLine } from './contract.js';
import { AUTO_PREPARE_STOPS } from './contract.js';

/** The idempotency key of the automatic run; `prepare` makes it `autoprep:<itemId>:<attempt>` per job. */
export const AUTO_PREPARE_IDEMPOTENCY_KEY = 'autoprep';

/** Every value of the option starts with this (the generic UI-state PATCH refuses the prefix). */
export const AUTO_PREPARE_VALUE_PREFIX = 'agent.autoPrepare';

/** `RAUserUiState.state.values` keys (UI keys: letters, digits and `_ . : -`, at most 64 characters). */
export const AUTO_PREPARE_KEYS = {
  /** `true` while the option is on; absent when off (the default). */
  on: AUTO_PREPARE_VALUE_PREFIX,
  /** ISO time it was turned on. */
  since: `${AUTO_PREPARE_VALUE_PREFIX}.since`,
  /** The latest run: ISO time, week, applications started, new jobs left, why it stopped ('' when it did not). */
  runAt: `${AUTO_PREPARE_VALUE_PREFIX}.runAt`,
  runWeek: `${AUTO_PREPARE_VALUE_PREFIX}.runWeek`,
  runStarted: `${AUTO_PREPARE_VALUE_PREFIX}.runStarted`,
  runLeft: `${AUTO_PREPARE_VALUE_PREFIX}.runLeft`,
  runStop: `${AUTO_PREPARE_VALUE_PREFIX}.runStop`,
} as const;

export type AutoPrepareValue = string | number | boolean | null;

/** The option as stored (the run without `thisWeek`, which depends on now). */
export interface AutoPrepareStored {
  on: boolean;
  since: string | null;
  lastRun: Omit<AutoPrepareRunView, 'thisWeek'> | null;
}

const WEEK_KEY = /^\d{4}-W\d{2}$/;

function iso(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && !Number.isNaN(Date.parse(v)) ? v : null;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function stopOf(v: unknown): AutoPrepareStop | null {
  return typeof v === 'string' && (AUTO_PREPARE_STOPS as readonly string[]).includes(v) ? (v as AutoPrepareStop) : null;
}

/**
 * The option from the stored values, read tolerantly: anything but `true` is
 * off; a run is reported only when its time, week and count are all readable
 * (never a guessed number, D3).
 */
export function readAutoPrepare(values: Record<string, unknown> | null | undefined): AutoPrepareStored {
  const v = values && typeof values === 'object' ? values : {};
  const on = v[AUTO_PREPARE_KEYS.on] === true;
  const at = iso(v[AUTO_PREPARE_KEYS.runAt]);
  const weekKey = typeof v[AUTO_PREPARE_KEYS.runWeek] === 'string' && WEEK_KEY.test(v[AUTO_PREPARE_KEYS.runWeek] as string) ? (v[AUTO_PREPARE_KEYS.runWeek] as string) : null;
  const started = count(v[AUTO_PREPARE_KEYS.runStarted]);
  const left = count(v[AUTO_PREPARE_KEYS.runLeft]) ?? 0;
  const lastRun = at && weekKey && started !== null ? { at, weekKey, started, left, stoppedBy: left > 0 ? (stopOf(v[AUTO_PREPARE_KEYS.runStop]) ?? 'error') : null } : null;
  return { on, since: on ? iso(v[AUTO_PREPARE_KEYS.since]) : null, lastRun };
}

/** The view for a user whose week is `currentWeekKey`, with the account's AI availability (null: not known). */
export function autoPrepareView(stored: AutoPrepareStored, currentWeekKey: string, aiAvailable: boolean | null): AutoPrepareView {
  return {
    on: stored.on,
    since: stored.since,
    lastRun: stored.lastRun ? { ...stored.lastRun, thisWeek: stored.lastRun.weekKey === currentWeekKey } : null,
    aiAvailable,
  };
}

/** The values that switch the option (off deletes both keys: off is the default). The last run is kept either way. */
export function autoPrepareSwitchValues(on: boolean, now: Date): Record<string, AutoPrepareValue> {
  return on ? { [AUTO_PREPARE_KEYS.on]: true, [AUTO_PREPARE_KEYS.since]: now.toISOString() } : { [AUTO_PREPARE_KEYS.on]: null, [AUTO_PREPARE_KEYS.since]: null };
}

/** The values that record one run (they replace the previous run's). */
export function autoPrepareRunValues(run: { at: Date; weekKey: string; started: number; left: number; stoppedBy: AutoPrepareStop | null }): Record<string, AutoPrepareValue> {
  return {
    [AUTO_PREPARE_KEYS.runAt]: run.at.toISOString(),
    [AUTO_PREPARE_KEYS.runWeek]: run.weekKey,
    [AUTO_PREPARE_KEYS.runStarted]: run.started,
    [AUTO_PREPARE_KEYS.runLeft]: run.left,
    [AUTO_PREPARE_KEYS.runStop]: run.left > 0 ? (run.stoppedBy ?? 'error') : '',
  };
}

type Bucket = PrepareCreditLine['bucket'];

/** One newly picked job and the credits preparing it uses besides its application (0 or 1 each). */
export interface AutoPrepareCandidate {
  id: string;
  tailor: number;
  letter: number;
}

/**
 * The jobs one automatic run starts: the longest prefix of `candidates` (pick
 * order) whose running totals fit `remaining` in every bucket, and the bucket
 * that stopped it (null when every candidate fits). A bucket whose remaining
 * count is not known is not limited here: the credit gate itself (`reserve`)
 * still refuses what is not there. Pure.
 */
export function planAutoPrepare(
  candidates: readonly AutoPrepareCandidate[],
  remaining: Partial<Record<Bucket, number>>,
): { ids: string[]; stoppedBy: Bucket | null } {
  const used: Record<Bucket, number> = { ready_kits: 0, tailor: 0, cover_letter: 0 };
  const fits = (bucket: Bucket, add: number): boolean => {
    const left = remaining[bucket];
    return add === 0 || typeof left !== 'number' || !Number.isFinite(left) || used[bucket] + add <= left;
  };
  const ids: string[] = [];
  for (const c of candidates) {
    const short = (['ready_kits', 'tailor', 'cover_letter'] as const).find((b) => !fits(b, b === 'ready_kits' ? 1 : b === 'tailor' ? c.tailor : c.letter));
    if (short) return { ids, stoppedBy: short };
    used.ready_kits += 1;
    used.tailor += c.tailor;
    used.cover_letter += c.letter;
    ids.push(c.id);
  }
  return { ids, stoppedBy: null };
}
