// liveConnection — disconnect classification + quality-level mapping for the
// live interview room. These pins matter: misclassifying a network drop as a
// server end would finalize (score + bill) a half-run interview, and the
// quality mapping drives both the visible indicator and the persisted
// quality_change telemetry.

import { describe, expect, it } from 'vitest';
import { ConnectionQuality, DisconnectReason } from 'livekit-client';
import {
  SERVER_ENDED_REASONS,
  classifyDisconnect,
  qualityLevel,
} from '../liveConnection';

describe('classifyDisconnect', () => {
  it('finalizes on every server-ended reason', () => {
    for (const reason of [
      DisconnectReason.ROOM_DELETED,
      DisconnectReason.PARTICIPANT_REMOVED,
      DisconnectReason.SERVER_SHUTDOWN,
    ]) {
      expect(classifyDisconnect(reason, false)).toBe('finalize');
    }
  });

  it('recovers on non-server reasons (network loss, signal closed, unknown)', () => {
    expect(classifyDisconnect(DisconnectReason.CLIENT_INITIATED, false)).toBe('recover');
    expect(classifyDisconnect(DisconnectReason.UNKNOWN_REASON, false)).toBe('recover');
    expect(classifyDisconnect(undefined, false)).toBe('recover');
  });

  it('an intentional end finalizes regardless of reason', () => {
    expect(classifyDisconnect(undefined, true)).toBe('finalize');
    expect(classifyDisconnect(DisconnectReason.CLIENT_INITIATED, true)).toBe('finalize');
  });

  it('SERVER_ENDED_REASONS is exactly the three server-termination reasons', () => {
    expect(SERVER_ENDED_REASONS.size).toBe(3);
  });
});

describe('qualityLevel', () => {
  it('maps the four readings onto the 3-level indicator', () => {
    expect(qualityLevel(ConnectionQuality.Excellent)).toBe('good');
    expect(qualityLevel(ConnectionQuality.Good)).toBe('fair');
    expect(qualityLevel(ConnectionQuality.Poor)).toBe('poor');
    expect(qualityLevel(ConnectionQuality.Lost)).toBe('poor');
  });

  it('Unknown is null — no reading yet, never a transition', () => {
    expect(qualityLevel(ConnectionQuality.Unknown)).toBeNull();
  });
});
