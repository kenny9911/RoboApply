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
import { SealError, seal, totpKey, totpKeyProblems, totpKeyWarning, totpKeys, unseal, unsealWithAny } from '../sealing.js';
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

  const CN_HEX = 'c'.repeat(64);

  it('reads the key as hex or base64; GoApply uses its own key when set and the shared key otherwise', () => {
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: KEY_HEX })).toHaveLength(32);
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })).toHaveLength(32);
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: 'short' })).toBeNull();
    expect(totpKey('roboapply', {})).toBeNull();
    // The fallback (D5): GoApply with only the shared key seals with it.
    expect(totpKey('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX })).toEqual(Buffer.from(KEY_HEX, 'hex'));
    expect(totpKey('goapply', { CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual(Buffer.from(CN_HEX, 'hex'));
    // Both set: new secrets use the CN key.
    expect(totpKey('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual(Buffer.from(CN_HEX, 'hex'));
    expect(totpKey('goapply', {})).toBeNull();
    // RoboApply never reads the CN key.
    expect(totpKey('roboapply', { CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toBeNull();
    expect(totpKey('roboapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual(Buffer.from(KEY_HEX, 'hex'));
  });

  it('totpKeys lists the own key, then the shared key, without blanks, malformed values or duplicates', () => {
    const shared = Buffer.from(KEY_HEX, 'hex');
    const cn = Buffer.from(CN_HEX, 'hex');
    expect(totpKeys('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual([cn, shared]);
    expect(totpKeys('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX })).toEqual([shared]);
    expect(totpKeys('goapply', { CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual([cn]);
    expect(totpKeys('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: '  ' })).toEqual([shared]);
    expect(totpKeys('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: 'short' })).toEqual([shared]);
    expect(totpKeys('goapply', { TOTP_ENCRYPTION_KEY: 'short', CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual([cn]);
    expect(totpKeys('goapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: KEY_HEX })).toEqual([shared]);
    expect(totpKeys('goapply', {})).toEqual([]);
    expect(totpKeys('roboapply', { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual([shared]);
    expect(totpKeys('roboapply', { CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual([]);
  });

  it('a key variable that is set but unusable is skipped and NAMED (never silent), with what happens now; the value is never in the message', () => {
    expect(totpKeyProblems({})).toEqual([]);
    expect(totpKeyProblems({ TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual([]);
    expect(totpKeyProblems({ TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: '   ' })).toEqual([]);
    // A wrong-length CN key: GoApply quietly seals with the shared key, so it is reported.
    const badCn = { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: 'c'.repeat(63) };
    expect(totpKeys('goapply', badCn)).toEqual([Buffer.from(KEY_HEX, 'hex')]);
    expect(totpKeyProblems(badCn)).toEqual(['CN_TOTP_ENCRYPTION_KEY']);
    expect(totpKeyWarning('CN_TOTP_ENCRYPTION_KEY', badCn)).toBe(
      'CN_TOTP_ENCRYPTION_KEY is set but is not a 32-byte key (base64, or 64 hex characters); the brand seals new two-step secrets with the shared TOTP_ENCRYPTION_KEY instead. Fix the value or remove it.',
    );
    expect(totpKeyWarning('CN_TOTP_ENCRYPTION_KEY', badCn)).not.toContain('ccc');
    // No usable shared key behind it: two-step sign-in is unavailable on GoApply.
    expect(totpKeyWarning('CN_TOTP_ENCRYPTION_KEY', { CN_TOTP_ENCRYPTION_KEY: 'short' })).toContain('the brand has no usable key');
    // The shared key itself.
    expect(totpKeyProblems({ TOTP_ENCRYPTION_KEY: 'short', CN_TOTP_ENCRYPTION_KEY: CN_HEX })).toEqual(['TOTP_ENCRYPTION_KEY']);
    expect(totpKeyWarning('TOTP_ENCRYPTION_KEY', { TOTP_ENCRYPTION_KEY: 'short' })).toContain('unavailable for every brand without a key of its own');
    expect(totpKeyProblems({ TOTP_ENCRYPTION_KEY: 'short', CN_TOTP_ENCRYPTION_KEY: 'short' })).toEqual(['TOTP_ENCRYPTION_KEY', 'CN_TOTP_ENCRYPTION_KEY']);
  });

  it('a secret sealed with the shared key still opens after a CN key is added; new secrets use the CN key', () => {
    const before = { TOTP_ENCRYPTION_KEY: KEY_HEX };
    const after = { TOTP_ENCRYPTION_KEY: KEY_HEX, CN_TOTP_ENCRYPTION_KEY: CN_HEX };
    const old = seal(RFC_SECRET_B32, totpKey('goapply', before)!, 'user_1');
    expect(unsealWithAny(old, totpKeys('goapply', after), 'user_1')).toBe(RFC_SECRET_B32);
    const fresh = seal(RFC_SECRET_B32, totpKey('goapply', after)!, 'user_1');
    expect(unseal(fresh, Buffer.from(CN_HEX, 'hex'), 'user_1')).toBe(RFC_SECRET_B32);
    expect(() => unseal(fresh, Buffer.from(KEY_HEX, 'hex'), 'user_1')).toThrow(SealError);
    expect(unsealWithAny(fresh, totpKeys('goapply', after), 'user_1')).toBe(RFC_SECRET_B32);
    // The user id still binds the secret, whichever key opens it.
    expect(() => unsealWithAny(old, totpKeys('goapply', after), 'user_2')).toThrow(SealError);
    // The shared key taken away: the old secret no longer opens (recovery codes remain); no key at all is a SealError too.
    expect(() => unsealWithAny(old, totpKeys('goapply', { CN_TOTP_ENCRYPTION_KEY: CN_HEX }), 'user_1')).toThrow(SealError);
    expect(() => unsealWithAny(old, [], 'user_1')).toThrow(SealError);
    expect(() => unsealWithAny('v0.x.y.z', totpKeys('goapply', after), 'user_1')).toThrow(SealError);
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
