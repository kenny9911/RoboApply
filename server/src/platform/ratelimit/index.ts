// server/src/platform/ratelimit/index.ts — public surface of the DB-backed rate limiter.

export {
  assertRateLimit,
  clientIp,
  consumeRateLimit,
  hashIdentifier,
  pruneRateCounters,
  rateLimit,
  rateLimitKey,
  windowStartFor,
} from './rateLimit.js';
export type {
  AssertRateLimitOptions,
  ConsumeOptions,
  RateLimitDb,
  RateLimitMiddlewareOptions,
  RateLimitResult,
  RateLimitScope,
  WindowState,
} from './rateLimit.js';
export { DAY, HOUR, MINUTE, RATE_LIMITS, isRateLimitName, rateLimitWindows } from './defaults.js';
export type { RateLimitName, RateWindow } from './defaults.js';
