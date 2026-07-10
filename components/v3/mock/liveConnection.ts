// Pure connection-state helpers for the live interview room
// (app/(auth)/mock-interview/[id]/page.tsx). Extracted so the disconnect
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

export type DisconnectAction = 'finalize' | 'recover';

/** Route a room disconnect: a deliberate End/Back or a server-side termination
 *  finalizes; anything else must offer recovery — finalizing on a WiFi blip
 *  would score and bill a half-run interview. */
export function classifyDisconnect(
  reason: DisconnectReason | undefined,
  intentionalEnd: boolean,
): DisconnectAction {
  if (intentionalEnd) return 'finalize';
  if (reason !== undefined && SERVER_ENDED_REASONS.has(reason)) return 'finalize';
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
