// server/src/features/account-v2/sealing.ts
//
// TOTP secrets are stored sealed (AES-256-GCM), never in clear text. The key
// is 32 bytes as base64 or 64 hex characters.
//
// Which key (GOAPPLY_PARITY_PLAN.md §3.7, owner ruling D5): RoboApply uses
// `TOTP_ENCRYPTION_KEY`. GoApply uses `CN_TOTP_ENCRYPTION_KEY` when it is set
// and otherwise the shared `TOTP_ENCRYPTION_KEY`, so two-step sign-in works on
// GoApply with only the shared key. New secrets are sealed with the first key
// of `totpKeys(brand)`; a stored secret is opened with whichever of them opens
// it (`unsealWithAny`). So when a CN key is added later, secrets sealed with
// the shared key still open and nobody is locked out; new secrets use the CN
// key. RoboApply never reads the CN key.
//
// A key variable that is set but is not a 32-byte key is skipped, so a
// mistyped `CN_TOTP_ENCRYPTION_KEY` does not take two-step sign-in away from
// GoApply: it falls back to the shared key. That fallback must not be silent
// (the operator would believe GoApply secrets are sealed with GoApply's key),
// so `totpKeyProblems(env)` names every such variable and the two-step router
// logs them once when it is built. The value itself is never logged.
//
// The user id is the additional authenticated data, so a sealed secret copied
// onto another user's row does not open, with any key.
//
// Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { brandEnvName, brandOwnEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { BRAND_IDS, type BrandId } from '../../platform/brand/registry.js';

export const TOTP_KEY_ENV = 'TOTP_ENCRYPTION_KEY';

/** A 32-byte key from its hex or base64 form; null when blank or malformed. */
function parseKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  return buf.length === 32 ? buf : null;
}

/**
 * The keys the brand may use, best first, without blanks or malformed values:
 * the brand's own key (`CN_TOTP_ENCRYPTION_KEY` for GoApply), then the shared
 * `TOTP_ENCRYPTION_KEY`. For RoboApply both names are the same one key. Seal
 * with the first; try each to unseal.
 */
export function totpKeys(brand: BrandId, env: EnvSource = process.env): Buffer[] {
  const keys: Buffer[] = [];
  for (const raw of [brandOwnEnv(brand, TOTP_KEY_ENV, env), env[TOTP_KEY_ENV]]) {
    const key = parseKey(raw);
    if (key && !keys.some((k) => k.equals(key))) keys.push(key);
  }
  return keys;
}

/**
 * The names of the key variables that are set but unusable (not 32 bytes as
 * base64 or 64 hex characters): `CN_TOTP_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`
 * or both. Such a variable is skipped by `totpKeys`, so nothing breaks, and
 * that is exactly why it has to be reported. Names only, never a value.
 */
export function totpKeyProblems(env: EnvSource = process.env): string[] {
  const names: string[] = [];
  for (const brand of BRAND_IDS) {
    const name = brandEnvName(brand, TOTP_KEY_ENV);
    if (names.includes(name)) continue;
    const raw = brandOwnEnv(brand, TOTP_KEY_ENV, env);
    if (raw?.trim() && !parseKey(raw)) names.push(name);
  }
  return names;
}

/** The log line for one name of `totpKeyProblems`: what the mistake does now, and how to fix it. */
export function totpKeyWarning(name: string, env: EnvSource = process.env): string {
  const shared = name === TOTP_KEY_ENV;
  const fallback = shared
    ? 'two-step sign-in is unavailable for every brand without a key of its own'
    : parseKey(env[TOTP_KEY_ENV])
      ? `the brand seals new two-step secrets with the shared ${TOTP_KEY_ENV} instead`
      : 'the brand has no usable key, so two-step sign-in is unavailable for it';
  return `${name} is set but is not a 32-byte key (base64, or 64 hex characters); ${fallback}. Fix the value or remove it.`;
}

/** The key new secrets are sealed with (the first of `totpKeys`), or null when the brand has none. */
export function totpKey(brand: BrandId, env: EnvSource = process.env): Buffer | null {
  return totpKeys(brand, env)[0] ?? null;
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

/**
 * Opens a sealed value with the first of `keys` that opens it. Throws
 * `SealError` when none does (or when the format is unknown): a key that was
 * rotated away, or a row sealed for another user.
 */
export function unsealWithAny(sealed: string, keys: readonly Buffer[], aad: string): string {
  let last: SealError = new SealError('No key to open the sealed value with');
  for (const key of keys) {
    try {
      return unseal(sealed, key, aad);
    } catch (err) {
      if (!(err instanceof SealError)) throw err;
      last = err;
    }
  }
  throw last;
}
