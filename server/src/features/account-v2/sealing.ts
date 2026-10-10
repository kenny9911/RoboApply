// server/src/features/account-v2/sealing.ts
//
// TOTP secrets are stored sealed (AES-256-GCM), never in clear text. The key
// is per brand (TASK_PLAN.md R-03): `TOTP_ENCRYPTION_KEY` for RoboApply,
// `CN_TOTP_ENCRYPTION_KEY` for GoApply, 32 bytes as base64 or 64 hex
// characters; no fallback between brands. The user id is the additional
// authenticated data, so a sealed secret copied onto another user's row does
// not open.
//
// Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';

export const TOTP_KEY_ENV = 'TOTP_ENCRYPTION_KEY';

/** The brand's 32-byte key, or null when unset or malformed. */
export function totpKey(brand: BrandId, env: EnvSource = process.env): Buffer | null {
  const raw = brandEnv(brand, TOTP_KEY_ENV, env);
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export function seal(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function unseal(sealed: string, key: Buffer, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new SealError('Unknown sealed format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new SealError('The sealed value does not open with this key');
  }
}
