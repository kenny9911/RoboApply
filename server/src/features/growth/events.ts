// server/src/features/growth/events.ts — the typed first-party event registry
// (ARCHITECTURE.md §10.4 "Product funnels"; TASK_PLAN.md WP-23).
//
// Every `RAProductEvent.name` comes from this table. The web client imports
// the types only (lib/api/contracts/growth.ts → contract.ts re-exports these),
// so `track('job_saved', { jobId })` is checked at compile time and the server
// checks again at ingest: an unknown name is rejected, unknown prop keys are
// dropped, and string values that look like contact details are dropped.
//
// Privacy rules encoded here (PRODUCT_PLAN.md §4.1 "Analytics", H28):
//   - Events go to our own database only. No third-party pixels.
//   - RoboApply visitors from the EEA, the UK and Switzerland are linked to an
//     `anonId` or an account only after the analytics consent banner.
//   - Rows are kept at most EVENT_RETENTION_DAYS (≈13 months) and are deleted
//     with the account (`deleteEventsForUser`).
//
// Adding an event: add a row below with the prop keys it may carry (ids,
// enums, counts — never free text a person typed, never contact details).

/** Prop value types an event may carry (the wire schema allows the same). */
export type EventPropValue = string | number | boolean | null;

interface EventDefinition {
  /** Allowed prop keys. Anything else is dropped at ingest. */
  readonly props: readonly string[];
}

export const PRODUCT_EVENTS = {
  // Navigation
  page_viewed: { props: ['referrerHost', 'locale'] },
  // Onboarding (PRODUCT_PLAN.md §4.1)
  onboarding_step_viewed: { props: ['stage', 'branch'] },
  onboarding_step_completed: { props: ['stage', 'durationMs', 'skipped', 'branch'] },
  onboarding_abandoned: { props: ['stage', 'branch'] },
  // Feed (F-FEED-09; F-GROW-07 feed rating telemetry)
  feed_card_impression: { props: ['jobId', 'position', 'tier', 'feedSessionId'] },
  feed_rating_submitted: { props: ['rating', 'reasons', 'reasonCount', 'feedSessionId'] },
  feed_filter_changed: { props: ['filter', 'from'] },
  job_opened: { props: ['jobId', 'from', 'position'] },
  job_saved: { props: ['jobId', 'from'] },
  apply_clicked: { props: ['jobId', 'from'] },
  // Resume, tailoring, cover letters
  resume_check_viewed: { props: ['issueCount', 'from'] },
  tailor_started: { props: ['jobId', 'from'] },
  tailor_finalized: { props: ['jobId'] },
  cover_letter_started: { props: ['jobId', 'from'] },
  cover_letter_completed: { props: ['jobId'] },
  // Practice
  practice_started: { props: ['jobId', 'from', 'format'] },
  practice_completed: { props: ['jobId', 'format', 'durationMs'] },
  // Assistant, Ready to apply, extension
  assistant_opened: { props: ['from', 'jobId'] },
  ready_kit_opened: { props: ['jobId'] },
  extension_installed: { props: ['from'] },
  extension_paired: { props: ['from'] },
  autofill_run: { props: ['site', 'fieldsFilled', 'fieldsLeft'] },
  // Plans
  upgrade_viewed: { props: ['from', 'bucket'] },
  upgrade_clicked: { props: ['from', 'planKey'] },
  checkout_started: { props: ['planKey', 'rail'] },
  // Getting-started checklist (F-GROW-05): views and taps only. Completion is
  // server state (growth.markChecklistStep), never an event the client sends.
  checklist_viewed: { props: ['doneCount'] },
  checklist_item_clicked: { props: ['step'] },
  checklist_dismissed: { props: ['doneCount'] },
} as const satisfies Record<string, EventDefinition>;

export type ProductEventName = keyof typeof PRODUCT_EVENTS;
/** The prop keys event `N` may carry. */
export type ProductEventPropKey<N extends ProductEventName> = (typeof PRODUCT_EVENTS)[N]['props'][number];
/** Typed props of event `N` (all optional). */
export type ProductEventProps<N extends ProductEventName> = Partial<Record<ProductEventPropKey<N>, EventPropValue>>;

export const PRODUCT_EVENT_NAMES = Object.freeze(Object.keys(PRODUCT_EVENTS)) as readonly ProductEventName[];

export function isProductEventName(name: unknown): name is ProductEventName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT_EVENTS, name);
}

// ── Limits ───────────────────────────────────────────────────────────────

/** Events in one POST (the wire schema enforces the same). */
export const MAX_EVENTS_PER_BATCH = 50;
/**
 * Per-IP ceiling on events, applied to every batch on top of the per-anonId
 * window (`RATE_LIMITS.eventsPerAnon`, 120/min). The anonId comes from the
 * request body, so without this a client could rotate ids and never hit a
 * limit. Higher than the per-anonId window so a shared office or campus IP
 * is not throttled by normal use. The windows live in
 * `RATE_LIMITS.eventsPerIp` (platform/ratelimit/defaults.ts, overridable
 * with `RATE_LIMITS_JSON`); this copy of the default stays import-free
 * because the web contract re-exports this module.
 */
export const EVENTS_PER_IP_WINDOWS: readonly { limit: number; windowSec: number }[] = [{ limit: 600, windowSec: 60 }];
/** Rate-limit key name of the per-IP ceiling. */
export const EVENTS_PER_IP_KEY = 'eventsPerIp';
/** Retention: ≈13 months (H28; WP-13's retention schedule calls the prune). */
export const EVENT_RETENTION_DAYS = 395;
/** Longest string prop kept. */
export const MAX_PROP_STRING = 200;
/** An event's `at` may be this old (client clocks and offline buffers) … */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
/** … or this far in the future; outside the window the server time is used. */
export const MAX_EVENT_SKEW_MS = 5 * 60 * 1000;

// ── Cookies (shared names; the web mirrors them in lib/analytics.ts) ────

/** First-party anonymous id. Set only after consent where consent is required. */
export const ANON_ID_COOKIE = 'ra_anon';
/** The visitor's analytics choice: 'granted' | 'denied'. Absent = not asked yet. */
export const ANALYTICS_CONSENT_COOKIE = 'ra_analytics_consent';
export const ANON_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type AnalyticsConsentChoice = 'granted' | 'denied';

// ── Consent region (EEA + UK + CH) ───────────────────────────────────────

/** EU 27 + Iceland, Liechtenstein, Norway (EEA) + United Kingdom + Switzerland. */
export const CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
]);

/**
 * Whether analytics needs the visitor's consent before any identifier is set
 * or any event is linked. RoboApply (market `intl`) asks visitors in the EEA,
 * the UK and Switzerland, and — erring on the side of privacy — visitors whose
 * country is unknown. GoApply lists event collection in its personal
 * information list instead (WP-13), so it never shows the banner.
 */
export function isAnalyticsConsentRequired(market: 'intl' | 'cn', country: string | null | undefined): boolean {
  if (market !== 'intl') return false;
  if (!country) return true;
  return CONSENT_REQUIRED_COUNTRIES.has(country.trim().toUpperCase());
}

export function parseConsentChoice(value: unknown): AnalyticsConsentChoice | null {
  return value === 'granted' || value === 'denied' ? value : null;
}

/** Linking (anonId, account) is allowed when consent is not required or was granted. */
export function analyticsLinkAllowed(input: {
  market: 'intl' | 'cn';
  country: string | null | undefined;
  consent: AnalyticsConsentChoice | null;
}): boolean {
  return !isAnalyticsConsentRequired(input.market, input.country) || input.consent === 'granted';
}

// ── Sanitizing ───────────────────────────────────────────────────────────

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// 7+ digits in a row once spaces, dashes, dots and brackets are removed.
const PHONE_RE = /\+?\d{7,}/;

/** Email addresses anywhere; phone-like digit runs except in id props (`jobId` may be numeric). */
function looksLikeContact(key: string, value: string): boolean {
  if (EMAIL_RE.test(value)) return true;
  if (/Id$/.test(key)) return false;
  return PHONE_RE.test(value.replace(/[\s().-]/g, ''));
}

/**
 * Keep only the registry's prop keys for `name`; drop contact-like strings,
 * non-finite numbers and nested values; trim long strings.
 */
export function sanitizeEventProps(
  name: ProductEventName,
  props: Record<string, unknown> | null | undefined,
): Record<string, EventPropValue> | null {
  if (!props) return null;
  const allowed = PRODUCT_EVENTS[name].props as readonly string[];
  const out: Record<string, EventPropValue> = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
    const v = props[key];
    if (v === null || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[key] = v;
    } else if (typeof v === 'string') {
      const s = v.trim().slice(0, MAX_PROP_STRING);
      if (s && !looksLikeContact(key, s)) out[key] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Routes whose next path segment is a secret (one-time links mailed to the
 * person). The segment is replaced with `:token` before anything is stored,
 * so analytics never holds a live reset, verify, unsubscribe or confirm link.
 * Matched after an optional locale prefix too (`/de/reset-password/…`).
 * The web mirrors this list in lib/analytics.ts (TOKEN_PATH_PREFIXES).
 */
export const TOKEN_PATH_PREFIXES = ['reset-password', 'verify-email', 'unsubscribe', 'alerts/confirm', 'auth/callback'] as const;

const TOKEN_PATH_RE = new RegExp(
  `(^|/)(${TOKEN_PATH_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/[^/]+(?:/.*)?$`,
);

/** Replace the secret segment of a token route (and anything after it) with `:token`. */
export function redactTokenPath(pathname: string): string {
  return pathname.replace(TOKEN_PATH_RE, '$1$2/:token');
}

/**
 * The pathname only (query strings can carry tokens or addresses), with the
 * secret segment of token routes replaced by `:token`, ≤512 chars.
 */
export function sanitizeEventPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const pathname = path.split(/[?#]/)[0]!.trim();
  if (!pathname.startsWith('/')) return null;
  return redactTokenPath(pathname).slice(0, 512);
}

/** The client's `at` when plausible, else the server time. */
export function eventTime(at: string | null | undefined, now: Date): Date {
  const ms = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms)) return now;
  if (ms < now.getTime() - MAX_EVENT_AGE_MS || ms > now.getTime() + MAX_EVENT_SKEW_MS) return now;
  return new Date(ms);
}
