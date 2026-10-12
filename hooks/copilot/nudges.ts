'use client';

// hooks/copilot/nudges.ts — proactive Assistant nudges (WP-51; F-ORION-08).
//
// At most ONE nudge per browser session, and only from a real signal
// (PRODUCT_PLAN.md F-ORION-08). The server decides which one holds
// (`GET /copilot/nudge`, hooks/copilot/useServerNudge.ts asks it when the rail
// could show one); another area that just observed a signal may also offer it
// directly:
//   low_rating       the user rated the feed low      → "Adjust your search?"
//   agency_report    the user reported a scam/agency  → "Hide agency posts?"
//   pay_filter       no pay filter while many posts list pay → "Add a minimum pay?"
//   campus_deadline  GoApply: a followed 网申 deadline is close
//
//   offerAssistantNudge({ kind: 'low_rating' });
//
// The rail shows it beside the floating button, through the popup gate (one
// unprompted prompt per page view, 24 h between them). Pressing it opens the
// Assistant with a suggested question in the box; nothing is sent until the
// user presses Send.

import { useSyncExternalStore } from 'react';

import { createStore } from '../shared/store';

export const NUDGE_KINDS = ['low_rating', 'agency_report', 'pay_filter', 'campus_deadline'] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

export interface AssistantNudge {
  kind: NudgeKind;
  /** The job the signal was about, if any. */
  jobId?: string | null;
}

export const NUDGE_SESSION_KEY = 'ra_assistant_nudge_shown';

const pending = createStore<AssistantNudge | null>(null);
let shownInMemory = false;

/** A kind this client knows (the server's vocabulary is the same; a test keeps them equal). */
export function isNudgeKind(v: unknown): v is NudgeKind {
  return typeof v === 'string' && (NUDGE_KINDS as readonly string[]).includes(v);
}

/** True once a nudge was shown in this browser session (no other one follows). */
export function nudgeSessionShown(): boolean {
  return sessionShown();
}

function sessionShown(): boolean {
  if (shownInMemory) return true;
  try {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(NUDGE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Offer a nudge. Ignored when one was already shown this session or another
 * is waiting. Returns true when it was queued.
 */
export function offerAssistantNudge(nudge: AssistantNudge): boolean {
  if (!NUDGE_KINDS.includes(nudge.kind)) return false;
  if (sessionShown() || pending.get()) return false;
  pending.set(nudge);
  return true;
}

/** The rail showed the nudge: no other one this session. */
export function markNudgeShown(): void {
  shownInMemory = true;
  try {
    window.sessionStorage.setItem(NUDGE_SESSION_KEY, '1');
  } catch {
    // storage unavailable: the in-memory flag still holds for this page
  }
}

export function clearAssistantNudge(): void {
  pending.set(null);
}

export function usePendingNudge(): AssistantNudge | null {
  return useSyncExternalStore(pending.subscribe, pending.get, () => null);
}

/** Tests only. */
export function __resetNudges(): void {
  shownInMemory = false;
  pending.reset();
  try {
    window.sessionStorage.removeItem(NUDGE_SESSION_KEY);
  } catch {
    // ignore
  }
}
