// components/features/tools/pendingResult.ts — the one free-tool result a
// signed-out visitor asked to keep (WP-57), so that after signing up or in the
// result can be kept in the new account by ToolResultClaimHost, and the tool
// page (`next=/tools/<slug>`) can show it again. This is the only place the
// result id travels across the signup round trip: it is never in a URL.
//
// Written ONLY when the visitor clicks "Create a free account" / "I have an
// account" under their report (NextStep), never on a run and never for a
// signed-in user. That is the visitor's request to keep it. To keep the
// request from landing in someone else's account on a shared computer:
//   - it lives in sessionStorage (this tab only; gone when the tab closes);
//   - it is "armed" for ARM_TTL_MS after the click (the signup/sign-in round
//     trip), and ignored and cleared after that;
//   - the claim host reads it once and clears it before claiming (one-shot).
// Every access is guarded (private windows, blocked storage); without storage
// the result is not carried (the visitor can run the check again after
// signing in). The id alone opens nothing: the server also needs the visitor
// cookie of the browser that ran the check.

import type { ToolKind } from '../../../lib/api/contracts/tools';

export const PENDING_RESULT_KEY = 'ra.tools.pendingResult';

/** How long after the click the request to keep a result stays valid. */
export const ARM_TTL_MS = 30 * 60 * 1000;

export interface PendingResult {
  id: string;
  kind: ToolKind;
  /** When the server deletes the result (ISO). */
  expiresAt: string;
  /** When the visitor clicked the signup / sign-in link (ISO). */
  armedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The visitor clicked signup / sign-in under this result: remember it for this tab. */
export function armPendingResult(entry: Omit<PendingResult, 'armedAt'>, now: Date = new Date()): void {
  try {
    storage()?.setItem(PENDING_RESULT_KEY, JSON.stringify({ ...entry, armedAt: now.toISOString() }));
  } catch {
    // storage unavailable: the result is not carried across signup
  }
}

/** The armed, unexpired entry, or null (a stale or expired entry is cleared). */
export function readPendingResult(now: Date = new Date()): PendingResult | null {
  try {
    const raw = storage()?.getItem(PENDING_RESULT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingResult>;
    if (typeof v.id !== 'string' || typeof v.kind !== 'string' || typeof v.expiresAt !== 'string' || typeof v.armedAt !== 'string') {
      clearPendingResult();
      return null;
    }
    const armed = new Date(v.armedAt).getTime();
    const stale = !Number.isFinite(armed) || armed > now.getTime() + 60_000 || now.getTime() - armed > ARM_TTL_MS;
    if (stale || new Date(v.expiresAt).getTime() <= now.getTime()) {
      clearPendingResult();
      return null;
    }
    return { id: v.id, kind: v.kind as ToolKind, expiresAt: v.expiresAt, armedAt: v.armedAt };
  } catch {
    return null;
  }
}

/** Read once and clear (the claim host's only read). */
export function takePendingResult(now: Date = new Date()): PendingResult | null {
  const entry = readPendingResult(now);
  clearPendingResult();
  return entry;
}

export function clearPendingResult(): void {
  try {
    storage()?.removeItem(PENDING_RESULT_KEY);
  } catch {
    // nothing to clear
  }
}
