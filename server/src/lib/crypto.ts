/**
 * General-purpose field-level encryption for sensitive data stored in the DB.
 *
 * AES-256-GCM. Key comes from FIELD_ENCRYPTION_KEY env var (hex, 64 chars = 32
 * bytes) or is derived from it via scrypt if it isn't already hex-encoded.
 *
 * Output format: base64(IV || AuthTag || Ciphertext)
 *
 * Use this for `ExternalSourceConfig.credentials`, API keys in tenant config,
 * and any other per-row sensitive field. For ATS credentials specifically,
 * keep using `backend/src/services/ats/CredentialEncryption.ts` (separate key).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32',
    );
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    // Derive a 32-byte key from an arbitrary passphrase so devs can start without
    // hex-encoded keys. Salt is fixed for deterministic derivation.
    cachedKey = scryptSync(raw, 'robohire-field-encryption-v1', 32);
  }
  return cachedKey;
}

export function encryptField(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptField(encoded: string): string {
  const key = loadKey();
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted value is malformed: too short');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Convenience: encrypt a JSON-serializable object and return the base64 string. */
export function encryptJson(obj: unknown): string {
  return encryptField(JSON.stringify(obj));
}

/** Convenience: decrypt + JSON.parse. */
export function decryptJson<T = unknown>(encoded: string): T {
  return JSON.parse(decryptField(encoded)) as T;
}
