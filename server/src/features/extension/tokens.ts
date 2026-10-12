// server/src/features/extension/tokens.ts — device tokens, pair codes, signed
// file links and version checks for the extension (ARCHITECTURE.md §6.3).
//
//   device token  'rax_' + 32 random bytes (base64url); only sha256(token) is
//                 stored (RAExtensionDevice.tokenHash) with the first 8
//                 characters for the devices list.
//   pair code     8 characters from PAIR_CODE_ALPHABET; stored as
//                 sha256(brand + code) in RAAuthToken (kind 'ext_pair'), 10 min.
//   file link     `<base64url(json)>.<hmac>`; HMAC key derived from
//                 JWT_SECRET with a fixed label; 5 min; bound to user, brand,
//                 run, job and resume version.

import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { EXT_TOKEN_PREFIX, EXT_TOKEN_RE, FILE_URL_TTL_MS, PAIR_CODE_ALPHABET } from './contract.js';

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface IssuedDeviceToken {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function issueDeviceToken(random: (n: number) => Buffer = crypto.randomBytes): IssuedDeviceToken {
  const token = `${EXT_TOKEN_PREFIX}${random(32).toString('base64url')}`;
  return { token, tokenHash: hashDeviceToken(token), tokenPrefix: token.slice(0, 8) };
}

export function hashDeviceToken(token: string): string {
  return sha256Hex(token);
}

/** The `rax_…` token of an `Authorization: Bearer` header, or null. */
export function bearerDeviceToken(header: string | undefined | null): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return EXT_TOKEN_RE.test(token) ? token : null;
}

export function newPairCode(random: (n: number) => Buffer = crypto.randomBytes): string {
  const bytes = random(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += PAIR_CODE_ALPHABET[bytes[i]! % PAIR_CODE_ALPHABET.length];
  return out;
}

export function hashPairCode(brand: string, code: string): string {
  return sha256Hex(`ext_pair:${brand}:${code.toUpperCase()}`);
}

// ── Signed file links ─────────────────────────────────────────────────────

export interface FileClaims {
  /** user id */
  u: string;
  /** brand id */
  b: string;
  /** resume version id */
  v: string;
  /** job id */
  j: string;
  /** autofill run id */
  r: string;
  /** expiry, epoch ms */
  exp: number;
}

function fileKey(env: EnvSource): Buffer | null {
  const jwt = env.JWT_SECRET?.trim();
  if (!jwt) return null;
  return crypto.createHmac('sha256', jwt).update('roboapply:ext-file:v1').digest();
}

function mac(body: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(body).digest('base64url');
}

/** Null when no signing secret is configured (the caller answers 501 provider_not_configured). */
export function signFileToken(claims: Omit<FileClaims, 'exp'>, options: { now?: number; env?: EnvSource } = {}): string | null {
  const key = fileKey(options.env ?? process.env);
  if (!key) return null;
  const body = Buffer.from(JSON.stringify({ ...claims, exp: (options.now ?? Date.now()) + FILE_URL_TTL_MS })).toString('base64url');
  return `${body}.${mac(body, key)}`;
}

export type FileTokenCheck = { ok: true; claims: FileClaims } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyFileToken(token: string, options: { now?: number; env?: EnvSource } = {}): FileTokenCheck {
  const key = fileKey(options.env ?? process.env);
  const dot = token.indexOf('.');
  if (!key || dot <= 0) return { ok: false, reason: 'invalid' };
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(body, key));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
  let claims: FileClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FileClaims;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!claims || typeof claims.u !== 'string' || typeof claims.v !== 'string' || typeof claims.exp !== 'number') return { ok: false, reason: 'invalid' };
  if ((options.now ?? Date.now()) > claims.exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

// ── Versions ──────────────────────────────────────────────────────────────

/** Compare dotted numeric versions ('1.10.0' > '1.9.2'); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `version` is known and below `min` (unknown versions are not judged). */
export function isBelowMinVersion(version: string | null | undefined, min: string | null | undefined): boolean {
  if (!version || !min) return false;
  return compareVersions(version, min) < 0;
}
