// server/src/features/agent/stateMachine.ts — pure rules of Ready to apply
// (WP-52; TASK_PLAN.md R-19; PRODUCT F-AGENT-04/05/10).
//
// Nothing here reads a database or calls a model. D1: no state, transition or
// helper ever produces 'submitted'; `open` is the only path to the employer
// site and it only returns the URL the user opens.

import { HttpError } from '../../platform/http.js';
import { localTime } from '../alerts/index.js';
import { windowKeyFor } from '../../platform/credits/index.js';
import {
  AGENT_ERROR_CODES,
  MIN_TIERS,
  QUEUE_STATES,
  QUEUE_TABS,
  QUEUE_TRANSITIONS,
  SETUP_STEPS,
  TAB_STATES,
  type FileNameStyle,
  type MinTier,
  type QueueState,
  type QueueTab,
  type SetupStep,
} from './contract.js';

// ── Transitions ──────────────────────────────────────────────────────────

export function isQueueState(value: unknown): value is QueueState {
  return typeof value === 'string' && (QUEUE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: QueueState, to: QueueState): boolean {
  return QUEUE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws 409 `queue_invalid_transition` for a move the table does not allow. */
export function assertTransition(from: string, to: QueueState): asserts from is QueueState {
  if (!isQueueState(from) || !canTransition(from, to)) {
    throw new HttpError('conflict', 'This step is not available for this job right now.', {
      reason: AGENT_ERROR_CODES.invalidTransition,
      from,
      to,
    });
  }
}

export function tabOf(state: QueueState): QueueTab {
  for (const tab of QUEUE_TABS) if (TAB_STATES[tab].includes(state)) return tab;
  return 'done';
}

// ── Fit tiers (R-09 words; `minTier` picks Great / Good-and-better / Possible-and-better) ──

const TIER_RANK: Record<string, number> = { unlikely: 0, possible: 1, good: 2, great: 3 };

/** True when a scored job's tier is at least `minTier`. Unscored jobs never pass (unknown is not ≥). */
export function meetsMinTier(tier: string | null | undefined, minTier: MinTier): boolean {
  if (!tier || !(tier in TIER_RANK)) return false;
  return TIER_RANK[tier]! >= TIER_RANK[minTier]!;
}

export function isMinTier(value: unknown): value is MinTier {
  return typeof value === 'string' && (MIN_TIERS as readonly string[]).includes(value);
}

// ── Weeks (user-local, ISO weeks; the list is built Monday 06:00 local) ──

export const WEEKLY_LIST_HOUR = 6;
/** The hourly cron keeps trying until noon local, so a missed tick still builds the list. */
export const WEEKLY_WINDOW_END_HOUR = 12;

/** ISO week of `date` in `timeZone`, e.g. '2026-W41' (the queue item's `weekKey`). */
export function weekKeyFor(date: Date, timeZone: string): string {
  return windowKeyFor('week', date, timeZone).replace(/^w:/, '');
}

/** Monday between 06:00 and 11:59 in the user's time zone. */
export function inWeeklyWindow(now: Date, timeZone: string): boolean {
  const lt = localTime(now, timeZone);
  return lt.weekday === 1 && lt.hour >= WEEKLY_LIST_HOUR && lt.hour < WEEKLY_WINDOW_END_HOUR;
}

/**
 * Cheap guard before any query: Monday 06:00–12:00 local exists somewhere on
 * Earth (UTC−12 … UTC+14) only between Sunday 16:00 and Tuesday 00:00 UTC.
 */
export function weeklyWindowOpenAnywhere(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 0) return hour >= 16;
  return day === 1;
}

// ── Setup steps ──────────────────────────────────────────────────────────

const STEP_ORDER: readonly SetupStep[] = SETUP_STEPS;

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value);
}

/** The step after `step` (the extension step is left out when the capability is off). */
export function nextSetupStep(step: SetupStep, extensionAvailable: boolean): SetupStep {
  const i = STEP_ORDER.indexOf(step);
  let next = STEP_ORDER[Math.min(i + 1, STEP_ORDER.length - 1)]!;
  if (next === 'extension' && !extensionAvailable) next = 'done';
  return next;
}

/** The stored step as shown: an unknown value restarts at 'profile'; 'extension' without the capability is 'done'. */
export function effectiveSetupStep(stored: string | null | undefined, extensionAvailable: boolean): SetupStep {
  if (!isSetupStep(stored)) return 'profile';
  if (stored === 'extension' && !extensionAvailable) return 'done';
  return stored;
}

export type SetupMove =
  /** `step` is the current step: setup moves to `next`. */
  | { kind: 'advance'; current: SetupStep; next: SetupStep }
  /** `step` was finished before: nothing changes (finishing it again never sends the user back). */
  | { kind: 'noop'; current: SetupStep }
  /** `step` comes after the current step: refused (no step can be jumped, skipped or not). */
  | { kind: 'out_of_order'; current: SetupStep };

/** Index of a step in the wizard order. */
export function setupStepIndex(step: SetupStep): number {
  return STEP_ORDER.indexOf(step);
}

/**
 * What finishing (or skipping) `step` does. Only the current step moves the
 * wizard forward, one step at a time; an earlier step is a no-op; a later
 * step is out of order (so skipping "Get the extension" from 'profile' cannot
 * jump past the ratings, the answers and the weekly settings).
 */
export function setupMove(stored: string | null | undefined, step: Exclude<SetupStep, 'done'>, extensionAvailable: boolean): SetupMove {
  const current = effectiveSetupStep(stored, extensionAvailable);
  const at = setupStepIndex(step);
  const now = setupStepIndex(current);
  if (at > now) return { kind: 'out_of_order', current };
  if (at < now) return { kind: 'noop', current };
  return { kind: 'advance', current, next: nextSetupStep(step, extensionAvailable) };
}

// ── Cover letters: does the post ask for one? (a phrase match, never a guess) ──

const COVER_LETTER_PHRASES = [
  /\bcover(?:ing)?[\s-]+letters?\b/i,
  /\bmotivation(?:al)?[\s-]+letters?\b/i,
  /\bletters?\s+of\s+(?:motivation|interest|application)\b/i,
  /求职信/,
  /自荐信/,
  /求職信/,
  /推薦信/,
  /动机信/,
  /動機信/,
];

/** True when the post's own text mentions a cover letter (PRODUCT F-AGENT-03 "only when the post asks for one"). */
export function postAsksForCoverLetter(...texts: Array<string | null | undefined>): boolean {
  const text = texts.filter(Boolean).join('\n');
  if (!text) return false;
  return COVER_LETTER_PHRASES.some((re) => re.test(text));
}

export function letterNeeded(mode: string, asks: boolean): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return asks;
}

// ── File names (F-AGENT-03 "file naming") ────────────────────────────────
//
// The kit review shows the name the resume WILL download as. The file itself
// is named by the resume export (roboapply/v2/lib/resumeExport.ts
// `buildExportFileName`, called by RAResumeService.exportVariant), so these
// rules are that function's rules, kept equal by a test: the same cleaning,
// " - " between the parts, and the same fallback. A second naming scheme here
// (underscores, the profile's name) showed a name no download ever had.

/** One part of a file name: no path or reserved characters, single spaces, at most 60 characters. */
export function fileNamePart(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** The person's name as the resume itself gives it (its first heading), which is what the export uses. */
export function resumeHeadingName(markdown: string | null | undefined): string | null {
  const name = /^#\s+(.+)$/m.exec(markdown ?? '')?.[1]?.replace(/[*_`]/g, '').trim();
  return name ? name : null;
}

/**
 * Resume file name for a kit (no extension), following the chosen style.
 * Parts that are not known are left out, never invented; with no part at all
 * the name is `fallback` (the resume's own title), else "Resume".
 */
export function kitFileName(
  style: FileNameStyle | string,
  input: { name?: string | null; company?: string | null; role?: string | null; date?: Date; fallback?: string | null },
): string {
  const name = fileNamePart(input.name);
  const company = fileNamePart(input.company);
  const role = fileNamePart(input.role);
  const date = (input.date ?? new Date()).toISOString().slice(0, 10);
  let parts: string[];
  switch (style) {
    case 'name_role':
      parts = [name, role];
      break;
    case 'company_role_name':
      parts = [company, role, name];
      break;
    case 'name_date':
      parts = [name, date];
      break;
    case 'name_company_role':
      parts = [name, company, role];
      break;
    default:
      parts = [];
  }
  return parts.filter(Boolean).join(' - ') || fileNamePart(input.fallback) || 'Resume';
}
