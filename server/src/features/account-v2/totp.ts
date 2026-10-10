// server/src/features/account-v2/totp.ts
//
// TOTP (RFC 6238) and recovery codes for seeker two-factor sign-in
// (F-TRUST-07; TASK_PLAN.md WP-79). Node crypto only, no dependency:
//   - secrets: 20 random bytes, base32 (RFC 4648, no padding) — what every
//     authenticator app accepts;
//   - codes: HMAC-SHA1, 6 digits, 30-second steps, ±1 step of clock drift;
//   - replay guard: a step at or before the last accepted one is refused,
//     so a code read over someone's shoulder cannot be used a second time;
//   - recovery codes: 10 single-use codes `xxxx-xxxx-xxxx` from an alphabet
//     without look-alike characters; only their sha256 is stored.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SEC = 30;
/** Steps of clock drift accepted on each side of now. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case, spaces and `=` padding ignored). Throws on any other character. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('base32: invalid character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret (160 bits, base32). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 30-second step containing `now`. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SEC);
}

/** RFC 4226 HOTP value for one counter. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The code an authenticator shows at `now` (tests and diagnostics). */
export function totpAt(secretBase32: string, now: Date): string {
  return hotp(base32Decode(secretBase32), totpStep(now));
}

function sameCode(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The step a code matches within ±TOTP_WINDOW of `now`, or null. Steps at or
 * before `lastUsedStep` never match (replay guard). Every candidate is
 * compared, so timing does not reveal which step matched.
 */
export function verifyTotp(secretBase32: string, code: string, now: Date, lastUsedStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  if (secret.length === 0) return null;
  const current = totpStep(now);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    const ok = sameCode(hotp(secret, step), code);
    if (ok && matched === null && (lastUsedStep === null || step > lastUsedStep)) matched = step;
  }
  return matched;
}

/** `otpauth://` URI for authenticator apps (and the QR code). */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const issuer = input.issuer.replace(/:/g, '');
  const label = encodeURIComponent(`${issuer}:${input.account}`);
  const q = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ── Recovery codes ──────────────────────────────────────────────────────

/** Lowercase letters and digits without 0/o, 1/l/i (all inside the contract's [a-z0-9]). */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function recoveryGroup(): string {
  let s = '';
  for (let i = 0; i < 4; i += 1) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return s;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(`${recoveryGroup()}-${recoveryGroup()}-${recoveryGroup()}`);
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(`ra-recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}

/** Index of the stored hash a recovery code matches, or -1. */
export function matchRecoveryCode(hashes: readonly string[], code: string): number {
  const h = hashRecoveryCode(code);
  let found = -1;
  hashes.forEach((stored, i) => {
    if (found < 0 && sameCode(stored, h)) found = i;
  });
  return found;
}
