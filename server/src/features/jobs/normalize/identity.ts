// server/src/features/jobs/normalize/identity.ts
//
// Dedupe key, search text and lifecycle dates (ARCH §4.4).
//
//   dedupeKey  = K3, the fuzzy key: sha1(company | titleNormalized | place),
//                where company = 'd:' + the employer's registrable domain
//                when one is known for the row, else companyNameNormalized
//                (MARKET_STRATEGY §1.5; JI-5), and place = the city (table id
//                when known, else the posting's city words), else the remote
//                scope, else the country.
//   searchText = titleNormalized + companyNameNormalized + top skills.
//   expiresAt  = the deadline the source states, for every source (a date
//                without a time means "through that day"); with none, only
//                aggregator rows get a life from their posting date
//                (45 days; a JSearch row whose link is a job board: 21).
//                Employer boards, recruiter banks, open-data and government
//                sources never expire by age: they close by listing diff,
//                tombstone, sweep absence or their stated deadline (M-22,
//                JI-10). A user's own import never expires.
//   Zone-less times of a UTC+8 source (mainland China, Taiwan open data) are
//                read in that zone (`naiveOffsetMinutes`).

import { createHash } from 'node:crypto';
import type { Market } from '../../../platform/brand/index.js';
import { PROVIDER_META } from './source.js';
import type { NormalizeProvider } from './types.js';

export const DEFAULT_EXPIRY_DAYS = 45;
/** Life of a JSearch row whose only link is a job board or an aggregator: the payload carries no closure signal (JI-6). */
export const AGGREGATOR_BOARD_LINK_DAYS = 21;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface DedupePlace {
  cityId?: string | null;
  city?: string | null;
  remoteScope?: string | null;
  country?: string | null;
}

/** The place part of the dedupe key (lower case; '' when nothing is known). */
export function dedupePlace(p: DedupePlace): string {
  const value = p.cityId ?? (p.city ? p.city.normalize('NFKC').toLowerCase().trim() : null) ?? (p.remoteScope ? `remote:${p.remoteScope.toLowerCase()}` : null) ?? p.country?.toLowerCase() ?? '';
  return value;
}

/**
 * K3. `employerDomain` is the employer's registrable domain (`registrableDomain`
 * in ./company.ts) when one is known for the row: it replaces the name, so
 * "Stripe" and "Stripe, Inc." agree and two companies called "Summit" do not.
 * Without one the key is byte-identical to the name key it has always been.
 */
export function dedupeKey(companyNameNormalized: string, titleNormalized: string, place: DedupePlace, employerDomain?: string | null): string {
  const company = employerDomain ? `d:${employerDomain}` : companyNameNormalized;
  return createHash('sha1').update(`${company}|${titleNormalized}|${dedupePlace(place)}`).digest('hex');
}

/** Normalized title + company + up to 10 skills, at most 500 characters. */
export function buildSearchText(titleNormalized: string, companyNameNormalized: string, skills: readonly string[]): string {
  const parts = [titleNormalized, companyNameNormalized, ...skills.slice(0, 10)].filter(Boolean);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length <= 500 ? text : text.slice(0, 500).trimEnd();
}

/** "2026-10-11", "2026/10/11": a calendar day with no time and no zone. */
const DATE_ONLY_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
/** "2026-10-11T09:00", "2026-10-11 09:00:00.000", "2026/10/11 09:00:00": a wall-clock time with no zone. */
const NAIVE_TIME_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;

const pad2 = (v: string): string => v.padStart(2, '0');

/** A string with no time zone (a wall-clock time or a calendar day) → its instant read as UTC, else null for any other string. */
function naiveInstant(s: string): { ms: number; dateOnly: boolean } | null {
  const day = s.match(DATE_ONLY_RE);
  if (day) {
    const ms = Date.parse(`${day[1]}-${pad2(day[2]!)}-${pad2(day[3]!)}T00:00:00Z`);
    return Number.isNaN(ms) ? null : { ms, dateOnly: true };
  }
  const t = s.match(NAIVE_TIME_RE);
  if (!t) return null;
  const ms = Date.parse(`${t[1]}-${pad2(t[2]!)}-${pad2(t[3]!)}T${t[4]}:${t[5]}:${t[6] ?? '00'}${(t[7] ?? '').slice(0, 4)}Z`);
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

/**
 * The UTC offset, in minutes, of the wall clock a source writes its zone-less
 * times in (MARKET_STRATEGY §1.5 "Dates": mainland naive times are UTC+8).
 * Mainland sources (every row of market 'cn') and the two Taiwan government
 * sources publish local time, and both places are UTC+8 all year. Everything
 * else is read as UTC, as it always was. Only strings with no zone are
 * shifted: a Date, an epoch or a string that names its zone is an instant.
 */
export function naiveOffsetMinutesFor(provider: NormalizeProvider, market: Market): number {
  return market === 'cn' || provider === 'tw_open_data' || provider === 'tw_gov_jobs' ? 480 : 0;
}

/**
 * A valid Date from a Date / ISO string / epoch ms, else null. A string with
 * no zone is a wall-clock time in the source's zone: UTC by default, or
 * `naiveOffsetMinutes` east of UTC ('2026-10-11T09:00:00' with 480 is 01:00
 * UTC). A calendar day is the start of that day in that zone.
 */
export function toDate(value: string | Date | number | null | undefined, naiveOffsetMinutes = 0): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = value.trim();
  const naive = naiveInstant(s);
  const d = naive ? new Date(naive.ms - naiveOffsetMinutes * MINUTE_MS) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The instant a stated deadline ends. A deadline given as a calendar day
 * ("2026-10-20") means the posting is open THROUGH that day, so it ends with
 * the day's last millisecond in the source's zone; a deadline with a time is
 * that instant. Null for no / an unreadable value.
 */
export function deadlineInstant(value: string | Date | number | null | undefined, naiveOffsetMinutes = 0): Date | null {
  const d = toDate(value, naiveOffsetMinutes);
  if (!d || typeof value !== 'string' || !DATE_ONLY_RE.test(value.trim())) return d;
  return new Date(d.getTime() + DAY_MS - 1);
}

export interface PostedAtResult {
  postedAt: Date | null;
  estimated: boolean;
}

/**
 * The posting date. Missing, unparseable, before 2000 or more than a day in
 * the future → an estimate, marked as such: the existing row's firstSeenAt
 * when the job was seen before (so re-ingesting an undated job never makes it
 * look newly posted or pushes its expiry out), else the fetch time, else `now`.
 */
export function resolvePostedAt(
  posted: string | Date | null | undefined,
  opts: { estimated?: boolean | null; fetchedAt?: string | Date | null; firstSeenAt?: string | Date | null; now: Date; naiveOffsetMinutes?: number },
): PostedAtResult {
  const d = toDate(posted ?? null, opts.naiveOffsetMinutes ?? 0);
  const seen = toDate(opts.firstSeenAt ?? null);
  const firstSeen = seen && seen.getTime() <= opts.now.getTime() ? seen : null;
  const fetched = toDate(opts.fetchedAt ?? null);
  const fallback = firstSeen && (!fetched || firstSeen < fetched) ? firstSeen : (fetched ?? opts.now);
  if (!d || d.getUTCFullYear() < 2000 || d.getTime() > opts.now.getTime() + DAY_MS) return { postedAt: fallback, estimated: true };
  return { postedAt: d, estimated: opts.estimated === true };
}

/**
 * The date a reader may print for a row, of the three date facts of a posting
 * (posted, first seen, last verified: MARKET_STRATEGY §1.5). An estimated
 * `postedAt` is printed as "First seen {date}", and that is true only when the
 * estimate IS the day we first saw the row (`resolvePostedAt`'s fallback; a
 * response served from a provider cache is fetched a few hours earlier, hence
 * the day of tolerance). A source may hand an estimated date that is something
 * else: 台灣就業通's `TRANDATE` is the day the row was last updated at the
 * source. That date stays in the row for the feed's floor and ordering; no
 * reader prints it under a label it does not fit, so this answers null and the
 * card says "Posting date not listed" beside its "Last checked" date. A row
 * read without `firstSeenAt` is answered as before.
 */
export function displayPostedAt(row: { postedAt: Date | null; postedAtEstimated?: boolean | null; firstSeenAt?: Date | null }): Date | null {
  if (!row.postedAt) return null;
  if (row.postedAtEstimated !== true || !row.firstSeenAt) return row.postedAt;
  // A raw-SQL row can carry its timestamps as text.
  const apart = Math.abs(new Date(row.postedAt).getTime() - new Date(row.firstSeenAt).getTime());
  return Number.isFinite(apart) && apart > DAY_MS ? null : row.postedAt;
}

/**
 * The aggregators: the only providers whose rows get a life from their posting
 * date when the source states no deadline (M-22: "a posting-age cut-off
 * applies to aggregator rows only"). `activejobs_feed` is closed earlier by the
 * vendor's expired feed (MKT-5A); JSearch carries no closure signal at all.
 */
export const AGE_EXPIRY_PROVIDERS: readonly NormalizeProvider[] = ['activejobs', 'activejobs_feed', 'linkedin', 'jsearch'];

/** `RAJob.sourceBoard` of the aggregators' rows: the boards the maintenance age rule applies to (ingest/maintain.ts). */
export const AGE_EXPIRY_BOARDS: readonly string[] = [...new Set(AGE_EXPIRY_PROVIDERS.map((p) => PROVIDER_META[p].sourceBoard))];

/**
 * Every other provider: no life from the posting date. Employer boards, the
 * recruiter banks, the open-data and government sources close by listing
 * diff, tombstone, sweep absence or the deadline they state; a user's own
 * import is the user's. (The name is the list's old one: these providers DO
 * keep a deadline the source states, see `resolveExpiresAt`.)
 */
export const NO_DATE_EXPIRY_PROVIDERS: readonly NormalizeProvider[] = (Object.keys(PROVIDER_META) as NormalizeProvider[]).filter(
  (p) => !AGE_EXPIRY_PROVIDERS.includes(p),
);

export interface ExpiryOptions {
  /** The chosen apply link is on a job-board or aggregator host (not the employer's site, not an ATS). */
  boardLink?: boolean;
  /** See `toDate`. */
  naiveOffsetMinutes?: number;
}

/**
 * When a posting stops being listed by date (null = never by date).
 *   1. A user's own import: never.
 *   2. The deadline the source states (a valid date in or after 2000), for
 *      EVERY other provider: a Greenhouse application deadline, 台灣就業通
 *      STOP_DATE, a USAJOBS close date, a bank job's validity, an aggregator's
 *      validThrough. A calendar day counts through its end (`deadlineInstant`).
 *   3. With no deadline, only an aggregator row gets one from its posting
 *      date: 45 days, or 21 for a JSearch row whose link is a job board or an
 *      aggregator (a JSearch row that links to the employer or an ATS keeps 45:
 *      the board sync or the liveness check closes it earlier through the
 *      shared posting key).
 *   4. Everything else: none. An employer's board lists a role for as long as
 *      it is open, often for months.
 */
export function resolveExpiresAt(
  provider: NormalizeProvider,
  providerExpiry: string | Date | null | undefined,
  postedAt: Date | null,
  options: ExpiryOptions = {},
): Date | null {
  if (provider === 'user_import') return null;
  const explicit = deadlineInstant(providerExpiry ?? null, options.naiveOffsetMinutes ?? 0);
  if (explicit && explicit.getUTCFullYear() >= 2000) return explicit;
  if (!AGE_EXPIRY_PROVIDERS.includes(provider) || !postedAt) return null;
  const days = provider === 'jsearch' && options.boardLink === true ? AGGREGATOR_BOARD_LINK_DAYS : DEFAULT_EXPIRY_DAYS;
  return new Date(postedAt.getTime() + days * DAY_MS);
}
