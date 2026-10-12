// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assertPassword,
  isStrongEnoughPassword,
  marketForSignup,
  onboardingEntryFrom,
  pdpaNoticeRequired,
  safeTimezone,
  touchFrom,
  validateSignupConsents,
} from './signupPolicy.js';
import { AuthError } from './errors.js';
import { parseDevice, deviceMarkRaw } from './devices.js';

const AGE = { type: 'age_16_plus', granted: true, proseVersion: 'v1' };
const PDPA = { type: 'tw_pdpa_notice', granted: true, proseVersion: 'v1' };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AuthError ? err.code : 'other';
  }
}

describe('validateSignupConsents', () => {
  it('requires age_16_plus on both brands (H29)', () => {
    for (const brand of ['roboapply', 'goapply'] as const) {
      expect(codeOf(() => validateSignupConsents({ brand, consents: [] }))).toBe('age_consent_required');
      expect(codeOf(() => validateSignupConsents({ brand, consents: undefined }))).toBe('age_consent_required');
      expect(codeOf(() => validateSignupConsents({ brand, consents: [{ ...AGE, granted: false }] }))).toBe('age_consent_required');
      expect(codeOf(() => validateSignupConsents({ brand, consents: [AGE] }))).toBeNull();
    }
  });

  it('requires the PDPA notice for zh-TW or Taiwan visitors on RoboApply only', () => {
    expect(codeOf(() => validateSignupConsents({ brand: 'roboapply', consents: [AGE], locale: 'zh-TW' }))).toBe('pdpa_consent_required');
    expect(codeOf(() => validateSignupConsents({ brand: 'roboapply', consents: [AGE], country: 'tw' }))).toBe('pdpa_consent_required');
    expect(codeOf(() => validateSignupConsents({ brand: 'roboapply', consents: [AGE, PDPA], locale: 'zh-TW' }))).toBeNull();
    expect(codeOf(() => validateSignupConsents({ brand: 'roboapply', consents: [AGE], locale: 'zh' }))).toBeNull();
    expect(codeOf(() => validateSignupConsents({ brand: 'goapply', consents: [AGE], locale: 'zh-TW' }))).toBeNull();
    expect(pdpaNoticeRequired('roboapply', 'en', 'US')).toBe(false);
  });

  it('rejects unknown consent types', () => {
    expect(codeOf(() => validateSignupConsents({ brand: 'roboapply', consents: [AGE, { type: 'nope', granted: true, proseVersion: 'v' }] }))).toBe(
      'unknown_consent',
    );
  });

  it('records marketing from the checkbox, unchecked by default', () => {
    const rows = validateSignupConsents({ brand: 'roboapply', consents: [AGE] });
    expect(rows.find((r) => r.consentType === 'marketing_email')).toMatchObject({ granted: false });
    const opted = validateSignupConsents({ brand: 'roboapply', consents: [AGE], marketingOptIn: true });
    expect(opted.find((r) => r.consentType === 'marketing_email')).toMatchObject({ granted: true });
    // A forged consents entry cannot override the checkbox.
    const forged = validateSignupConsents({ brand: 'roboapply', consents: [AGE, { type: 'marketing_email', granted: true, proseVersion: 'x' }] });
    expect(forged.find((r) => r.consentType === 'marketing_email')).toMatchObject({ granted: false });
  });
});

describe('passwords', () => {
  it('needs 8+ characters with a letter and a digit', () => {
    expect(isStrongEnoughPassword('abcdefg1')).toBe(true);
    expect(isStrongEnoughPassword('abcdefgh')).toBe(false);
    expect(isStrongEnoughPassword('12345678')).toBe(false);
    expect(isStrongEnoughPassword('abc1')).toBe(false);
    expect(isStrongEnoughPassword(undefined)).toBe(false);
    expect(codeOf(() => assertPassword('short'))).toBe('weak_password');
  });
});

describe('market and attribution', () => {
  it('derives market from brand and chosen locale (ARCH §1.10)', () => {
    expect(marketForSignup('goapply', 'en')).toBe('cn');
    expect(marketForSignup('roboapply', 'zh-TW')).toBe('tw');
    expect(marketForSignup('roboapply', 'ja')).toBe('jp');
    expect(marketForSignup('roboapply', 'zh')).toBe('other');
    expect(marketForSignup('roboapply', null)).toBe('other');
  });

  it('keeps only known attribution keys, trimmed', () => {
    expect(onboardingEntryFrom(undefined)).toBeNull();
    expect(onboardingEntryFrom({})).toBeNull();
    expect(onboardingEntryFrom({ from: ' job ', jobId: 'cm1', action: 'apply', utmSource: 'x', anonId: 'a1' })).toEqual({
      from: 'job',
      jobId: 'cm1',
      action: 'apply',
      utmSource: 'x',
    });
    const at = new Date('2026-10-10T00:00:00Z');
    expect(touchFrom({ from: 'resume-check', landingPath: '/tools' }, at)).toEqual({
      at: at.toISOString(),
      from: 'resume-check',
      landingPath: '/tools',
    });
    expect(touchFrom(undefined, at)).toBeNull();
  });

  it('accepts only real IANA zones', () => {
    expect(safeTimezone('Asia/Taipei')).toBe('Asia/Taipei');
    expect(safeTimezone('Mars/Base')).toBeNull();
    expect(safeTimezone(42)).toBeNull();
  });
});

describe('devices', () => {
  it('reads browser and OS families, ignoring versions', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
    const mac2 = mac.replace('129.0', '130.1');
    expect(parseDevice(mac)).toEqual({ browser: 'Chrome', os: 'macOS' });
    expect(deviceMarkRaw('u1', parseDevice(mac))).toBe(deviceMarkRaw('u1', parseDevice(mac2)));
    expect(parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({
      browser: 'Safari',
      os: 'iOS',
    });
    expect(parseDevice('Mozilla/5.0 (Windows NT 10.0) Edg/129.0')).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(parseDevice(null)).toEqual({ browser: 'Unknown', os: 'Unknown' });
  });
});
