// server/src/features/growth/referralCodes.ts — invite codes (F-GROW-01; WP-60).
//
// A code is 8 characters of Crockford base32 (0-9, A-Z without I, L, O, U),
// stored in RAReferralCode.code (unique) and shared as `/r/<code>`. People
// retype codes, so reading is forgiving: case is ignored, O reads as 0 and
// I/L read as 1, spaces and dashes are dropped. Pure helpers, no I/O.

import crypto from 'node:crypto';
import { REFERRAL_CODE_RE } from './contract.js';

export const REFERRAL_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;

/** A fresh random code (crypto randomness; 32^8 ≈ 1.1e12 codes). */
export function generateReferralCode(randomBytes: (n: number) => Uint8Array = (n) => crypto.randomBytes(n)): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) out += REFERRAL_CODE_ALPHABET[bytes[i]! & 31];
  return out;
}

/** The canonical code for user input, or null when it cannot be one. */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return REFERRAL_CODE_RE.test(s) ? s : null;
}

/** The site path of an invite link. */
export function invitePath(code: string): string {
  return `/r/${code}`;
}
