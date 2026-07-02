'use client';

// sessionStore — a tiny client-side handoff for the V3 mock-interview flow.
//
// The mock.* stub is stateless: `mock.start` mints a sessionId and returns the
// full question list to the SETUP page, but the LIVE page (`/mock-interview/
// [id]`) only has the id from the URL. Until a real backend persists sessions,
// we stash the started session (questions + the chosen setup display info) in
// sessionStorage keyed by sessionId so the live page can hydrate it after the
// navigation. The report page reads mock.score(id) directly and needs nothing
// from here.
//
// This mirrors the existing lib/mockInterview/store.ts localStorage pattern but
// is scoped to the V3 lane (we do not touch lib/stub|fixtures|api per the build
// constraints). Sessions are best-effort: a hard refresh that loses the entry
// (e.g. opening a deep link) degrades gracefully — the live page shows a
// "session expired" state and routes back to setup.

import type {
  RAMockCoachTip,
  RAMockFormat,
} from '../../../lib/api/v2/types';

export interface MockSessionQuestion {
  q: string;
  hint: string;
  coachTip: RAMockCoachTip;
}

export interface StoredMockSession {
  sessionId: string;
  /** chosen role string (display + nextTurn body) */
  role: string;
  interviewerId: string;
  interviewerName: string;
  interviewerRole: string;
  /** two-stop gradient for the interviewer orb */
  interviewerPalette: [string, string];
  interviewerCompany: string;
  typeId: string;
  typeLabel: string;
  format: RAMockFormat;
  questions: MockSessionQuestion[];
}

const KEY_PREFIX = 'ra_v3_mock_session:';

export function saveMockSession(session: StoredMockSession): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${KEY_PREFIX}${session.sessionId}`,
      JSON.stringify(session),
    );
  } catch {
    // sessionStorage may be unavailable (private mode / quota) — non-fatal.
  }
}

export function readMockSession(sessionId: string): StoredMockSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(`${KEY_PREFIX}${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredMockSession;
  } catch {
    return null;
  }
}

export function clearMockSession(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(`${KEY_PREFIX}${sessionId}`);
  } catch {
    // ignore
  }
}
