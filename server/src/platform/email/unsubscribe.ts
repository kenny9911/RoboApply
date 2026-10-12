// server/src/platform/email/unsubscribe.ts
//
// Signed one-click unsubscribe tokens (RFC 8058; ARCHITECTURE.md §8.1,
// PRODUCT_PLAN.md §7.1, F-NOTIF-04). Every non-transactional email carries
//   List-Unsubscribe: <https://<origin>/api/v1/public/email/unsubscribe?token=…>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
// and a footer link to the web page /unsubscribe/<token>.
//
// Tokens are stateless HMAC-SHA256 signatures, so a bulk alert send needs no
// database row per message and the link keeps working (RFC 8058 links must
// not expire quickly). The payload names the brand, the list and the user (or
// a hash of the address for a send with no account); it never carries the
// address itself. The public route that consumes them is WP-39b's
// (`/api/v1/public/email/unsubscribe`), which calls `verifyUnsubscribeToken`.
//
// Secret: `EMAIL_UNSUBSCRIBE_SECRET`; when unset, a key derived from
// `JWT_SECRET` with a fixed label (domain-separated, never the JWT key itself).

import crypto from 'node:crypto';
import { isBrandId, type BrandId } from '../brand/registry.js';

export type EnvLike = Record<string, string | undefined>;

/** The lists a person can leave. Transactional mail has no list. */
export const UNSUBSCRIBE_LISTS = ['alerts', 'tips', 'marketing', 'digest', 'reminders'] as const;
export type UnsubscribeList = (typeof UNSUBSCRIBE_LISTS)[number];

export interface UnsubscribePayload {
  v: 1;
  brand: BrandId;
  list: UnsubscribeList;
  /** User id when the recipient has an account. */
  userId?: string;
  /** sha256(lowercase email) when there is no account (e.g. logged-out alerts). */
  emailHash?: string;
  /** Template key that carried the link (for the reason survey). */
  template?: string;
  /** Issued at (unix seconds). */
  iat: number;
}

export class UnsubscribeConfigError extends Error {
  constructor() {
    super('EMAIL_UNSUBSCRIBE_SECRET (or JWT_SECRET) must be set to sign unsubscribe links.');
    this.name = 'UnsubscribeConfigError';
  }
}

const TOKEN_PREFIX = 'u1';

export function unsubscribeSecret(env: EnvLike = process.env): Buffer {
  const direct = env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (direct) return Buffer.from(direct, 'utf8');
  const jwt = env.JWT_SECRET?.trim();
  if (jwt) return crypto.createHmac('sha256', jwt).update('roboapply:email-unsubscribe:v1').digest();
  throw new UnsubscribeConfigError();
}

export function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(body: string, secret: Buffer): string {
  return crypto.createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${body}`).digest('base64url');
}

export interface CreateUnsubscribeTokenInput {
  brand: BrandId;
  list: UnsubscribeList;
  userId?: string | null;
  email?: string | null;
  template?: string;
  now?: Date;
  env?: EnvLike;
}

export function createUnsubscribeToken(input: CreateUnsubscribeTokenInput): string {
  if (!input.userId && !input.email) throw new Error('unsubscribe token needs a userId or an email');
  const payload: UnsubscribePayload = {
    v: 1,
    brand: input.brand,
    list: input.list,
    iat: Math.floor((input.now ?? new Date()).getTime() / 1000),
  };
  if (input.userId) payload.userId = input.userId;
  else if (input.email) payload.emailHash = hashEmail(input.email);
  if (input.template) payload.template = input.template;
  const body = b64url(JSON.stringify(payload));
  return `${TOKEN_PREFIX}.${body}.${sign(body, unsubscribeSecret(input.env))}`;
}

export type VerifyResult =
  | { ok: true; payload: UnsubscribePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'wrong_brand' | 'expired' };

/**
 * Verify a token. `expectedBrand` rejects a token minted for the other brand.
 * `maxAgeDays` is optional; by default tokens do not expire (RFC 8058).
 */
export function verifyUnsubscribeToken(
  token: string,
  options: { expectedBrand?: BrandId; maxAgeDays?: number; now?: Date; env?: EnvLike } = {},
): VerifyResult {
  const parts = typeof token === 'string' ? token.trim().split('.') : [];
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts as [string, string, string];
  const expected = sign(body, unsubscribeSecret(options.env));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  let payload: UnsubscribePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UnsubscribePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    payload?.v !== 1 ||
    !isBrandId(payload.brand) ||
    !(UNSUBSCRIBE_LISTS as readonly string[]).includes(payload.list) ||
    (!payload.userId && !payload.emailHash) ||
    typeof payload.iat !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (options.expectedBrand && payload.brand !== options.expectedBrand) return { ok: false, reason: 'wrong_brand' };
  if (options.maxAgeDays !== undefined) {
    const ageSec = Math.floor((options.now ?? new Date()).getTime() / 1000) - payload.iat;
    if (ageSec > options.maxAgeDays * 86_400) return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

/** URLs for one token: the one-click API endpoint (header) and the web page (footer). */
export function unsubscribeUrls(origin: string, token: string): { oneClick: string; page: string } {
  const base = origin.replace(/\/+$/, '');
  return {
    oneClick: `${base}/api/v1/public/email/unsubscribe?token=${encodeURIComponent(token)}`,
    page: `${base}/unsubscribe/${encodeURIComponent(token)}`,
  };
}

/** RFC 8058 headers. */
export function listUnsubscribeHeaders(oneClickUrl: string, mailto?: string): Record<string, string> {
  const targets = [`<${oneClickUrl}>`];
  if (mailto) targets.push(`<mailto:${mailto}?subject=unsubscribe>`);
  return {
    'List-Unsubscribe': targets.join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
