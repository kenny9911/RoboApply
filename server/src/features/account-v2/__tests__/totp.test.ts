// @vitest-environment node
//
// TOTP primitives (RFC 4226 / RFC 6238 vectors), the replay guard, recovery
// codes and secret sealing (WP-79).

import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  matchRecoveryCode,
  otpauthUri,
  totpAt,
  totpStep,
  verifyTotp,
} from '../totp.js';
import { SealError, seal, totpKey, unseal } from '../sealing.js';
import { RecoveryCodeSchema } from '../contract.js';

const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('round-trips and matches the RFC secret', () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_B32);
    expect(base32Decode(RFC_SECRET_B32).equals(RFC_SECRET)).toBe(true);
    expect(base32Decode(RFC_SECRET_B32.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(RFC_SECRET)).toBe(true);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });

  it('generates 160-bit secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(s);
  });
});

describe('HOTP / TOTP', () => {
  it('matches the RFC 4226 HOTP vectors (6 digits)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vectors (last 6 of 8 digits)', () => {
    expect(totpAt(RFC_SECRET_B32, new Date(59_000))).toBe('287082');
    expect(totpAt(RFC_SECRET_B32, new Date(1_111_111_109_000))).toBe('081804');
    expect(totpAt(RFC_SECRET_B32, new Date(1_234_567_890_000))).toBe('005924');
    expect(totpAt(RFC_SECRET_B32, new Date(2_000_000_000_000))).toBe('279037');
  });

  it('accepts ±1 step of drift and nothing further', () => {
    const now = new Date('2026-10-10T12:00:15Z');
    const step = totpStep(now);
    const at = (s: number) => new Date(s * 30_000 + 1_000);
    expect(verifyTotp(RFC_SECRET_B32, totpAt(RFC_SECRET_B32, at(step - 1)), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET_B32, totpAt(RFC_SECRET_B32, at(step + 1)), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET_B32, totpAt(RFC_SECRET_B32, at(step - 2)), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, totpAt(RFC_SECRET_B32, at(step + 2)), now)).toBeNull();
  });

  it('refuses a step at or before the last accepted one (replay guard)', () => {
    const now = new Date('2026-10-10T12:00:15Z');
    const code = totpAt(RFC_SECRET_B32, now);
    const step = verifyTotp(RFC_SECRET_B32, code, now)!;
    expect(verifyTotp(RFC_SECRET_B32, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, code, now, step - 1)).toBe(step);
  });

  it('refuses malformed codes and secrets', () => {
    const now = new Date();
    expect(verifyTotp(RFC_SECRET_B32, '12345', now)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, 'abcdef', now)).toBeNull();
    expect(verifyTotp('not base32!', '123456', now)).toBeNull();
    expect(verifyTotp('', '123456', now)).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = otpauthUri({ issuer: 'Robo:Apply', account: 'u@example.test', secret: RFC_SECRET_B32 });
    expect(uri.startsWith('otpauth://totp/RoboApply%3Au%40example.test?')).toBe(true);
    const q = new URL(uri.replace('otpauth://', 'https://x/')).searchParams;
    expect(q.get('secret')).toBe(RFC_SECRET_B32);
    expect(q.get('issuer')).toBe('RoboApply');
    expect(q.get('digits')).toBe('6');
    expect(q.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('generates 10 unique codes that the contract accepts', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(RecoveryCodeSchema.safeParse(c).success).toBe(true);
      expect(c).not.toMatch(/[01ilo]/);
    }
  });

  it('matches by hash, case- and space-insensitively', () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    expect(hashes[0]).not.toContain(codes[0]);
    expect(matchRecoveryCode(hashes, ` ${codes[1]!.toUpperCase()} `)).toBe(1);
    expect(matchRecoveryCode(hashes, 'aaaa-bbbb-cccc')).toBe(-1);
  });
});

describe('sealing', () => {
  const KEY_HEX = 'a'.repeat(64);

  it('reads the brand key (hex or base64) with no cross-brand fallback', () => {
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: KEY_HEX })).toHaveLength(32);
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })).toHaveLength(32);
    expect(totpKey('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX })).toBeNull();
    expect(totpKey('goapply', { CN_TOTP_ENCRYPTION_KEY: KEY_HEX })).toHaveLength(32);
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: 'short' })).toBeNull();
    expect(totpKey('roboapply', {})).toBeNull();
  });

  it('round-trips, and refuses another user or another key', () => {
    const key = totpKey('roboapply', { TOTP_ENCRYPTION_KEY: KEY_HEX })!;
    const sealed = seal(RFC_SECRET_B32, key, 'user_1');
    expect(sealed).not.toContain(RFC_SECRET_B32);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(unseal(sealed, key, 'user_1')).toBe(RFC_SECRET_B32);
    expect(() => unseal(sealed, key, 'user_2')).toThrow(SealError);
    expect(() => unseal(sealed, Buffer.alloc(32, 1), 'user_1')).toThrow(SealError);
    expect(() => unseal('v0.x.y.z', key, 'user_1')).toThrow(SealError);
  });
});
