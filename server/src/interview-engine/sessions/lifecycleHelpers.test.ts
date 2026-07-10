// backend/src/interview-engine/sessions/lifecycleHelpers.test.ts
//
// Unit tests for the pure lifecycle helpers: the expiry-sweep state selection
// (decideReconcileAction) and the recording MIME decision (recordingMimeForMode).
// Excluded from the server tsc build (tsconfig excludes src/**/*.test.ts); run
// via the root vitest config: npx vitest run server/src/interview-engine/sessions/lifecycleHelpers.test.ts

import { describe, it, expect } from 'vitest';
import { decideReconcileAction, recordingMimeForMode } from './lifecycleHelpers.js';

describe('decideReconcileAction', () => {
  it('expires never-connected sessions with no transcript', () => {
    expect(decideReconcileAction('created', 0)).toBe('expire');
  });

  it('expires live/finalizing sessions with no transcript (nothing to score)', () => {
    expect(decideReconcileAction('live', 0)).toBe('expire');
    expect(decideReconcileAction('finalizing', 0)).toBe('expire');
  });

  it('finalizes any stranded non-terminal session that has transcript turns', () => {
    expect(decideReconcileAction('live', 12)).toBe('finalize');
    expect(decideReconcileAction('finalizing', 3)).toBe('finalize');
    // 'created' with turns is anomalous (ingest accepts pre-live turns) but
    // salvageable — the user still gets a report.
    expect(decideReconcileAction('created', 1)).toBe('finalize');
  });

  it('never touches terminal or unknown statuses', () => {
    expect(decideReconcileAction('completed', 50)).toBe('skip');
    expect(decideReconcileAction('expired', 0)).toBe('skip');
    expect(decideReconcileAction('failed', 5)).toBe('skip');
    expect(decideReconcileAction('bogus', 5)).toBe('skip');
  });
});

describe('recordingMimeForMode', () => {
  it('reports audio/mp4 for voice mode (audioOnly egress → audio-only MP4)', () => {
    expect(recordingMimeForMode('voice')).toBe('audio/mp4');
  });

  it('reports video/mp4 for video mode', () => {
    expect(recordingMimeForMode('video')).toBe('video/mp4');
  });

  it('defaults unknown modes to video/mp4 (the egress container default)', () => {
    expect(recordingMimeForMode('')).toBe('video/mp4');
  });
});
