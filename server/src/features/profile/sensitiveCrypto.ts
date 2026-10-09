// server/src/features/profile/sensitiveCrypto.ts
//
// AES-256-GCM for `RASensitiveAnswers` (EEO answers on RoboApply; 籍贯 /
// 政治面貌 / 家庭成员 / photo id on GoApply). Same envelope as
// server/src/lib/crypto.ts — base64(IV ‖ AuthTag ‖ Ciphertext), 96-bit IV —
// but keyed by its own secret, `SENSITIVE_DATA_KEY`, never the general
// FIELD_ENCRYPTION_KEY, and with the user id as additional authenticated
// data so a ciphertext copied onto another user's row does not decrypt.
// (lib/crypto.ts reads one fixed env key and is not ours to change; INT may
// fold this into a keyed variant there — handoff request.)
//
// Key versions: `SENSITIVE_DATA_KEY` is version `SENSITIVE_DATA_KEY_VERSION`
// (default 1). During a rotation the previous key stays readable as
// `SENSITIVE_DATA_KEY_PREVIOUS` (version current − 1); rows are re-encrypted
// with the current key on their next save.
//
// No key → `configured() === false`: reads return nothing and writes are
// refused. There is no fallback key, in any environment.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT = 'roboapply-sensitive-answers-v1';

export type CryptoEnv = Record<string, string | undefined>;

export class SensitiveKeyMissingError extends Error {
  constructor(version?: number) {
    super(version === undefined ? 'SENSITIVE_DATA_KEY is not set.' : `No SENSITIVE_DATA_KEY for key version ${version}.`);
    this.name = 'SensitiveKeyMissingError';
  }
}

function deriveKey(raw: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : scryptSync(raw, SALT, 32);
}

const keyCache = new Map<string, Buffer>();
function keyFrom(raw: string): Buffer {
  let key = keyCache.get(raw);
  if (!key) {
    key = deriveKey(raw);
    keyCache.set(raw, key);
  }
  return key;
}

export function currentKeyVersion(env: CryptoEnv = process.env): number {
  const v = Number.parseInt(env.SENSITIVE_DATA_KEY_VERSION ?? '', 10);
  return Number.isInteger(v) && v > 0 ? v : 1;
}

/** True when sensitive answers can be stored on this deployment. */
export function sensitiveCryptoConfigured(env: CryptoEnv = process.env): boolean {
  return Boolean(env.SENSITIVE_DATA_KEY && env.SENSITIVE_DATA_KEY.trim());
}

function keyFor(version: number, env: CryptoEnv): Buffer {
  const current = currentKeyVersion(env);
  const raw = version === current ? env.SENSITIVE_DATA_KEY : version === current - 1 ? env.SENSITIVE_DATA_KEY_PREVIOUS : undefined;
  if (!raw || !raw.trim()) throw new SensitiveKeyMissingError(version);
  return keyFrom(raw.trim());
}

export interface SealedSensitive {
  ciphertext: string;
  keyVersion: number;
}

/** Encrypt a JSON value for `userId` with the current key. */
export function sealSensitive(userId: string, value: unknown, env: CryptoEnv = process.env): SealedSensitive {
  if (!sensitiveCryptoConfigured(env)) throw new SensitiveKeyMissingError();
  const keyVersion = currentKeyVersion(env);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, keyFor(keyVersion, env), iv);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'), keyVersion };
}

/** Decrypt a row written by `sealSensitive` for the same `userId`. Throws on tampering or a wrong user. */
export function openSensitive<T = unknown>(userId: string, sealed: SealedSensitive, env: CryptoEnv = process.env): T {
  const buf = Buffer.from(sealed.ciphertext, 'base64');
  if (buf.length < IV_LENGTH + TAG_LENGTH) throw new Error('Sensitive answers are malformed.');
  const decipher = createDecipheriv(ALGO, keyFor(sealed.keyVersion, env), buf.subarray(0, IV_LENGTH));
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  const plain = Buffer.concat([decipher.update(buf.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
