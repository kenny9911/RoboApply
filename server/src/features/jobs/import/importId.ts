// server/src/features/jobs/import/importId.ts — import ids (WP-35).
//
// Drafts are not stored (the page text stays only in the user's browser until
// they save), so a draft's id is a signed, self-describing token:
//
//   draft_<base64url(json)>.<hmac>     json = { u, s, m, r, x, n }
//
// It lets GET /jobs/import/:importId answer for a draft, and lets the save
// that confirms a draft count against the hourly limit only once: `n` is a
// random nonce the confirming save claims in RARateCounter (single use, see
// limits.ts claimDraft), so a draft id cannot be replayed to skip the limit.
// A saved job's id is `job_<RAJob.id>`.
//
// Secret: HMAC key derived from JWT_SECRET with a fixed label (domain
// separated, never the JWT key itself). Without it drafts are unsigned: the
// GET answers not found and a confirming save counts as a new import.

import crypto from 'node:crypto';
import type { EnvSource } from '../../../platform/brand/index.js';
import { IMPORT_FIELDS, IMPORT_REASONS, type ImportField, type ImportReason, type ImportStatus } from './contract.js';

const DRAFT_PREFIX = 'draft_';
const JOB_PREFIX = 'job_';
/** A draft id is honoured for this long. */
export const DRAFT_TTL_SEC = 2 * 60 * 60;

export type DraftStatus = Extract<ImportStatus, 'needs_text' | 'needs_fields' | 'failed'>;

export interface DraftClaims {
  userId: string;
  status: DraftStatus;
  missingFields: ImportField[];
  reason: ImportReason | null;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Single-use nonce (null on an id issued before nonces existed: never confirmable). */
  nonce: string | null;
}

/** Only a draft the user was asked to check or complete can be confirmed by a save. */
export function isConfirmableDraft(claims: DraftClaims | null): claims is DraftClaims & { nonce: string } {
  return !!claims && !!claims.nonce && (claims.status === 'needs_fields' || claims.status === 'needs_text');
}

function secret(env: EnvSource): Buffer | null {
  const jwt = env.JWT_SECRET?.trim();
  if (!jwt) return null;
  return crypto.createHmac('sha256', jwt).update('roboapply:job-import-draft:v1').digest();
}

function sign(body: string, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(body).digest('base64url').slice(0, 32);
}

export function jobImportId(jobId: string): string {
  return `${JOB_PREFIX}${jobId}`;
}

export function jobIdFromImportId(importId: string): string | null {
  return importId.startsWith(JOB_PREFIX) && importId.length > JOB_PREFIX.length ? importId.slice(JOB_PREFIX.length) : null;
}

const STATUS_CODE: Record<DraftStatus, string> = { needs_text: 't', needs_fields: 'f', failed: 'x' };
const CODE_STATUS: Record<string, DraftStatus> = { t: 'needs_text', f: 'needs_fields', x: 'failed' };

/** A signed draft id, or an unsigned random one when no secret is configured. */
export function draftImportId(claims: Omit<DraftClaims, 'exp' | 'nonce'>, options: { env?: EnvSource; now?: Date } = {}): string {
  const env = options.env ?? process.env;
  const key = secret(env);
  if (!key) return `${DRAFT_PREFIX}${crypto.randomBytes(12).toString('base64url')}`;
  const exp = Math.floor((options.now ?? new Date()).getTime() / 1000) + DRAFT_TTL_SEC;
  const payload = {
    u: claims.userId,
    s: STATUS_CODE[claims.status],
    m: claims.missingFields.map((f) => IMPORT_FIELDS.indexOf(f)).filter((i) => i >= 0),
    r: claims.reason ? IMPORT_REASONS.indexOf(claims.reason) : -1,
    x: exp,
    n: crypto.randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${DRAFT_PREFIX}${body}.${sign(body, key)}`;
}

/** The claims of a valid, unexpired draft id issued to `userId`, else null. */
export function verifyDraftImportId(importId: string, userId: string, options: { env?: EnvSource; now?: Date } = {}): DraftClaims | null {
  if (!importId.startsWith(DRAFT_PREFIX)) return null;
  const key = secret(options.env ?? process.env);
  if (!key) return null;
  const rest = importId.slice(DRAFT_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = sign(body, key);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let p: { u?: unknown; s?: unknown; m?: unknown; r?: unknown; x?: unknown; n?: unknown };
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof p;
  } catch {
    return null;
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (p.u !== userId || typeof p.x !== 'number' || p.x < now) return null;
  const status = typeof p.s === 'string' ? CODE_STATUS[p.s] : undefined;
  if (!status) return null;
  const missing = Array.isArray(p.m) ? p.m.map((i) => IMPORT_FIELDS[Number(i)]).filter((f): f is ImportField => !!f) : [];
  const reason = typeof p.r === 'number' && p.r >= 0 ? (IMPORT_REASONS[p.r] ?? null) : null;
  const nonce = typeof p.n === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(p.n) ? p.n : null;
  return { userId, status, missingFields: missing, reason, exp: p.x, nonce };
}
