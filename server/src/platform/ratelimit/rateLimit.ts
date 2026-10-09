// server/src/platform/ratelimit/rateLimit.ts
//
// DB-backed fixed-window rate limits on `RARateCounter` (ARCHITECTURE.md
// §3.1, §3.10; F-TRUST-03). Replaces the in-memory limiter for every new
// route: Vercel runs many short-lived instances, so a per-process map limits
// nothing. One atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` per window.
//
//   router.post('/login', rateLimit({ name: 'loginPerIp', by: 'ip' }), handler)
//   await assertRateLimit({ name: 'otpPerPhone', id: phoneE164 })   // in a service
//
// Over the limit → `429 rate_limited` with `Retry-After` (seconds) and
// `details.retryAfterSec`. Identifiers that are personal data (IP, email,
// phone) are hashed before they become part of a key.
// The same counters serve budgets (`budget:llm:enrich:roboapply`) through
// `consumeRateLimit({ key, windows, cost })`.

import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import prisma from '../../lib/prisma.js';
import { getCurrentBrandId } from '../../lib/requestContext.js';
import { logger } from '../../services/LoggerService.js';
import { DEFAULT_BRAND } from '../brand/registry.js';
import { HttpError, fail } from '../http.js';
import { rateLimitWindows, type RateLimitName, type RateWindow } from './defaults.js';

export type RateLimitDb = Pick<typeof prisma, '$queryRaw' | 'rARateCounter'>;

export interface WindowState {
  windowSec: number;
  limit: number;
  count: number;
  windowStart: Date;
  resetAt: Date;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the most restrictive exhausted window resets (0 when allowed). */
  retryAfterSec: number;
  /** Smallest remaining allowance across windows (never negative). */
  remaining: number;
  windows: WindowState[];
}

/** Start of the fixed window containing `now` (aligned to the epoch). */
export function windowStartFor(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Short, stable, non-reversible digest for personal identifiers in keys. */
export function hashIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 32);
}

export interface ConsumeOptions {
  /** Full counter key, e.g. 'rl:roboapply:loginPerIp:ip:<hash>'. */
  key: string;
  windows: readonly RateWindow[];
  /** Units to add (default 1). */
  cost?: number;
  now?: Date;
  db?: RateLimitDb;
}

/** Count one hit (or `cost` units) in every window and report whether all still allow it. */
export async function consumeRateLimit(options: ConsumeOptions): Promise<RateLimitResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const cost = Math.max(0, Math.floor(options.cost ?? 1));
  const windows: WindowState[] = [];
  for (const w of options.windows) {
    const windowStart = windowStartFor(now, w.windowSec);
    const resetAt = new Date(windowStart.getTime() + w.windowSec * 1000);
    const rows = await db.$queryRaw<Array<{ count: number | bigint }>>`
      INSERT INTO "RARateCounter" ("key", "windowStart", "count", "expiresAt")
      VALUES (${`${options.key}:${w.windowSec}`}, ${windowStart}, ${cost}, ${resetAt})
      ON CONFLICT ("key", "windowStart")
      DO UPDATE SET "count" = "RARateCounter"."count" + EXCLUDED."count"
      RETURNING "count"`;
    const count = Number(rows[0]?.count ?? cost);
    windows.push({ windowSec: w.windowSec, limit: w.limit, count, windowStart, resetAt });
  }
  const blocked = windows.filter((w) => w.count > w.limit);
  const retryAfterSec = blocked.length
    ? Math.max(...blocked.map((w) => Math.max(1, Math.ceil((w.resetAt.getTime() - now.getTime()) / 1000))))
    : 0;
  const remaining = windows.length ? Math.max(0, Math.min(...windows.map((w) => w.limit - w.count))) : Number.POSITIVE_INFINITY;
  return { allowed: blocked.length === 0, retryAfterSec, remaining, windows };
}

export type RateLimitScope = 'ip' | 'user' | 'id';

/** Build the counter key: `rl:<brand>:<name>:<scope>:<id>`. */
export function rateLimitKey(name: string, scope: RateLimitScope, id: string, brandId?: string): string {
  const brand = brandId ?? getCurrentBrandId() ?? DEFAULT_BRAND;
  const part = scope === 'user' ? id : hashIdentifier(id);
  return `rl:${brand}:${name}:${scope}:${part}`;
}

export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export interface AssertRateLimitOptions {
  name: RateLimitName;
  /** Identifier (phone, email, user id …); hashed unless scope is 'user'. */
  id: string;
  scope?: RateLimitScope;
  windows?: readonly RateWindow[];
  cost?: number;
  now?: Date;
  db?: RateLimitDb;
}

/** Service-level check: throws `HttpError('rate_limited')` when over the limit. */
export async function assertRateLimit(options: AssertRateLimitOptions): Promise<RateLimitResult> {
  const result = await consumeRateLimit({
    key: rateLimitKey(options.name, options.scope ?? 'id', options.id),
    windows: options.windows ?? rateLimitWindows(options.name),
    cost: options.cost,
    now: options.now,
    db: options.db,
  });
  if (!result.allowed) {
    throw new HttpError('rate_limited', undefined, { retryAfterSec: result.retryAfterSec }, {
      'Retry-After': String(result.retryAfterSec),
    });
  }
  return result;
}

export interface RateLimitMiddlewareOptions {
  /** A RATE_LIMITS entry; also the key name. */
  name: RateLimitName | (string & {});
  /** Windows; defaults to the RATE_LIMITS entry for `name`. */
  windows?: readonly RateWindow[];
  /** Key source (default 'ip'). 'user' needs requireAuth first; anonymous requests fall back to IP. */
  by?: 'ip' | 'user';
  /** Custom identifier; return null to skip limiting this request. */
  key?: (req: Request) => string | null | undefined;
  cost?: number;
  /**
   * On a database error: 'open' lets the request through (default; logged),
   * 'closed' answers 429 (retry in 60 s) so abuse-sensitive paths (SMS)
   * never run unmetered.
   */
  failMode?: 'open' | 'closed';
  db?: RateLimitDb;
  now?: () => Date;
}

/** Express middleware form. Responds `429 rate_limited` + `Retry-After` when over the limit. */
export function rateLimit(options: RateLimitMiddlewareOptions): RequestHandler {
  const windows =
    options.windows ?? rateLimitWindows(options.name as RateLimitName);
  if (!windows || windows.length === 0) {
    throw new Error(`rateLimit: no windows for "${options.name}"`);
  }
  return async function rateLimitGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    let key: string;
    if (options.key) {
      const id = options.key(req);
      if (!id) {
        next();
        return;
      }
      key = rateLimitKey(options.name, 'id', id);
    } else {
      const userId = (req as Request & { user?: { id?: string } }).user?.id;
      key =
        options.by === 'user' && userId
          ? rateLimitKey(options.name, 'user', userId)
          : rateLimitKey(options.name, 'ip', clientIp(req));
    }
    try {
      const result = await consumeRateLimit({
        key,
        windows,
        cost: options.cost,
        now: options.now?.(),
        db: options.db,
      });
      if (!result.allowed) {
        fail(res, 'rate_limited', undefined, { retryAfterSec: result.retryAfterSec });
        return;
      }
      next();
    } catch (err) {
      logger.error('RATE_LIMIT', `rate limit check failed (${options.failMode ?? 'open'})`, {
        name: options.name,
        error: err instanceof Error ? err.message : String(err),
      });
      if (options.failMode === 'closed') {
        fail(res, 'rate_limited', 'Try again in a minute.', { retryAfterSec: 60 });
        return;
      }
      next();
    }
  };
}

/** Delete counters whose window has ended (run by `jobs-maintain`). */
export async function pruneRateCounters(options: { db?: RateLimitDb; now?: Date } = {}): Promise<{ deleted: number }> {
  const db = options.db ?? prisma;
  const { count } = await db.rARateCounter.deleteMany({ where: { expiresAt: { lt: options.now ?? new Date() } } });
  return { deleted: count };
}
