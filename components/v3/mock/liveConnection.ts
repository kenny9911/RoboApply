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

// ─── Camera plan (the server's media policy; no brand term) ────────────────

export interface CameraPlanInput {
  mode: 'voice' | 'video';
  /** From the server (the connection, else the session): false = the camera
   *  stays local. Absent on older APIs: read as allowed. */
  cameraPublish?: boolean;
  /** The camera worked in the device check (or there was no check: a rejoin). */
  deviceOk: boolean;
}

export interface CameraPlan {
  /** Publish a camera track to the room (the interviewer side can receive it). */
  publish: boolean;
  /** The camera, if shown at all, is a local self-view from a stream that is
   *  never sent. Decided by the server's policy alone, so a later "Start
   *  camera" can never fall through to publishing. */
  localPreview: boolean;
  /** The local preview starts on when the room opens (it worked in the check). */
  previewStartsOn: boolean;
}

/** Where the candidate's camera goes: published on both brands, unless the
 *  server says it stays local (`cameraPublish: false`, an operator opt-out).
 *  Then it is a local self-view only: no video track is ever published, even
 *  when the camera failed the device check and is turned on later. */
export function cameraPlan({ mode, cameraPublish, deviceOk }: CameraPlanInput): CameraPlan {
  if (mode !== 'video') return { publish: false, localPreview: false, previewStartsOn: false };
  const localOnly = cameraPublish === false;
  if (localOnly) return { publish: false, localPreview: true, previewStartsOn: deviceOk };
  return { publish: deviceOk, localPreview: false, previewStartsOn: false };
}

// ─── Live-room copy read by key (network check, local-only camera) ──────────
//
// The 12 strings live under `practice.live.cam.*` and `practice.live.network.*`
// (staged in i18n/staging/practice.en.json). They are read through
// `pendingLiveCopy`, which checks `t.has` first: a bundle that does not carry
// a key (an older cached bundle during a deploy) shows the earlier copy or
// nothing — never the literal key path (next-intl renders a missing key as
// its path).

export const PENDING_LIVE_COPY = Object.freeze({
  camLocalOnly: 'live.cam.localOnly',
  camLocalOnlyShort: 'live.cam.localOnlyShort',
  networkLabel: 'live.network.label',
  networkChecking: 'live.network.checking',
  networkGood: 'live.network.good',
  networkFair: 'live.network.fair',
  networkPoor: 'live.network.poor',
  networkFairBody: 'live.network.fairBody',
  networkPoorBody: 'live.network.poorBody',
  networkSwitchToText: 'live.network.switchToText',
  networkSwitching: 'live.network.switching',
  networkRetry: 'live.network.retry',
});

export type PendingLiveCopy = keyof typeof PENDING_LIVE_COPY;

/** The translator of `useTranslations('practice')`, as far as this needs it. */
export interface LiveCopyTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/** A `practice.live.*` string when the bundle carries it, else null. */
export function pendingLiveCopy(t: LiveCopyTranslator, id: PendingLiveCopy): string | null {
  const key = PENDING_LIVE_COPY[id];
  return t.has(key) ? t(key) : null;
}
