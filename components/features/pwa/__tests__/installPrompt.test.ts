// WP-61: the install prompt's pure rules — session counting, platform
// detection and "once, after the second session".

import { describe, expect, it } from 'vitest';

import {
  PWA_MIN_SESSIONS,
  countSession,
  installPlatform,
  installPromptEligible,
  isIosSafari,
  markShownOnDevice,
  shownOnDevice,
  type KeyValueStore,
} from '../../../../hooks/pwa/installPrompt';

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}
const broken: KeyValueStore = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1';
const WECHAT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 MicroMessenger/8.0.50';

describe('countSession', () => {
  it('counts each browser session once', () => {
    const local = memory();
    let session = memory();
    expect(countSession(local, session)).toBe(1);
    expect(countSession(local, session)).toBe(1); // same session, another page
    session = memory(); // new browser session
    expect(countSession(local, session)).toBe(2);
  });

  it('returns 0 without storage (no prompt in private windows)', () => {
    expect(countSession(broken, broken)).toBe(0);
    expect(countSession(null, null)).toBe(0);
    expect(countSession(memory(), broken)).toBe(0);
  });

  it('remembers that the prompt was shown on this device', () => {
    const local = memory();
    expect(shownOnDevice(local)).toBe(false);
    markShownOnDevice(local);
    expect(shownOnDevice(local)).toBe(true);
    expect(shownOnDevice(broken)).toBe(false);
  });
});

describe('installPlatform', () => {
  it('uses the captured browser prompt, iOS Safari steps, or nothing', () => {
    expect(installPlatform({ userAgent: CHROME, standalone: false, promptAvailable: true })).toBe('prompt');
    expect(installPlatform({ userAgent: CHROME, standalone: false, promptAvailable: false })).toBeNull();
    expect(installPlatform({ userAgent: IOS_SAFARI, standalone: false, promptAvailable: false })).toBe('ios');
    expect(installPlatform({ userAgent: IOS_CHROME, standalone: false, promptAvailable: false })).toBeNull();
    expect(isIosSafari(IOS_CHROME)).toBe(false);
  });

  it('never offers inside an installed app or WeChat', () => {
    expect(installPlatform({ userAgent: CHROME, standalone: true, promptAvailable: true })).toBeNull();
    expect(installPlatform({ userAgent: WECHAT, standalone: false, promptAvailable: true })).toBeNull();
  });
});

describe('installPromptEligible', () => {
  const base = { sessions: PWA_MIN_SESSIONS, platform: 'prompt' as const, shownOnDevice: false, shownOnAccount: false };
  it('from the second session, once, when the browser can install', () => {
    expect(installPromptEligible(base)).toBe(true);
    expect(installPromptEligible({ ...base, sessions: 1 })).toBe(false);
    expect(installPromptEligible({ ...base, platform: null })).toBe(false);
    expect(installPromptEligible({ ...base, shownOnDevice: true })).toBe(false);
    expect(installPromptEligible({ ...base, shownOnAccount: true })).toBe(false);
    expect(installPromptEligible({ ...base, shownOnAccount: null })).toBe(false);
  });
});
