// lib/analytics.ts — first-party product analytics client (TASK_PLAN.md WP-23).
//
//   track('job_saved', { jobId, from: 'feed' });
//
// Events are buffered in memory and sent in batches (≤50) to our own API
// (`POST /api/v1/public/events` through lib/api/growth.ts) when 20 are
// waiting, 5 s after the first one, and when the page is hidden or closed
// (a `keepalive` request). There are no third-party pixels, scripts or
// requests of any kind.
//
// Consent (PRODUCT_PLAN.md §4.1, H28). On RoboApply, visitors from the EEA,
// the UK and Switzerland (and visitors whose country is unknown) are asked
// first by components/features/growth/AnalyticsConsent:
//   - before a choice, or after "Don't allow": no `ra_anon` cookie, nothing
//     stored on the device, events carry only an in-memory per-page-load id
//     and the server links them to nothing; signup receives only the
//     functional part of the entry attribution (referral and job), never the
//     marketing part (utm_*, from, alert, landing page);
//   - after "Allow": a first-party `ra_anon` cookie (≈13 months) and events
//     are linked to it, and to the account at signup.
// Everywhere else (and on GoApply, which lists this collection in its
// personal-information list) the cookie is set at once.
//
// The banner calls `configureAnalytics()` once on mount. Until then events
// wait in the buffer and nothing is sent.

import { sendEvents, sendEventsBeacon } from './api/growth';
import type { AnalyticsConsentChoice, ProductEventName, ProductEventProps, Touch } from './api/contracts/growth';

export type { AnalyticsConsentChoice, ProductEventName, ProductEventProps };

// ── Shared names (server twins in server/src/features/growth/events.ts) ──

export const ANON_ID_COOKIE = 'ra_anon';
export const ANALYTICS_CONSENT_COOKIE = 'ra_analytics_consent';
/** ≈13 months, the retention limit for events and their identifier. */
export const ANALYTICS_COOKIE_MAX_AGE_SEC = 395 * 24 * 60 * 60;
export const ATTRIBUTION_STORAGE_KEY = 'ra_attribution';

/** EU 27 + IS, LI, NO (EEA) + GB + CH. Mirrors CONSENT_REQUIRED_COUNTRIES on the server. */
export const CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
]);

/** Same rule as the server: RoboApply asks in the EEA/UK/CH and when the country is unknown; GoApply never shows the banner. */
export function isAnalyticsConsentRequired(market: 'intl' | 'cn', country: string | null | undefined): boolean {
  if (market !== 'intl') return false;
  if (!country) return true;
  return CONSENT_REQUIRED_COUNTRIES.has(country.trim().toUpperCase());
}

// ── Paths ────────────────────────────────────────────────────────────────

/**
 * Routes whose next segment is a secret (one-time links mailed to the
 * person). Mirrors TOKEN_PATH_PREFIXES in server/src/features/growth/events.ts;
 * the server redacts again, this keeps the token from leaving the browser.
 */
export const TOKEN_PATH_PREFIXES = ['reset-password', 'verify-email', 'unsubscribe', 'alerts/confirm', 'auth/callback'] as const;

const TOKEN_PATH_RE = new RegExp(`(^|/)(${TOKEN_PATH_PREFIXES.join('|')})/[^/]+(?:/.*)?$`);

/** The pathname without query or hash, with the secret segment of token routes replaced by `:token`. */
export function safePath(path: string): string {
  return path.split(/[?#]/)[0]!.replace(TOKEN_PATH_RE, '$1$2/:token').slice(0, 512);
}

// ── Tunables ─────────────────────────────────────────────────────────────

export const MAX_BATCH = 50;
export const FLUSH_AT = 20;
export const FLUSH_DELAY_MS = 5000;
/** Buffer cap; the oldest events are dropped beyond it (e.g. while offline). */
export const MAX_BUFFER = 200;

// ── Cookies and storage (all guarded: blocked storage never throws) ──────

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

function readCookie(name: string): string | null {
  if (!hasDocument() || !document.cookie) return null;
  const row = document.cookie.split(/;\s*/).find((r) => r.startsWith(`${name}=`));
  if (!row) return null;
  try {
    return decodeURIComponent(row.slice(name.length + 1)) || null;
  } catch {
    return null;
  }
}

function writeCookie(name: string, value: string, maxAgeSec: number): void {
  if (!hasDocument()) return;
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
}

function deleteCookie(name: string): void {
  if (!hasDocument()) return;
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function storageGet(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage */
  }
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

const ANON_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── State ────────────────────────────────────────────────────────────────

interface QueuedEvent {
  name: ProductEventName;
  props?: Record<string, string | number | boolean | null>;
  path?: string;
  at: string;
}

interface State {
  configured: boolean;
  consentRequired: boolean;
  queue: QueuedEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  /** In-memory per-page-load id: groups one visit, never stored on the device. */
  sessionId: string;
  listening: boolean;
  /** Attribution seen this page load (kept in memory even before consent). */
  sessionAttribution: StoredAttribution | null;
}

function freshState(): State {
  return { configured: false, consentRequired: true, queue: [], timer: null, sessionId: randomId(), listening: false, sessionAttribution: null };
}

let state: State = freshState();
const reviewListeners = new Set<() => void>();

// ── Consent ──────────────────────────────────────────────────────────────

export function readAnalyticsConsent(): AnalyticsConsentChoice | null {
  const v = readCookie(ANALYTICS_CONSENT_COOKIE);
  return v === 'granted' || v === 'denied' ? v : null;
}

/** May events be linked to an anonymous id (and to the account at signup)? */
export function analyticsLinkAllowed(): boolean {
  if (!state.configured) return false;
  return !state.consentRequired || readAnalyticsConsent() === 'granted';
}

/** The `ra_anon` id when linking is allowed (created on first use), else null. */
export function getAnonId(): string | null {
  if (!analyticsLinkAllowed()) return null;
  const existing = readCookie(ANON_ID_COOKIE);
  if (existing && ANON_ID_RE.test(existing)) return existing;
  const id = randomId();
  writeCookie(ANON_ID_COOKIE, id, ANALYTICS_COOKIE_MAX_AGE_SEC);
  return id;
}

/**
 * Record the visitor's choice. "Allow" creates the anonymous id and keeps
 * this visit's attribution; "Don't allow" removes the id and anything the
 * client stored for analytics, and drops the marketing part of this visit's
 * attribution (only the referral and job a signup needs are kept). The
 * choice itself is remembered so the banner does not ask again on every page.
 */
export function setAnalyticsConsent(choice: AnalyticsConsentChoice): void {
  writeCookie(ANALYTICS_CONSENT_COOKIE, choice, ANALYTICS_COOKIE_MAX_AGE_SEC);
  if (choice === 'granted') {
    getAnonId();
    if (state.sessionAttribution) storageSet(ATTRIBUTION_STORAGE_KEY, JSON.stringify(state.sessionAttribution));
  } else {
    deleteCookie(ANON_ID_COOKIE);
    storageSet(ATTRIBUTION_STORAGE_KEY, null);
    state.sessionAttribution = functionalAttribution(state.sessionAttribution);
  }
}

/** Ask the banner to show again (a "Privacy choices" link calls this). */
export function requestAnalyticsConsentReview(): void {
  for (const fn of reviewListeners) fn();
}

/** The banner subscribes here; returns the unsubscribe function. */
export function onAnalyticsConsentReview(fn: () => void): () => void {
  reviewListeners.add(fn);
  return () => {
    reviewListeners.delete(fn);
  };
}

// ── Configuration and lifecycle ──────────────────────────────────────────

function onVisibility(): void {
  if (hasDocument() && document.visibilityState === 'hidden') void flush('beacon');
}

function onPageHide(): void {
  void flush('beacon');
}

/**
 * Called once by the consent banner with the rule for this visitor. Creates
 * the anonymous id where allowed, starts the hidden/close listeners and
 * schedules a flush of anything tracked before mount.
 */
export function configureAnalytics(options: { consentRequired: boolean }): void {
  state.configured = true;
  state.consentRequired = options.consentRequired;
  if (analyticsLinkAllowed()) getAnonId();
  if (!state.listening && typeof window !== 'undefined') {
    state.listening = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
  }
  if (state.queue.length) schedule();
}

function schedule(): void {
  if (!state.configured) return;
  if (state.queue.length >= FLUSH_AT) {
    void flush();
    return;
  }
  if (state.timer === null) {
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }
}

/** Queue one event. Never throws and never blocks the caller. */
export function track<N extends ProductEventName>(name: N, props?: ProductEventProps<N>, options: { path?: string } = {}): void {
  try {
    const path = options.path ?? (typeof location !== 'undefined' ? location.pathname : undefined);
    const event: QueuedEvent = { name, at: new Date().toISOString() };
    if (props && Object.keys(props).length) event.props = props as QueuedEvent['props'];
    if (path) event.path = safePath(path);
    state.queue.push(event);
    if (state.queue.length > MAX_BUFFER) state.queue.splice(0, state.queue.length - MAX_BUFFER);
    schedule();
  } catch {
    /* analytics must never break the page */
  }
}

/**
 * Send everything buffered, in batches of ≤50. `beacon` uses a keepalive
 * request that survives the page closing. Failed sends are dropped (the
 * events are best-effort and must not pile up or retry in a loop).
 */
export async function flush(mode: 'fetch' | 'beacon' = 'fetch'): Promise<void> {
  if (!state.configured) return;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  while (state.queue.length) {
    const events = state.queue.splice(0, MAX_BATCH);
    const anonId = getAnonId();
    const body = { ...(anonId ? { anonId } : {}), sessionId: state.sessionId, events };
    if (mode === 'beacon') {
      sendEventsBeacon(body);
    } else {
      try {
        await sendEvents(body);
      } catch {
        /* dropped */
      }
    }
  }
}

/** Events waiting to be sent (tests and debugging). */
export function pendingEventCount(): number {
  return state.queue.length;
}

// ── Attribution (F-ONB-02) ───────────────────────────────────────────────

/** URL query key → Touch field (server twin: ATTRIBUTION_QUERY_KEYS). */
export const ATTRIBUTION_PARAMS: Readonly<Record<string, Exclude<keyof Touch, 'at' | 'landingPath'>>> = {
  from: 'from',
  job: 'jobId',
  action: 'action',
  ref: 'ref',
  invite: 'inviteCode',
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  alert: 'alert',
};

export interface StoredAttribution {
  firstTouch: Touch;
  lastTouch: Touch | null;
}

/** The entry parameters of a URL as a touch, or null when it carries none. */
export function touchFromSearch(search: string | URLSearchParams, landingPath?: string, now: Date = new Date()): Touch | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const touch: Record<string, string> = {};
  for (const [param, field] of Object.entries(ATTRIBUTION_PARAMS)) {
    const v = params.get(param)?.trim();
    if (v) touch[field] = v.slice(0, 200);
  }
  if (!Object.keys(touch).length) return null;
  if (landingPath) touch.landingPath = safePath(landingPath);
  return { ...touch, at: now.toISOString() } as Touch;
}

function readStoredAttribution(): StoredAttribution | null {
  const raw = storageGet(ATTRIBUTION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredAttribution;
    return v && typeof v === 'object' && v.firstTouch ? v : null;
  } catch {
    return null;
  }
}

/**
 * Note this page's entry parameters. The first touch is kept, later ones
 * move `lastTouch`. Kept in memory for this page load always; stored on the
 * device only where linking is allowed (after consent in the EEA/UK/CH).
 */
export function captureAttribution(loc: { search: string; pathname: string } | null = typeof location !== 'undefined' ? location : null): void {
  if (!loc) return;
  const touch = touchFromSearch(loc.search, loc.pathname);
  if (!touch) return;
  const base = state.sessionAttribution ?? (analyticsLinkAllowed() ? readStoredAttribution() : null);
  const next: StoredAttribution = base ? { firstTouch: base.firstTouch, lastTouch: touch } : { firstTouch: touch, lastTouch: null };
  state.sessionAttribution = next;
  if (analyticsLinkAllowed()) storageSet(ATTRIBUTION_STORAGE_KEY, JSON.stringify(next));
}

/** Touch fields kept without analytics consent (server twin: FUNCTIONAL_TOUCH_FIELDS). */
export const FUNCTIONAL_TOUCH_FIELDS = ['ref', 'inviteCode', 'jobId', 'action'] as const;

function functionalTouch(touch: Touch | null | undefined): Touch | null {
  if (!touch) return null;
  const out: Record<string, string> = {};
  for (const key of FUNCTIONAL_TOUCH_FIELDS) {
    const v = touch[key];
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? ({ ...out, at: touch.at } as Touch) : null;
}

function functionalAttribution(a: StoredAttribution | null): StoredAttribution | null {
  if (!a) return null;
  const first = functionalTouch(a.firstTouch);
  const last = functionalTouch(a.lastTouch);
  if (first) return { firstTouch: first, lastTouch: last };
  return last ? { firstTouch: last, lastTouch: null } : null;
}

/**
 * What signup sends with the new account as `body.attribution` (WP-10 →
 * growth.touchesFromClient → growth.recordAttribution): this visit's
 * attribution, or the stored one where storing is allowed. Where linking is
 * not allowed (no choice yet, or "Don't allow" in the EEA/UK/CH) only the
 * functional fields are returned: the referral and the job, never utm_*,
 * `from`, `alert` or the landing page.
 */
export function getAttribution(): StoredAttribution | null {
  if (!analyticsLinkAllowed()) return functionalAttribution(state.sessionAttribution);
  return state.sessionAttribution ?? readStoredAttribution();
}

/** Tests only: forget all state and listeners. */
export function __resetAnalyticsForTests(): void {
  if (state.timer !== null) clearTimeout(state.timer);
  if (state.listening && typeof window !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  }
  reviewListeners.clear();
  state = freshState();
}
