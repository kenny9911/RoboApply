// deviceState — the per-device classification behind the pre-join check and
// the in-room device states. A wrong bucket shows the wrong fix: "allow the
// mic" to someone whose mic is held by Zoom never helps.

import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMediaError,
  isDeviceFailure,
  levelFromSamples,
  mediaUnavailableReason,
} from '../deviceState';

function err(name: string, message = ''): Error {
  const e = new Error(message || name);
  e.name = name;
  return e;
}

describe('classifyMediaError', () => {
  it('maps browser and LiveKit names onto device states', () => {
    expect(classifyMediaError(err('NotAllowedError'))).toBe('denied');
    expect(classifyMediaError(err('PermissionDeniedError'))).toBe('denied');
    expect(classifyMediaError('PermissionDenied')).toBe('denied');
    expect(classifyMediaError(err('NotFoundError'))).toBe('notFound');
    expect(classifyMediaError(err('OverconstrainedError'))).toBe('notFound');
    expect(classifyMediaError('NotFound')).toBe('notFound');
    expect(classifyMediaError(err('NotReadableError'))).toBe('inUse');
    expect(classifyMediaError(err('TrackStartError'))).toBe('inUse');
    expect(classifyMediaError('DeviceInUse')).toBe('inUse');
  });

  it('falls back on the message, then on error', () => {
    expect(classifyMediaError(err('Error', 'Permission denied by system'))).toBe('denied');
    expect(classifyMediaError(err('Error', 'Could not start video source'))).toBe('inUse');
    expect(classifyMediaError(err('Error', 'something odd'))).toBe('error');
    expect(classifyMediaError(undefined)).toBe('error');
  });
});

describe('mediaUnavailableReason', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  afterEach(() => {
    if (original) Object.defineProperty(window, 'isSecureContext', original);
  });

  it('flags an insecure page', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    expect(mediaUnavailableReason()).toBe('insecure');
    expect(classifyMediaError(err('SecurityError'))).toBe('insecure');
  });
});

describe('helpers', () => {
  it('isDeviceFailure only for real failures', () => {
    expect(isDeviceFailure('ok')).toBe(false);
    expect(isDeviceFailure('off')).toBe(false);
    expect(isDeviceFailure('checking')).toBe(false);
    expect(isDeviceFailure('denied')).toBe(true);
    expect(isDeviceFailure('inUse')).toBe(true);
  });

  it('levelFromSamples is 0 for silence and grows with signal', () => {
    expect(levelFromSamples(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(levelFromSamples(new Uint8Array([160, 96, 160, 96]))).toBeGreaterThan(0.5);
    expect(levelFromSamples(new Uint8Array([255, 0, 255, 0]))).toBe(1);
  });
});
