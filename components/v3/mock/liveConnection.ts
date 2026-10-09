// Pure connection-state helpers for the live interview room
// (app/(auth)/practice/[id]/page.tsx). Extracted so the disconnect
// classification and quality-level mapping — the most failure-prone client
// logic in the product — are unit-testable without mounting a LiveKit room.
//
// Deliberately NOT re-exported from ./index.ts: that barrel is imported by
// non-live pages, and this module pulls in livekit-client, which only the live
// room should ship.

import { ConnectionQuality, DisconnectReason } from 'livekit-client';

// Reasons that mean the SERVER ended the session — the interview is genuinely
// over and finishing (finalize → report) is correct. Everything else (signal
// closed, network loss, unknown) is recoverable via rejoin.
export const SERVER_ENDED_REASONS: ReadonlySet<DisconnectReason> = new Set([
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.SERVER_SHUTDOWN,
]);

// Reasons that mean ANOTHER copy of this interview took the seat. The
// candidate identity is fixed per session (candidate-<sessionId>), so a second
// tab or a stale window joining evicts this one with DUPLICATE_IDENTITY. An
// automatic rejoin here would evict the other tab, which would rejoin and
// evict this one — an endless ping-pong that also wipes the transcript every
// few seconds. These stop and ask instead.
// JOIN_FAILURE (join/ICE failed) and STATE_MISMATCH (a resume after a network
// blip was rejected) are network-recovery cases with no second tab involved,
// so they deliberately stay on the automatic 'recover' path.
export const SUPERSEDED_REASONS: ReadonlySet<DisconnectReason> = new Set([
  DisconnectReason.DUPLICATE_IDENTITY,
]);

export type DisconnectAction = 'finalize' | 'recover' | 'superseded';

/** Route a room disconnect: a deliberate End/Back or a server-side termination
 *  finalizes; another tab taking the seat stops without rejoining; anything
 *  else must offer recovery — finalizing on a WiFi blip would score and bill a
 *  half-run interview. */
export function classifyDisconnect(
  reason: DisconnectReason | undefined,
  intentionalEnd: boolean,
): DisconnectAction {
  if (intentionalEnd) return 'finalize';
  if (reason !== undefined && SERVER_ENDED_REASONS.has(reason)) return 'finalize';
  if (reason !== undefined && SUPERSEDED_REASONS.has(reason)) return 'superseded';
  return 'recover';
}

export type QualityLevel = 'good' | 'fair' | 'poor';

/** Collapse LiveKit's four quality readings into the 3-level indicator the UI
 *  shows. Unknown → null: it means "no reading yet", not a transition. */
export function qualityLevel(quality: ConnectionQuality): QualityLevel | null {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 'good';
    case ConnectionQuality.Good:
      return 'fair';
    case ConnectionQuality.Poor:
    case ConnectionQuality.Lost:
      return 'poor';
    default:
      return null;
  }
}
