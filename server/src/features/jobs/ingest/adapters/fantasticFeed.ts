// server/src/features/jobs/ingest/adapters/fantasticFeed.ts — the licensed feed
// (MKT-5A; MARKET_STRATEGY M-2, §1.2 tier 1, §1.4 tier 1, §1.5 closure, JI-7, JC-6;
// JOB_SOURCES_INTL §6.2, §7.2).
//
// Active Jobs DB read the way its vendor documents it, as a WINDOW SYNC and
// never as title × city search: one backfill of the last seven days, then one
// window an hour, paged by offset, and the vendor's expired feed to close our
// rows by id. Provider `activejobs_feed`, a cursor source of both markets; it
// writes sourceBoard 'activejobs' and externalId 'activejobs:<id>', the rows
// the on-demand search adapter addresses too (dedupe collapses a feed row onto
// an employer-board row for the same posting: MARKET_STRATEGY §1.5 K2).
//
// It runs by itself the day a paid plan exists and never on the free plan:
// every answer of this adapter starts at the quota gate (../quota.ts
// `feedGateForMarket`). With the gate closed nothing is planned for it, no
// request is built and `fetch` returns at once.
//
// What the vendor documents (read on 2026-10-12: developer.fantastic.jobs
// /documentation/endpoints/new-jobs, /endpoints/expired-jobs,
// /recommended-strategy, /time-fields, /supported-ats-sources and the OpenAPI
// document data.fantastic.jobs/openapi), and what follows from it here:
//   - The hourly window is one UTC hour, served an hour late: "if you call
//     the endpoint at 09:15 you receive all jobs indexed between 07:00 and
//     08:00". The same pages call `time_frame=1h` a "rolling 1-hour window",
//     and no response was ever seen to settle which it is. So the sync never
//     asks `time_frame=1h` and trusts neither reading: every hour it asks
//     the slice it means by EXPLICIT bounds, `time_frame=7d` with
//     `date_created_gte` (the edge the last slice ended at) and
//     `date_created_lt` (the newest full UTC hour that is an hour old). That
//     is the vendor's own recovery recipe ("the recovery window ends exactly
//     where the next hourly call begins, so no jobs are dropped or
//     duplicated"); `date_created` is when the vendor indexed the posting,
//     "always populated and monotonically increasing". Consecutive slices
//     share an edge, so an hour that was passed over (an outage, a spent day,
//     a drifting tick) is simply part of the next slice.
//   - Before a page moves the cursor, its rows are compared with the slice
//     that was asked: when most of them were indexed outside it, the API did
//     not apply the bounds, nothing is written and the cursor stays (an error
//     the admin panel shows), instead of marking hours as read on trust.
//     FANTASTIC_FEED_SLICE_CHECK_DISABLED=true is the operator's way out
//     should the check misjudge real responses: the page is then read and
//     the mismatch only counted.
//   - Pages: `limit` up to 1000 and `offset`, until a page is shorter than
//     its limit. A full page answers "more" and stores the next offset, so
//     paging resumes on the next lease or the next cron run.
//   - The expired routes return bare arrays of the vendor's job ids. `1h` is a
//     rolling hour, `1d` the previous UTC day (refreshed at 01:00 UTC), `1m`
//     the last 31 days. They cost requests, not postings.
//   - A parameter the API does not know is answered with 400: every request
//     is built from the documented names below and nothing else.
//
// One fetch = at most ONE new-jobs request. When the new-jobs side has nothing
// (more) to read in this fetch, the expired clocks that are due run in the
// same fetch. A failed expired call never loses the new rows of the fetch: it
// is counted, its clock is not moved, and the next cycle asks again. Two
// failures have a rule of their own, so neither can stop the others for good:
//   - a monthly answer that cannot be read (the vendor calls it very large)
//     is tried again a day later, and the hourly and daily calls of the same
//     cycle still run;
//   - a 401 / 403 on the expired route is about that route (a plan that does
//     not include it), and so is a 404 (a renamed path: the marketplace's
//     expired route is not verified): it is not asked again before the next
//     UTC day, and the client opens no breaker for it, so people's own
//     searches and the new-jobs route go on.
//
// Fresh first. The backfill and the hourly windows are two page runs with
// their own offsets, and a window that is due is always read before the next
// backfill page. A backfill that held the hourly windows back until it ended
// would leave a week of windows behind it, and a day's budget sized to the
// plan (a month divided by 31) can never absorb that: the feed would serve
// week-old postings for good. So the hourly windows start in the hour after
// the backfill's first page, and the backfill reads on with what the day's
// budget leaves (it ends when its slice of the seven-day window is read, or
// has aged out of that window).
//
// Money: the plan bills one credit per posting returned. The day's postings
// are counted under `usageKey('activejobs', market)` (`activejobs`,
// `activejobs:cn`: the plan's own usage rows, shared with the search adapter)
// and a request is never made once the day reaches the market's budget
// (../config.ts `feedDailyJobsFor`); the page's `limit` is cut to what is left
// of it. The day is the plan's month / 31 and, once the provider states what
// the plan has left and when it resets, never more than that remainder less a
// reserve, spread over the days to the reset (`feedQuotaDailyJobs`). The
// reserve (INGEST_QUOTA_RESERVE_SHARE of the plan's postings) is for people's
// own searches, which are billed on the same plan and counted nowhere else:
// the feed never spends it. The requests themselves are counted by the
// pipeline under this source's own row (`activejobs_feed`,
// `activejobs_feed:cn`), so they never use up the search adapter's daily calls.
//
// Never (D3, H9, strategy §1.6): no `include_basic_organization_details` (it
// returns LinkedIn company fields, which are never mapped: ../../normalize/
// adapters.ts), no user data in any parameter (the request holds a window, a
// page, country names, source names and taxonomy names: nothing a person
// typed), no key in a cursor, a note, a log line or an error text.

import type { EnvSource, Market } from '../../../../platform/brand/index.js';
import { FANTASTIC_TAXONOMY_LABELS } from '../../../../roboapply/v2/lib/raExternalJobTypes.js';
import { fantasticCountryName, fantasticTransport, feedRequest, type FeedRequestFn } from '../../../../roboapply/v2/lib/raFantasticJobs.js';
import { logger } from '../../../../services/LoggerService.js';
import { inputFromFantasticJob, marketOfPosting, type ProviderJobInput } from '../../normalize/index.js';
import type { JobSourceAdapter, SourceFetchResult } from '../../sources/index.js';
import {
  FEED_EXCLUDE_MIN_BOARDS,
  FEED_GATE_REASON_CODE,
  feedCountries,
  feedDailyJobsFor,
  feedJobsLeft,
  feedQuotaDailyJobs,
  feedSliceCheckDisabled,
  feedTaxonomies,
  type FeedGate,
  type FeedQuotaReading,
} from '../config.js';
import { dayKey, type IngestDb } from '../db.js';
import { FEED_PLAN_PROVIDER, feedGateForMarket, marketOfCall, providerJobsToday, quotaSnapshot, recordProviderUsage } from '../quota.js';
import { usageKey } from '../quotaContract.js';

const TAG = 'JOBS_FEED';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FEED_PROVIDER = 'activejobs_feed' as const;
/** `RAJob.sourceBoard` of the feed's rows (the search adapter's board). */
export const FEED_BOARD = 'activejobs';
/** Rows one page asks for (the vendor's maximum). */
export const FEED_PAGE_LIMIT = 1000;
/** The `time_frame` every new-jobs request asks: the seven-day window, cut to a slice by `date_created` bounds. */
export const FEED_TIME_FRAME = '7d' as const;
/** A row indexed this far outside the slice that was asked still counts as inside it (a timestamp rounded onto an edge is no mismatch). */
export const FEED_WINDOW_TOLERANCE_MS = 1_000;
/** How often the monthly reconciliation of the expired feed runs. */
export const FEED_MONTHLY_EVERY_MS = 30 * DAY;
/** A monthly call that was made and could not be read is tried again after this long (the hourly and daily calls go on meanwhile). */
export const FEED_MONTHLY_RETRY_MS = DAY;
/** No expired call answered for longer than this is an outage: the hourly and daily calls cannot cover it, the monthly window is read. */
export const FEED_EXPIRED_OUTAGE_MS = 25 * HOUR;
/** Expired ids up to this many are handed to ingest as they are; a longer list is first cut down to the rows we hold open. */
export const FEED_EXPIRED_PASS_THROUGH_MAX = 10_000;
/** Open rows read per statement when a long expired list is matched against our own. */
export const FEED_OPEN_ROWS_PAGE = 5_000;
/** How long the count of our enabled boards per ATS is reused. */
export const FEED_BOARD_COUNT_TTL_MS = 10 * 60_000;
/** A sync this many hours behind while its day's budget is spent is reported (a warning per refused fetch). */
export const FEED_BEHIND_WARN_HOURS = 6;
/** Time one more request may need (the client's own timeout plus a margin): not started when the caller's budget is shorter. */
const REQUEST_RESERVE_MS = 27_000;

/**
 * Our ATS id (`RACareerSiteSource.ats`) → the vendor's `source` value, for
 * `exclude_source`. Every value is one the vendor's "Supported ATS Sources"
 * page lists (read 2026-10-12). An ATS of ours that is not in the table is
 * never excluded.
 */
export const FEED_SOURCE_OF_ATS: Readonly<Record<string, string>> = {
  greenhouse: 'greenhouse',
  lever: 'lever.co',
  ashby: 'ashby',
  smartrecruiters: 'smartrecruiters',
  workable: 'workable',
  recruitee: 'recruitee',
  personio: 'personio',
};

/** The parameter names a feed request may carry (the vendor's documented names; tests assert every request against it). */
export const FEED_REQUEST_PARAMS: readonly string[] = [
  'time_frame',
  'limit',
  'offset',
  'description_format',
  'location',
  'exclude_source',
  'ai_taxonomies_a',
  'date_created_gte',
  'date_created_lt',
];

// ── The cursor (RAIngestQuery.params.cursor) ──────────────────────────────

export interface FeedCursor {
  v: 1;
  /** 'backfill' until the seven-day window has been read once; then 'hourly' for good. */
  phase: 'backfill' | 'hourly';
  /** The `time_frame` of every request: always the seven-day window (see the header: `1h` is never asked). */
  window: typeof FEED_TIME_FRAME;
  /** Rows of the hourly slice in progress already read; 0 = no slice in progress. */
  offset: number;
  /** `date_created_gte` of the hourly slice in progress (ISO): the edge the slice before it ended at. Null between slices. */
  since: string | null;
  /**
   * `date_created` upper edge (exclusive, ISO, a full UTC hour) of the hourly
   * slice in progress, or of the last one read to its end: everything the
   * vendor indexed from the backfill's edge up to it has been asked for. Null
   * before the first request.
   */
  until: string | null;
  /** The newest `date_created` seen in any row (ISO). */
  highWater: string | null;
  /** When the last hourly (or catch-up) run started. */
  lastHourlyAt: string | null;
  /** Rows of the backfill already read (phase 'backfill'). */
  backfillOffset: number;
  /** The backfill's `date_created` upper edge (exclusive, ISO): the hour edge of its first request. The hourly windows start there. */
  backfillUntil: string | null;
  /** When the hourly, the daily and the monthly expired call were last ANSWERED (a failed call moves none). */
  lastExpiredHourlyAt: string | null;
  lastExpiredDailyAt: string | null;
  lastExpiredMonthlyAt: string | null;
  /** When a monthly expired call was last made, answered or not: a failed one is not repeated before FEED_MONTHLY_RETRY_MS. */
  lastExpiredMonthlyTriedAt: string | null;
  /** The expired calls stopped for more than a day and went on since; no monthly call has covered the gap yet. */
  expiredGap: boolean;
  /** When the expired route last refused the key (401 / 403) or was not there (404): it is not asked again on that UTC day. */
  expiredRefusedAt: string | null;
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const countOrZero = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

export function newFeedCursor(): FeedCursor {
  return {
    v: 1,
    phase: 'backfill',
    window: '7d',
    offset: 0,
    since: null,
    until: null,
    highWater: null,
    lastHourlyAt: null,
    backfillOffset: 0,
    backfillUntil: null,
    lastExpiredHourlyAt: null,
    lastExpiredDailyAt: null,
    lastExpiredMonthlyAt: null,
    lastExpiredMonthlyTriedAt: null,
    expiredGap: false,
    expiredRefusedAt: null,
  };
}

/** The stored cursor, field by field; anything unreadable (no cursor, bad JSON, another version) starts a new one. Never throws. */
export function parseFeedCursor(raw: string | null | undefined): FeedCursor {
  if (typeof raw !== 'string' || !raw.trim()) return newFeedCursor();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return newFeedCursor();
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || (v as { v?: unknown }).v !== 1) return newFeedCursor();
  const c = v as Record<string, unknown>;
  return {
    v: 1,
    phase: c.phase === 'hourly' ? 'hourly' : 'backfill',
    window: FEED_TIME_FRAME,
    offset: countOrZero(c.offset),
    since: isoOrNull(c.since),
    until: isoOrNull(c.until),
    highWater: isoOrNull(c.highWater),
    lastHourlyAt: isoOrNull(c.lastHourlyAt),
    backfillOffset: countOrZero(c.backfillOffset),
    backfillUntil: isoOrNull(c.backfillUntil),
    lastExpiredHourlyAt: isoOrNull(c.lastExpiredHourlyAt),
    lastExpiredDailyAt: isoOrNull(c.lastExpiredDailyAt),
    lastExpiredMonthlyAt: isoOrNull(c.lastExpiredMonthlyAt),
    lastExpiredMonthlyTriedAt: isoOrNull(c.lastExpiredMonthlyTriedAt),
    expiredGap: c.expiredGap === true,
    expiredRefusedAt: isoOrNull(c.expiredRefusedAt),
  };
}

export function formatFeedCursor(cursor: FeedCursor): string {
  return JSON.stringify(cursor);
}

// ── Windows and pages (pure) ──────────────────────────────────────────────

/**
 * The upper edge (exclusive) of what the sync asks for at `now`: the newest
 * full UTC hour that is at least an hour old. At 09:15 it is 08:00 (the
 * vendor's own example: a call at 09:15 serves what was indexed up to 08:00;
 * the seven-day window is about 45 minutes behind, so the hour before the edge
 * is complete under either figure).
 */
export function feedWindowEnd(now: Date): number {
  return Math.floor(now.getTime() / HOUR) * HOUR - HOUR;
}

/** A date filter value as the vendor's own examples write it: UTC, to the second, no zone suffix. */
function filterDate(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19);
}

/** A vendor timestamp as epoch milliseconds; a string with no zone is UTC (vendor "Time Fields": all timestamps are UTC). */
function vendorTime(v: unknown): number {
  if (typeof v !== 'string' || !v.trim()) return Number.NaN;
  const s = v.trim();
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
}

export interface FeedPageRequest {
  timeFrame: typeof FEED_TIME_FRAME;
  offset: number;
  /** `date_created_gte` (vendor format); null only for the backfill, whose lower edge is the window's own. */
  createdGte: string | null;
  /** `date_created_lt` (vendor format): every request has an upper edge. */
  createdLt: string;
}

/** Which of the two page runs a request belongs to. */
export type FeedTrack = 'hourly' | 'backfill';

export interface PlannedFeedPage {
  track: FeedTrack;
  /** The cursor as it stands when the request is made (a slice started, or the backfill's edge set). */
  cursor: FeedCursor;
  request: FeedPageRequest;
}

/** One page of the slice [`since`, `until`) of the seven-day window. */
function slicePage(since: string, until: number, offset: number): FeedPageRequest {
  return { timeFrame: FEED_TIME_FRAME, offset, createdGte: filterDate(Date.parse(since)), createdLt: filterDate(until) };
}

/**
 * The new-jobs request that is due at `now`; null when nothing is due. Every
 * request names its slice by `date_created` bounds (see the header).
 *
 *   a slice      the next page of the same slice, by the bounds it was started
 *   in progress  with: paging goes on across fetches and cron runs, however
 *                much later.
 *   a new        once per UTC hour, from the backfill's edge on: everything
 *   slice        indexed from the edge the last slice ended at (`until`) up to
 *                the current edge. Usually that is one hour; after an outage,
 *                a spent day or a tick that drifted past an hour it is all the
 *                hours since, in one slice. Never an hour twice, never one
 *                left out.
 *   backfill     when no slice is due and the backfill is not finished: the
 *                next page of the seven-day window up to the hour edge of the
 *                backfill's first request (`date_created_lt`), so the hourly
 *                slices continue exactly where the backfill ends.
 */
export function planFeedPage(cursor: FeedCursor, now: Date): PlannedFeedPage | null {
  const edge = feedWindowEnd(now);
  const until = cursor.until ? Date.parse(cursor.until) : Number.NaN;

  if (cursor.offset > 0 && Number.isFinite(until)) {
    // A cursor that lost its lower bound (a damaged value) reads the hour before its edge.
    const since = cursor.since ?? new Date(until - HOUR).toISOString();
    return { track: 'hourly', cursor: { ...cursor, since }, request: slicePage(since, until, cursor.offset) };
  }

  // No slice in progress: has a full hour been indexed since the last one read? (Never before the backfill set its edge.)
  if (Number.isFinite(until) && until < edge) {
    const since = new Date(until).toISOString();
    const started: FeedCursor = { ...cursor, offset: 0, since, until: new Date(edge).toISOString(), lastHourlyAt: now.toISOString() };
    return { track: 'hourly', cursor: started, request: slicePage(since, edge, 0) };
  }

  if (cursor.phase === 'backfill') {
    const backfillUntil = cursor.backfillUntil ?? new Date(edge).toISOString();
    // The first backfill request sets the edge the hourly slices start from.
    const next: FeedCursor = { ...cursor, backfillUntil, until: cursor.until ?? backfillUntil };
    return { track: 'backfill', cursor: next, request: { timeFrame: FEED_TIME_FRAME, offset: cursor.backfillOffset, createdGte: null, createdLt: filterDate(Date.parse(backfillUntil)) } };
  }
  // A cursor past its backfill that lost its edge (a damaged value) must not stall the sync, and must not buy the
  // backfill a second time: the hour before the current edge is read, and the hours go on from it.
  if (!Number.isFinite(until)) {
    const since = new Date(edge - HOUR).toISOString();
    const restart: FeedCursor = { ...cursor, offset: 0, since, until: new Date(edge).toISOString(), lastHourlyAt: now.toISOString() };
    return { track: 'hourly', cursor: restart, request: slicePage(since, edge, 0) };
  }
  return null;
}

/**
 * How many rows of a page were indexed outside the slice that was asked, and
 * how many state when they were indexed at all. A bound the request did not
 * carry excludes nothing; a row without a readable `date_created` is not
 * judged.
 */
export function rowsOutsideSlice(rows: readonly unknown[], request: Pick<FeedPageRequest, 'createdGte' | 'createdLt'>): { dated: number; outside: number } {
  const gte = request.createdGte ? vendorTime(request.createdGte) : Number.NEGATIVE_INFINITY;
  const lt = vendorTime(request.createdLt);
  let dated = 0;
  let outside = 0;
  for (const row of rows) {
    const created = vendorTime((row as { date_created?: unknown } | null)?.date_created);
    if (!Number.isFinite(created)) continue;
    dated += 1;
    if (created < gte - FEED_WINDOW_TOLERANCE_MS || created >= lt + FEED_WINDOW_TOLERANCE_MS) outside += 1;
  }
  return { dated, outside };
}

/**
 * The cursor after a page of `returned` rows asked with `limit` on `track`: a
 * full page keeps its run going, a short one ends it (the backfill for good).
 * `more` says whether another new-jobs request is due right away: the same
 * run's next page, or the backfill's next page once a slice is read.
 */
export function advanceFeedCursor(cursor: FeedCursor, track: FeedTrack, returned: number, limit: number, newestCreated: number): { cursor: FeedCursor; more: boolean } {
  const highWater = Number.isFinite(newestCreated) && (!cursor.highWater || newestCreated > Date.parse(cursor.highWater)) ? new Date(newestCreated).toISOString() : cursor.highWater;
  const full = returned > 0 && returned >= limit;
  if (track === 'backfill') {
    if (full) return { cursor: { ...cursor, backfillOffset: cursor.backfillOffset + returned, highWater }, more: true };
    return { cursor: { ...cursor, phase: 'hourly', backfillOffset: 0, highWater }, more: false };
  }
  if (full) return { cursor: { ...cursor, offset: cursor.offset + returned, highWater }, more: true };
  return { cursor: { ...cursor, offset: 0, since: null, highWater }, more: cursor.phase === 'backfill' };
}

export type ExpiredFrame = '1h' | '1d' | '1m';

/**
 * Has no expired call of any frame been answered for more than 25 hours? The
 * hourly call covers a rolling hour and the daily one the previous UTC day,
 * so a stop that long leaves expirations only the monthly window still holds.
 * (A new sync counts from its first fetch: `lastExpiredMonthlyAt` is set then.)
 */
export function expiredOutage(cursor: FeedCursor, now: Date): boolean {
  const answered = [cursor.lastExpiredHourlyAt, cursor.lastExpiredDailyAt, cursor.lastExpiredMonthlyAt].map((iso) => (iso ? Date.parse(iso) : Number.NaN)).filter(Number.isFinite);
  return answered.length > 0 && now.getTime() - Math.max(...answered) > FEED_EXPIRED_OUTAGE_MS;
}

/**
 * The expired calls due at `now`, in the order they are made:
 *   1m  once in 30 days, and after an outage (`expiredOutage`, or a gap an
 *       earlier cycle found that no monthly call has covered yet). It covers
 *       the hour and the day as well: answered, it stamps all three clocks. A
 *       monthly call that was made and failed is not repeated for a day;
 *   1h  when at least an hour has passed since the last one;
 *   1d  once per UTC day, after 01:00 UTC (the vendor refreshes the snapshot
 *       of the previous day at 01:00).
 * None on a UTC day on which the route refused the key (401 / 403) or was
 * not found (404).
 */
export function dueExpiredFrames(cursor: FeedCursor, now: Date): ExpiredFrame[] {
  const t = now.getTime();
  const since = (iso: string | null): number => (iso ? t - Date.parse(iso) : Number.POSITIVE_INFINITY);
  if (cursor.expiredRefusedAt && dayKey(new Date(cursor.expiredRefusedAt)) === dayKey(now)) return [];
  const due: ExpiredFrame[] = [];
  const monthlyWanted = cursor.expiredGap || expiredOutage(cursor, now) || since(cursor.lastExpiredMonthlyAt) >= FEED_MONTHLY_EVERY_MS;
  if (monthlyWanted && since(cursor.lastExpiredMonthlyTriedAt) >= FEED_MONTHLY_RETRY_MS) due.push('1m');
  if (since(cursor.lastExpiredHourlyAt) >= HOUR) due.push('1h');
  if (now.getUTCHours() >= 1 && (!cursor.lastExpiredDailyAt || dayKey(new Date(cursor.lastExpiredDailyAt)) !== dayKey(now))) due.push('1d');
  return due;
}

/**
 * The cursor after an expired call of `frame` was answered at `now`. The
 * monthly window covers the two others and closes a gap. An hourly or daily
 * answer that ends an outage does not cover it: the gap is remembered until a
 * monthly call is answered.
 */
export function stampExpired(cursor: FeedCursor, frame: ExpiredFrame, now: Date): FeedCursor {
  const at = now.toISOString();
  if (frame === '1m') return { ...cursor, lastExpiredMonthlyAt: at, lastExpiredMonthlyTriedAt: at, lastExpiredHourlyAt: at, lastExpiredDailyAt: at, expiredGap: false };
  const expiredGap = cursor.expiredGap || expiredOutage(cursor, now);
  return frame === '1h' ? { ...cursor, lastExpiredHourlyAt: at, expiredGap } : { ...cursor, lastExpiredDailyAt: at, expiredGap };
}

// ── Request filters (pure) ────────────────────────────────────────────────

const warned = new Set<string>();
function warnOnce(key: string, message: string, meta: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(TAG, message, meta);
}

/** Test seam: forget which values were already reported. */
export function resetFeedWarningsForTests(): void {
  warned.clear();
}

/**
 * The `location` filter of a market: full country names joined by OR, each in
 * double quotes (the API wants names, never codes).
 *   cn    "China" only. What the vendor files under China and is not the
 *         mainland (Hong Kong, Macau, Taiwan) is dropped after the fetch.
 *   intl  the countries of INGEST_FEED_COUNTRIES. A code the client has no
 *         name for is skipped and reported once, never sent as a code; CN is
 *         left out (mainland postings belong to the mainland sync: each row is
 *         in exactly one market).
 * Null when no country is left: the caller then makes no request (a request
 * without a location would buy the whole world).
 */
export function feedLocationFilter(market: Market, env: EnvSource = process.env): string | null {
  if (market === 'cn') return '"China"';
  const names: string[] = [];
  for (const code of feedCountries(env)) {
    if (code === 'CN') {
      warnOnce('country:CN', 'INGEST_FEED_COUNTRIES names CN: mainland postings are read by the mainland sync, not by the international one', { code });
      continue;
    }
    const name = fantasticCountryName(code);
    if (!name) {
      warnOnce(`country:${code}`, 'INGEST_FEED_COUNTRIES names a country the feed has no name for; it is skipped', { code });
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  return names.length ? names.map((n) => `"${n}"`).join(' OR ') : null;
}

/**
 * The `exclude_source` list: the vendor's name of every ATS of which our own
 * list holds at least FEED_EXCLUDE_MIN_BOARDS enabled boards. Below that the
 * ATS is NOT excluded: its postings on boards we have not found yet would come
 * from neither side (critic C14); dedupe keeps our own row for the ones we do
 * read. Sorted, so the same counts always give the same request.
 */
export function feedExcludedSources(boardCounts: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  for (const [ats, count] of boardCounts) {
    const source = Object.hasOwn(FEED_SOURCE_OF_ATS, ats) ? FEED_SOURCE_OF_ATS[ats] : undefined;
    if (source && count >= FEED_EXCLUDE_MIN_BOARDS && !out.includes(source)) out.push(source);
  }
  return out.sort();
}

/**
 * The optional taxonomy filter (INGEST_FEED_TAXONOMIES): the names the vendor
 * documents, as written. `invalid` is true when the operator named taxonomies
 * and none is a documented one: the caller then makes no request (a cap that
 * cannot be applied must not silently become "no cap").
 */
export function feedTaxonomyFilter(env: EnvSource = process.env): { names: string[]; invalid: boolean } {
  const wanted = feedTaxonomies(env);
  const documented: readonly string[] = FANTASTIC_TAXONOMY_LABELS;
  const names = wanted.filter((t) => documented.includes(t));
  for (const t of wanted) {
    if (!names.includes(t)) warnOnce(`taxonomy:${t}`, 'INGEST_FEED_TAXONOMIES names a taxonomy the vendor does not document; it is skipped', { name: t.slice(0, 60) });
  }
  return { names, invalid: wanted.length > 0 && names.length === 0 };
}

/** The query parameters of one new-jobs page (documented names only, in a fixed order). */
export function feedPageParams(input: { request: FeedPageRequest; limit: number; location: string; excludeSources: readonly string[]; taxonomies: readonly string[] }): Record<string, string> {
  const params: Record<string, string> = {
    time_frame: input.request.timeFrame,
    limit: String(input.limit),
    offset: String(input.request.offset),
    // Without it the API returns no description at all.
    description_format: 'text',
    location: input.location,
  };
  if (input.excludeSources.length) params.exclude_source = input.excludeSources.join(',');
  if (input.taxonomies.length) params.ai_taxonomies_a = input.taxonomies.join(',');
  if (input.request.createdGte) params.date_created_gte = input.request.createdGte;
  if (input.request.createdLt) params.date_created_lt = input.request.createdLt;
  return params;
}

/** The vendor's job id as our externalId; null for anything that is not an id (an integer, or digits). */
export function feedExternalId(id: unknown): string | null {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0 ? `${FEED_BOARD}:${id}` : null;
  if (typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id.trim())) return `${FEED_BOARD}:${id.trim()}`;
  return null;
}

// ── The adapter ───────────────────────────────────────────────────────────

/** The database surface the feed needs: the day's usage row, our enabled boards per ATS, and our open rows of the feed's board. */
export type FeedDb = Pick<IngestDb, 'rAJob' | '$queryRaw' | '$executeRaw'>;

export interface FantasticFeedDeps {
  /** One feed request (default: the Active Jobs DB client's `feedRequest`). */
  request?: FeedRequestFn;
  /** The quota gate of a market (default: ../quota.ts `feedGateForMarket`). */
  gate?: (market: Market, now: Date) => FeedGate;
  env?: EnvSource;
  /** Database (default: the app Prisma client, loaded lazily). */
  db?: () => Promise<FeedDb> | FeedDb;
  /** What the provider last said about the plan's postings: limit, what is left, the reset (default: the quota reading; null = nothing stated). */
  quota?: (now: Date) => FeedQuotaReading | null;
  /** Elapsed-time clock for the caller's budget and the board-count cache (default Date.now). */
  clock?: () => number;
  /** Wall clock for the answers that take no time argument (`isEnabled`, `disabledReason`; default: now). */
  now?: () => Date;
}

async function defaultDb(): Promise<FeedDb> {
  return (await import('../../../../lib/prisma.js')).default as unknown as FeedDb;
}

function errorCode(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 40) : 'error';
}

export function createFantasticFeedAdapter(deps: FantasticFeedDeps = {}): JobSourceAdapter {
  const env = (): EnvSource => deps.env ?? process.env;
  const clock = deps.clock ?? Date.now;
  const wallNow = (): Date => deps.now?.() ?? new Date();
  const request: FeedRequestFn = deps.request ?? feedRequest;
  const gateFor = (market: Market, now: Date): FeedGate => {
    try {
      return deps.gate ? deps.gate(market, now) : feedGateForMarket(market, deps.env, now);
    } catch {
      return { open: false, reason: 'disabled', monthlyJobs: null };
    }
  };
  const db = async (): Promise<FeedDb> => (deps.db ?? defaultDb)();
  let boardCounts: { at: number; counts: Map<string, number> } | null = null;

  /** Our enabled boards per ATS (one grouped statement, reused for ten minutes). A failed read excludes nothing. */
  async function enabledBoardCounts(store: FeedDb): Promise<ReadonlyMap<string, number>> {
    const at = clock();
    if (boardCounts && at - boardCounts.at < FEED_BOARD_COUNT_TTL_MS) return boardCounts.counts;
    try {
      const rows = await store.$queryRaw<Array<{ ats: string; n: number | bigint }>>`
        SELECT "ats", COUNT(*)::int AS "n" FROM "RACareerSiteSource" WHERE "enabled" = true GROUP BY "ats"`;
      const counts = new Map<string, number>();
      for (const row of Array.isArray(rows) ? rows : []) {
        const n = Number(row?.n);
        if (typeof row?.ats === 'string' && Number.isFinite(n)) counts.set(row.ats, n);
      }
      boardCounts = { at, counts };
      return counts;
    } catch (err) {
      logger.warn(TAG, 'enabled boards not counted: no ATS is excluded from this request', { error: errorCode(err) });
      return new Map();
    }
  }

  /** Our open public rows of the feed's board, as externalIds (keyset pages by id). */
  async function openExternalIds(store: FeedDb): Promise<Set<string>> {
    const open = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const rows: Array<{ id: string; externalId: string | null }> = await store.rAJob.findMany({
        where: { sourceBoard: FEED_BOARD, archivedAt: null, visibility: 'public', ...(after ? { id: { gt: after } } : {}) },
        select: { id: true, externalId: true },
        orderBy: { id: 'asc' },
        take: FEED_OPEN_ROWS_PAGE,
      });
      for (const row of rows) if (row.externalId) open.add(row.externalId);
      if (rows.length < FEED_OPEN_ROWS_PAGE) return open;
      after = rows[rows.length - 1]!.id;
    }
  }

  const reason = (market: Market, now: Date): string | null => {
    const gate = gateFor(market, now);
    // The registry's short code (the System panel turns the plan gate's code into the state 'gated').
    return gate.open || gate.reason === 'ok' ? null : (FEED_GATE_REASON_CODE[gate.reason] ?? 'disabled');
  };

  return {
    provider: FEED_PROVIDER,
    kind: 'cursor',
    markets: ['intl', 'cn'],
    costModel: 'per_job',
    sourceBoards: [FEED_BOARD],
    transport: () => (fantasticTransport(env()) === 'direct' ? 'api' : 'rapidapi'),
    // The gate, for the market the question is asked for (the admin lists each brand's sources inside that brand's context).
    isEnabled: () => gateFor(marketOfCall(), wallNow()).open,
    isEnabledFor: (market) => gateFor(market, wallNow()).open,
    disabledReason: () => reason(marketOfCall(), wallNow()),
    supportsCountry: () => false,
    // Metered in postings by this adapter (the day's budget), not in calls by the pipeline.
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      let calls = 0;
      try {
        const market = query.market;
        const now = ctx.now;
        const gate = gateFor(market, now);
        // Closed: no request is built, whatever leased the query.
        if (!gate.open) return { jobs: [], calls: 0, exhausted: true, notes: { feed_gate_closed: 1 } };

        const startedAt = clock();
        const notes: Record<string, number> = {};
        const bump = (key: string, by = 1) => {
          if (by > 0) notes[key] = (notes[key] ?? 0) + by;
        };
        /** May one more request start inside the caller's budget? The first request of a fetch always may. */
        const timeFor = (): boolean => calls === 0 || ctx.budgetMs === undefined || clock() - startedAt + REQUEST_RESERVE_MS <= ctx.budgetMs;

        let cursor = parseFeedCursor(query.params.cursor);
        if (cursor.lastExpiredMonthlyAt === null) {
          // A new sync holds nothing a month of expirations could close: the first reconciliation is due in 30 days.
          cursor = { ...cursor, lastExpiredMonthlyAt: now.toISOString() };
        }
        const jobs: ProviderJobInput[] = [];
        let more = false;

        // ── New jobs: at most one page ──
        const planned = planFeedPage(cursor, now);
        if (planned) {
          const store = await db();
          const location = feedLocationFilter(market, env());
          const taxonomy = feedTaxonomyFilter(env());
          const usage = usageKey(FEED_PLAN_PROVIDER, market);
          const day = dayKey(now);
          // What the provider last said about the plan's postings. The day is never more than what is left of the
          // period, less the reserve kept for people's own searches, spread over the days to its reset.
          const reading: FeedQuotaReading | null = deps.quota ? deps.quota(now) : quotaSnapshot(FEED_PLAN_PROVIDER, now);
          const budget = feedDailyJobsFor(market, env(), gate.monthlyJobs, feedQuotaDailyJobs(reading, now, env()));
          const used = await providerJobsToday(store, usage, day);
          // The hard budget cannot be kept without the day's count: nothing is asked.
          if (used === null) return { jobs: [], calls: 0, error: `${FEED_PROVIDER}:usage_unreadable` };
          // Never into the reserve, whatever the day says (a reading with no reset time gives no day's cap).
          const left = Math.min(budget - used, feedJobsLeft(reading, env()) ?? Number.POSITIVE_INFINITY);
          if (!location) bump('feed_no_countries');
          else if (taxonomy.invalid) bump('feed_bad_taxonomies');
          else if (left <= 0) bump('feed_budget_reached');
          else {
            const limit = Math.max(1, Math.min(FEED_PAGE_LIMIT, Math.floor(left)));
            const excludeSources = feedExcludedSources(await enabledBoardCounts(store));
            const params = feedPageParams({ request: planned.request, limit, location, excludeSources, taxonomies: taxonomy.names });
            const res = await request('active', params, { signal: ctx.signal, requestId: ctx.requestId });
            if (res.called) calls += 1;
            // Nothing is written and the cursor stays: the same page is asked again on the next run.
            if (!res.ok) return { jobs: [], calls, error: `${FEED_PROVIDER}:${res.error}` };
            const rows = res.body;
            // What the plan was billed for, under the plan's own usage row of the market (a failed write never loses the rows).
            try {
              await recordProviderUsage(store, usage, day, { returned: rows.length });
            } catch (err) {
              logger.warn(TAG, 'billed postings not counted', { market, rows: rows.length, error: errorCode(err) });
            }
            // The page must be the slice that was asked before it may move the cursor. Most of its rows indexed
            // outside the bounds means the API did not apply them: every later request would buy the whole window
            // again, so nothing is written, the cursor stays and the run is an error the admin panel shows.
            const slice = rowsOutsideSlice(rows, planned.request);
            if (slice.outside * 2 > slice.dated) {
              const facts = { market, track: planned.track, rows: rows.length, outside: slice.outside, createdGte: planned.request.createdGte, createdLt: planned.request.createdLt };
              if (!feedSliceCheckDisabled(env())) {
                logger.error(TAG, 'licensed feed: the page is not the slice that was asked (date_created bounds not applied); the cursor is not moved', facts);
                return { jobs: [], calls, error: `${FEED_PROVIDER}:window_not_applied`, notes: { feed_out_of_window: slice.outside } };
              }
              logger.warn(TAG, 'licensed feed: the page is not the slice that was asked; read all the same (FANTASTIC_FEED_SLICE_CHECK_DISABLED)', facts);
            }
            bump('feed_out_of_window', slice.outside);
            let newest = Number.NaN;
            for (const row of rows) {
              const created = vendorTime((row as { date_created?: unknown } | null)?.date_created);
              if (Number.isFinite(created) && !(created <= newest)) newest = created;
              const input = inputFromFantasticJob(row, FEED_BOARD, now);
              if (!input) {
                bump('feed_unmapped');
                continue;
              }
              // Each row in exactly one market, by its own resolved location (mainland China → cn, anything else → intl).
              if (marketOfPosting(input) !== market) {
                bump('wrong_market');
                continue;
              }
              jobs.push(input);
            }
            const advanced = advanceFeedCursor(planned.cursor, planned.track, rows.length, limit, newest);
            cursor = advanced.cursor;
            more = advanced.more;
          }
          // The day's budget is spent while hours wait: say how far behind the sync is (the operator narrows
          // INGEST_FEED_COUNTRIES / INGEST_FEED_TAXONOMIES, or raises the plan or INGEST_FEED_DAILY_JOBS).
          if (notes.feed_budget_reached && planned.track === 'hourly') {
            const from = Date.parse(planned.cursor.since ?? planned.cursor.until ?? '');
            const behindHours = Number.isFinite(from) ? Math.floor((now.getTime() - from) / HOUR) : null;
            if (behindHours !== null && behindHours >= FEED_BEHIND_WARN_HOURS) logger.warn(TAG, 'licensed feed is behind: the day\'s posting budget is spent', { market, budget, used, behindHours });
          }
        }

        // ── Expired ids: only when the new-jobs side has nothing more to read in this fetch ──
        const closed = new Set<string>();
        if (!more) {
          const asked = new Set<ExpiredFrame>();
          for (;;) {
            // Asked again after every call: an answered monthly call covers the hour and the day, a failed one leaves them due.
            const frame = dueExpiredFrames(cursor, now).find((f) => !asked.has(f));
            if (!frame || !timeFor() || ctx.signal?.aborted) break;
            asked.add(frame);
            const res = await request('expired', { time_frame: frame }, { signal: ctx.signal, requestId: ctx.requestId });
            if (res.called) calls += 1;
            if (!res.ok) {
              // No clock is moved: the same window is asked again. The new rows above are kept.
              if (res.called && (res.error === 'refused' || res.status === 404)) {
                // The route itself said no (401 / 403: a plan without it; 404: another path): not again before the
                // next UTC day. One call a day asks whether that changed, instead of two a cycle.
                bump('feed_expired_refused');
                cursor = { ...cursor, expiredRefusedAt: now.toISOString() };
                logger.warn(TAG, 'expired feed route refused the request: not asked again today (FANTASTIC_EXPIRED_PATH names the route)', { market, frame, status: res.status });
                break;
              }
              bump('feed_expired_error');
              logger.warn(TAG, 'expired feed not read', { market, frame, error: res.error });
              if (frame === '1m' && res.called) {
                // A monthly answer that cannot be read must not hold the hourly and daily calls back: it is tried again a day later.
                cursor = { ...cursor, lastExpiredMonthlyTriedAt: now.toISOString() };
                continue;
              }
              break;
            }
            let ids = res.body.map(feedExternalId).filter((id): id is string => id !== null);
            bump('feed_expired_ids', ids.length);
            if (ids.length > FEED_EXPIRED_PASS_THROUGH_MAX) {
              // A long list (a day, a month): only the ids of rows we hold open are handed on.
              try {
                const open = await openExternalIds(await db());
                ids = ids.filter((id) => open.has(id));
              } catch (err) {
                bump('feed_expired_error');
                logger.warn(TAG, 'open rows not read: expired ids not applied', { market, frame, error: errorCode(err) });
                break;
              }
            }
            for (const id of ids) closed.add(id);
            cursor = stampExpired(cursor, frame, now);
          }
        }

        return {
          jobs,
          calls,
          cursor: formatFeedCursor(cursor),
          // A full page: more rows wait right now (the pipeline keeps the query due).
          exhausted: !more,
          ...(closed.size > 0 ? { closedExternalIds: [...closed], closeReason: 'source_removed' as const } : {}),
          notes,
        };
      } catch (err) {
        return { jobs: [], calls, error: `${FEED_PROVIDER}:${errorCode(err)}` };
      }
    },
  };
}
