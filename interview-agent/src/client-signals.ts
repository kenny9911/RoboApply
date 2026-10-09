// Browser ↔ worker control signals (contract C7/C8).
//
// The candidate's browser talks to the worker on two channels:
//  1. Participant ATTRIBUTES — durable state. The browser sets
//     `ie.client_ready = '1'` once remote audio playback is unlocked. Because an
//     attribute is room state, a worker that joins AFTER the browser set it still
//     sees it (the old one-shot data packet was lost whenever the browser
//     connected before the worker finished ctx.connect()).
//  2. Reliable DATA messages on topic `ie` — one-shot events:
//       {type:'client_ready'}  legacy/backup ready signal (also re-sent by new
//                              browsers whenever an agent participant joins)
//       {type:'end'}           the candidate ended the interview; the control
//                              plane relays it through RoomServiceClient
//
// Either ready channel is sufficient. This module is pure (no SDK imports) so
// it is unit-testable against the compiled output.

export const CLIENT_DATA_TOPIC = 'ie';
export const CLIENT_READY_ATTRIBUTE = 'ie.client_ready';
export const DEFAULT_CLIENT_READY_TIMEOUT_MS = 5_000;

export type ClientMessage = { type: 'client_ready' } | { type: 'end' };
export type ClientReadySource = 'attribute' | 'data';

/** Parse a data packet from the browser. Returns null for unrelated topics,
 *  non-JSON payloads and unknown message types. An absent topic is accepted
 *  (older browsers published without one). */
export function parseClientMessage(payload: Uint8Array, topic?: string): ClientMessage | null {
  if (topic && topic !== CLIENT_DATA_TOPIC) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const type = (msg as { type?: unknown }).type;
  if (type === 'client_ready') return { type: 'client_ready' };
  if (type === 'end') return { type: 'end' };
  return null;
}

/** True when a participant's attributes carry the audio-ready flag. */
export function hasClientReadyAttribute(attributes: Record<string, string> | undefined | null): boolean {
  const value = attributes?.[CLIENT_READY_ATTRIBUTE];
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** WORKER_CLIENT_READY_TIMEOUT_MS, defaulting to 5s. Fail-open: the greeting
 *  still plays after this window for an old client that never signals. */
export function resolveClientReadyTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLIENT_READY_TIMEOUT_MS;
}

/** Resolves once on the first ready signal from either channel. */
export class ClientReadyGate {
  private resolveReady!: (source: ClientReadySource) => void;
  private readySource: ClientReadySource | null = null;
  readonly whenReady: Promise<ClientReadySource> = new Promise((resolve) => {
    this.resolveReady = resolve;
  });

  get ready(): boolean { return this.readySource !== null; }
  get source(): ClientReadySource | null { return this.readySource; }

  /** Returns true only for the signal that actually opened the gate. */
  markReady(source: ClientReadySource): boolean {
    if (this.readySource) return false;
    this.readySource = source;
    this.resolveReady(source);
    return true;
  }

  /** Check a participant's current attributes (on join, or on change). */
  observeAttributes(attributes: Record<string, string> | undefined | null): boolean {
    return hasClientReadyAttribute(attributes) ? this.markReady('attribute') : false;
  }
}
