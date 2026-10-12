// @vitest-environment node
//
// WP-55a: device tokens are stored hashed; pair codes are short-lived and
// readable; signed file links are bound to user/brand/run and expire in 5 min.

import { describe, expect, it } from 'vitest';
import { EXT_TOKEN_RE, FILE_URL_TTL_MS, PAIR_CODE_ALPHABET } from './contract.js';
import {
  bearerDeviceToken,
  compareVersions,
  hashDeviceToken,
  hashPairCode,
  isBelowMinVersion,
  issueDeviceToken,
  newPairCode,
  signFileToken,
  verifyFileToken,
} from './tokens.js';

const ENV = { JWT_SECRET: 'test-secret-for-ext-files' };

describe('device tokens', () => {
  it('issues rax_ tokens and stores only the hash + an 8-char prefix', () => {
    const a = issueDeviceToken();
    const b = issueDeviceToken();
    expect(a.token).toMatch(EXT_TOKEN_RE);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashDeviceToken(a.token));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).not.toContain(a.token.slice(4));
    expect(a.tokenPrefix).toBe(a.token.slice(0, 8));
  });

  it('reads only Bearer rax_ tokens', () => {
    const { token } = issueDeviceToken();
    expect(bearerDeviceToken(`Bearer ${token}`)).toBe(token);
    expect(bearerDeviceToken(token)).toBeNull();
    expect(bearerDeviceToken('Bearer eyJhbGciOi.jwt.token')).toBeNull();
    expect(bearerDeviceToken(undefined)).toBeNull();
  });
});

describe('pair codes', () => {
  it('are 8 characters from the readable alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = newPairCode();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
      for (const ch of code) expect(PAIR_CODE_ALPHABET).toContain(ch);
    }
  });

  it('hash per brand (a code from one site never pairs on the other)', () => {
    expect(hashPairCode('roboapply', 'ABCD2345')).not.toBe(hashPairCode('goapply', 'ABCD2345'));
    expect(hashPairCode('roboapply', 'abcd2345')).toBe(hashPairCode('roboapply', 'ABCD2345'));
  });
});

describe('signed file links', () => {
  const claims = { u: 'u1', b: 'roboapply', v: 'rv1', j: 'j1', r: 'run1' };

  it('round-trips within 5 minutes', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const token = signFileToken(claims, { now, env: ENV })!;
    const check = verifyFileToken(token, { now: now + FILE_URL_TTL_MS - 1, env: ENV });
    expect(check.ok && check.claims).toMatchObject(claims);
  });

  it('expires after 5 minutes', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const token = signFileToken(claims, { now, env: ENV })!;
    expect(verifyFileToken(token, { now: now + FILE_URL_TTL_MS + 1, env: ENV })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered body or another key', () => {
    const token = signFileToken(claims, { env: ENV })!;
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, u: 'u2', exp: Date.now() + 1000 })).toString('base64url');
    expect(verifyFileToken(`${forged}.${mac}`, { env: ENV })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyFileToken(`${body}.${mac}`, { env: { JWT_SECRET: 'other' } })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyFileToken('garbage', { env: ENV }).ok).toBe(false);
  });

  it('is not issued without a signing secret', () => {
    expect(signFileToken(claims, { env: {} })).toBeNull();
  });
});

describe('versions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.1', '1.0.0')).toBe(-1);
  });

  it('judges only known versions', () => {
    expect(isBelowMinVersion('1.0.0', '1.2.0')).toBe(true);
    expect(isBelowMinVersion('1.2.0', '1.2.0')).toBe(false);
    expect(isBelowMinVersion(null, '1.2.0')).toBe(false);
    expect(isBelowMinVersion('1.0.0', null)).toBe(false);
  });
});
