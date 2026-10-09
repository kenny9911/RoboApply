// server/src/platform/ratelimit/defaults.ts
//
// Rate-limit defaults (config `RATE_LIMITS`, ARCHITECTURE.md §3.10). Each
// entry is one or more fixed windows; a request passes only when every
// window has room. Owners import the entry by name:
//
//   router.post('/signup', rateLimit({ name: 'signupPerIp', by: 'ip' }), …)
//
// Per-user credit caps are NOT here (they are credit buckets, FND-4); these
// are abuse guards. Values can be overridden per deployment with
// `RATE_LIMITS_JSON` (same shape, partial), read by `rateLimitWindows()`.

export interface RateWindow {
  limit: number;
  windowSec: number;
}

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const RATE_LIMITS = {
  /** Signup per IP: 5/min, 20/day. */
  signupPerIp: [
    { limit: 5, windowSec: MINUTE },
    { limit: 20, windowSec: DAY },
  ],
  /** Login per IP: 10/min. */
  loginPerIp: [{ limit: 10, windowSec: MINUTE }],
  /** OTP per phone: 1 per 60 s, 10/day. */
  otpPerPhone: [
    { limit: 1, windowSec: MINUTE },
    { limit: 10, windowSec: DAY },
  ],
  /** OTP per IP: 30/day. */
  otpPerIp: [{ limit: 30, windowSec: DAY }],
  /** Password reset per email: 5/h. */
  passwordResetPerEmail: [{ limit: 5, windowSec: HOUR }],
  /** Feed refresh without a cursor: 20 per 10 min. */
  feedRefresh: [{ limit: 20, windowSec: 10 * MINUTE }],
  /** Assistant burst on top of the `assistant` credit bucket: 10/min. */
  copilotBurst: [{ limit: 10, windowSec: MINUTE }],
  /** Logged-out assistant per IP: 10/h, 30/day. */
  visitorCopilotPerIp: [
    { limit: 10, windowSec: HOUR },
    { limit: 30, windowSec: DAY },
  ],
  /** Job import per user: 10/h (the failure-lock rules live in WP-35). */
  jobImportPerUser: [{ limit: 10, windowSec: HOUR }],
  /** Public tools per IP: 3/day. */
  publicToolsPerIp: [{ limit: 3, windowSec: DAY }],
  /** Extension device token: 600 requests/h. */
  extensionDevice: [{ limit: 600, windowSec: HOUR }],
  /** First-party events per anonId: 120/min. */
  eventsPerAnon: [{ limit: 120, windowSec: MINUTE }],
  /** First-party events per IP for batches that carry an anonId (rotating anonIds cannot lift it): 600/min (WP-23). */
  eventsPerIp: [{ limit: 600, windowSec: MINUTE }],
  /** Password-reset requests per IP: 20/h (WP-10; the per-email cap is passwordResetPerEmail). */
  passwordResetPerIp: [{ limit: 20, windowSec: HOUR }],
  /** Password-reset submissions (new password) per IP: 10/h (WP-10). */
  passwordResetSubmitPerIp: [{ limit: 10, windowSec: HOUR }],
  /** Verification-email sends per user: 3/h (WP-10). */
  emailVerifySendPerUser: [{ limit: 3, windowSec: HOUR }],
  /** OAuth (Google/LINE) starts per IP: 30/h (WP-10). */
  oauthStartPerIp: [{ limit: 30, windowSec: HOUR }],
  /** Global guard for any authenticated route: 600/min per user. */
  authenticatedPerUser: [{ limit: 600, windowSec: MINUTE }],
} as const satisfies Record<string, readonly RateWindow[]>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export function isRateLimitName(value: unknown): value is RateLimitName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RATE_LIMITS, value);
}

function validWindows(value: unknown): RateWindow[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: RateWindow[] = [];
  for (const w of value) {
    const limit = Number((w as RateWindow)?.limit);
    const windowSec = Number((w as RateWindow)?.windowSec);
    if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(windowSec) || windowSec <= 0) return null;
    out.push({ limit, windowSec });
  }
  return out;
}

/**
 * The windows for `name`, with `RATE_LIMITS_JSON` overrides applied
 * (e.g. `{"loginPerIp":[{"limit":20,"windowSec":60}]}`). Invalid overrides
 * are ignored.
 */
export function rateLimitWindows(
  name: RateLimitName,
  env: Record<string, string | undefined> = process.env,
): RateWindow[] {
  const raw = env.RATE_LIMITS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const override = validWindows(parsed?.[name]);
      if (override) return override;
    } catch {
      // Malformed override: keep the defaults.
    }
  }
  return RATE_LIMITS[name].map((w) => ({ ...w }));
}
