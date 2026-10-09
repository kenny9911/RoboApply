import { afterEach, describe, expect, it } from 'vitest';

import { isRecordingEnabled } from './config.js';

const KEY = 'INTERVIEW_ENGINE_RECORDING_ENABLED';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('isRecordingEnabled', () => {
  it('is off when the variable is unset or empty', () => {
    delete process.env[KEY];
    expect(isRecordingEnabled()).toBe(false);
    process.env[KEY] = '';
    expect(isRecordingEnabled()).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', ' on '])('is on only for an explicit opt-in (%s)', (value) => {
    process.env[KEY] = value;
    expect(isRecordingEnabled()).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'maybe'])('stays off for anything else (%s)', (value) => {
    process.env[KEY] = value;
    expect(isRecordingEnabled()).toBe(false);
  });
});
