// server/src/features/jobs/sources/usaJobs.ts — USAJOBS, US federal vacancies
// (MKT-5D; MARKET_STRATEGY §1.2 tier 3, §1.5, §7 item 3, JI-9;
// JOB_SOURCES_INTL §4.2, §6.4).
//
// The source. The U.S. Office of Personnel Management's official search API.
// Everything below was read on the developer site (https://developer.usajobs.gov)
// on 2026-10-12; the API itself was NOT called (no key exists yet):
//
//   /api-reference/get-api-search   GET https://data.usajobs.gov/api/Search
//       DatePosted       "posted within the number of days", 0 to 60
//       ResultsPerPage   up to 500
//       Page             the page of results
//     and the response: SearchResult.SearchResultItems[], each
//     { MatchedObjectId (the control number), MatchedObjectDescriptor { … } }.
//   /guides/authentication          three request headers: `Host`
//       (always data.usajobs.gov), `User-Agent` (the e-mail address the key was
//       requested with) and `Authorization-Key` (the key).
//   /guides/rate-limiting           500 rows a page, 10,000 rows a query; a
//       search returns jobs open to the public unless the key is authorised
//       for more.
//   /guides/terms-of-service        the data is public data under an open
//       licence (copy, store, publish, commercial use, no approval needed);
//       OPM "encourages" naming USAJOBS as the source, linking to the official
//       announcement and saying when the data was retrieved; nobody may imply
//       that OPM runs or endorses the product. See docs/job-search/SOURCE_REGISTER.md.
//
// Off without a key. USAJOBS_API_KEY and USAJOBS_USER_AGENT_EMAIL must both be
// set (the key is free, requested with a contact e-mail), and USAJOBS_DISABLED
// must not be true. `usaJobsStatus` says which: 'no_key' or 'disabled'. While
// off the adapter builds no request at all.
//
// One run a day. The standing query's `params.cursor` is JSON
// `{ v: 1, day, page, firstRunDone, doneDay }`. A fetch asks ONE page and says
// `exhausted: false` while a full page (500 items) came back, so ingest leases
// it again; a shorter page ends the run and nothing is asked until the next
// UTC day. The first run asks for the last 7 days (`DatePosted=7`), every
// later one for 1. When a day was missed (the run did not finish, the key was
// off) the next run asks for the days since the last finished run instead, up
// to the API's 60. A run stops at page 20: the API serves 10,000 rows a query.
// A failed request is an ingest error: no cursor is stored, so the same page
// is asked again later.
//
// Mapping (field names from the reference; __fixtures__/usajobs/README.md):
//   externalId   'usajobs:<control number>'
//   company      OrganizationName, else DepartmentName
//   applyUrl     the first ApplyURI on usajobs.gov, else PositionURI (D1: the
//                user applies on the official announcement)
//   locations    PositionLocation[].LocationName, as listed
//   pay          PositionRemuneration: minimum, maximum and the rate interval,
//                in USD as stated. The reference documents one interval pair
//                (`PA`, "Per Year"); any other interval is read from the
//                item's own Description ("Per Hour", "Per Day", "Per Week",
//                "Per Month"). An interval that is none of these ("Bi-weekly",
//                "Without Compensation" …) gives NO figure: nothing is
//                converted or guessed (`usajobs_pay_interval_unmapped`). The
//                description is never read for a figure. The row's pay
//                columns are whole numbers, so an hourly rate with cents is
//                stored rounded; for such a row the exact figures and wording
//                are handed over as the pay text too ("$21.50 - $27.95 Per
//                Hour"), which the job page prints as stated.
//   postedAt     PublicationStartDate (the calendar day)
//   expiresAt    ApplicationCloseDate, "last date applications will be
//                accepted": a calendar day, so the row is open THROUGH that
//                day and is archived after it (PositionEndDate when the item
//                has no close date). The day is ended in UTC, a few hours
//                before the end of the same day in U.S. Eastern Time: a row is
//                never listed after its close date. An item with no close date
//                is skipped and counted (`usajobs_no_close_date`): this source
//                has no other closure signal, so the row could never be closed.
//   employment   PositionSchedule, when the item names exactly one
//   description  JobSummary, MajorDuties, QualificationSummary, Education,
//                KeyRequirements and Requirements, each under its own heading,
//                then who may apply. `HowToApply` and every contact field are
//                never read (announcements name agency staff).
//
// Who may apply, told as the item tells it. The hiring path is carried as a
// tag `usajobs_hiring_path` whose quote is the item's own wording
// (`UserArea.Details.WhoMayApply.Name`, the documented field; and, when an
// answer carries it, the `HiringPath` code list of the same object, each code
// by its documented name). The tag travels beside the input (`UsaJobsInput`),
// and the same words are written into the description: who may apply is its
// last section and the key requirements are listed under "Requirements", so
// the job page shows them.
//
// Citizenship. This adapter sets no citizenship flag, and nothing here assumes
// one because the employer is the federal government. `RAJob.citizenshipRequired`
// has one writer, the quote-verified enrichment (jobs/enrich), and it reads the
// item's own statement where this adapter puts it, verbatim: in "Requirements"
// and in "This job is open to". A second reader here would be a second rule:
// "U.S. citizenship or permanent residency" and "citizens, nationals or those
// who owe allegiance" are either/or statements that a pattern reads as a
// requirement. No applicant count is read.

import type { EnvSource } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import type { ProviderJobInput } from '../normalize/index.js';
import type { JobSourceAdapter, SourceFetchResult } from './types.js';

export const USAJOBS_PROVIDER = 'usajobs';
export const USAJOBS_BOARD = 'usajobs';
export const USAJOBS_PUBLISHER = 'USAJOBS';
export const USAJOBS_HOST = 'data.usajobs.gov';
export const USAJOBS_SEARCH_URL = `https://${USAJOBS_HOST}/api/Search`;
/** Rows a page holds at most (the documented maximum); a page of this size has a next one. */
export const USAJOBS_PAGE_SIZE = 500;
/** Rows one query serves at most (the documented limit), and so the last page of a run. */
export const USAJOBS_MAX_ROWS = 10_000;
export const USAJOBS_MAX_PAGE = USAJOBS_MAX_ROWS / USAJOBS_PAGE_SIZE;
/** `DatePosted` of the first run and of every later one (MARKET_STRATEGY §1.2 tier 3). */
export const USAJOBS_FIRST_RUN_DAYS = 7;
export const USAJOBS_DAILY_DAYS = 1;
/** The largest `DatePosted` the API accepts. */
export const USAJOBS_MAX_WINDOW_DAYS = 60;
export const USAJOBS_TIMEOUT_MS = 30_000;
export const USAJOBS_MAX_BYTES = 32 * 1024 * 1024;
/** A fetch starts its one request only when the caller can still give it this much time. */
export const USAJOBS_MIN_BUDGET_MS = 15_000;
export const USAJOBS_HIRING_PATH_TAG = 'usajobs_hiring_path';
/** Locations kept of one announcement, as listed. */
const MAX_LOCATIONS = 25;
const MAX_SECTION_CHARS = 12_000;
const MAX_QUOTE_CHARS = 300;

// ── Switches ────────────────────────────────────────────────────────────────

export type UsaJobsStatus = { enabled: true } | { enabled: false; reason: 'no_key' | 'disabled' };

const ON_WORDS = new Set(['true', '1', 'on', 'yes']);

/** A value fit for an HTTP header: one line of printable ASCII. Null for anything else (a line break can never add a header). */
function headerValue(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value && /^[\x20-\x7E]+$/.test(value) ? value : null;
}

/** The key and the e-mail address it was issued to, or null when either is missing or not usable. The values are never logged. */
export function usaJobsCredentials(env: EnvSource = process.env): { key: string; email: string } | null {
  const key = headerValue(env.USAJOBS_API_KEY);
  const email = headerValue(env.USAJOBS_USER_AGENT_EMAIL);
  if (!key || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { key, email };
}

/** Off when USAJOBS_DISABLED is true ('disabled'), or when the key or its e-mail address is missing ('no_key'). */
export function usaJobsStatus(env: EnvSource = process.env): UsaJobsStatus {
  const flag = env.USAJOBS_DISABLED?.trim().toLowerCase();
  if (flag && ON_WORDS.has(flag)) return { enabled: false, reason: 'disabled' };
  if (!usaJobsCredentials(env)) return { enabled: false, reason: 'no_key' };
  return { enabled: true };
}

export function usaJobsEnabled(env: EnvSource = process.env): boolean {
  return usaJobsStatus(env).enabled;
}

// ── One request ─────────────────────────────────────────────────────────────

export type UsaJobsFetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}>;

export interface UsaJobsRequest {
  /** `DatePosted`: postings of the last N days. */
  datePosted: number;
  page: number;
}

/** One item of `SearchResult.SearchResultItems`. */
export type UsaJobsItem = Record<string, unknown>;

export type UsaJobsPage = { ok: true; items: UsaJobsItem[] } | { ok: false; error: string };

export function usaJobsSearchUrl(req: UsaJobsRequest): string {
  const url = new URL(USAJOBS_SEARCH_URL);
  url.searchParams.set('DatePosted', String(Math.min(USAJOBS_MAX_WINDOW_DAYS, Math.max(0, Math.floor(req.datePosted)))));
  url.searchParams.set('ResultsPerPage', String(USAJOBS_PAGE_SIZE));
  url.searchParams.set('Page', String(Math.max(1, Math.floor(req.page))));
  return url.toString();
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads one answer. Anything that is not the documented envelope is an error (a run never ends on a broken answer). Never throws. */
export function parseUsaJobsPage(text: string): UsaJobsPage {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  const result = isRecord(body) ? body.SearchResult : null;
  const items = isRecord(result) ? result.SearchResultItems : null;
  if (!Array.isArray(items)) return { ok: false, error: 'bad_shape' };
  return { ok: true, items: items.filter(isRecord) };
}

export interface UsaJobsRequestDeps {
  fetch?: UsaJobsFetchLike;
  env?: EnvSource;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One GET of the search API. Never throws: a failure is `{ ok: false, error }` with a short code that holds no credential. */
export async function requestUsaJobs(req: UsaJobsRequest, deps: UsaJobsRequestDeps = {}): Promise<UsaJobsPage> {
  const credentials = usaJobsCredentials(deps.env ?? process.env);
  if (!credentials) return { ok: false, error: 'no_key' };
  if (deps.signal?.aborted) return { ok: false, error: 'aborted' };
  const doFetch: UsaJobsFetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? USAJOBS_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(usaJobsSearchUrl(req), {
      signal: controller.signal,
      // The three headers the API's authentication guide requires, by their documented names.
      headers: { Host: USAJOBS_HOST, 'User-Agent': credentials.email, 'Authorization-Key': credentials.key, Accept: 'application/json' },
      redirect: 'error',
    });
    // A fetch that ignores `redirect` must still not be followed (the key would travel with it).
    if (res.status >= 300 && res.status < 400) return { ok: false, error: 'redirect' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const declared = Number(res.headers?.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > USAJOBS_MAX_BYTES) return { ok: false, error: 'response_too_large' };
    const text = await res.text();
    if (text.length > USAJOBS_MAX_BYTES || Buffer.byteLength(text, 'utf8') > USAJOBS_MAX_BYTES) return { ok: false, error: 'response_too_large' };
    return parseUsaJobsPage(text);
  } catch (err) {
    if (deps.signal?.aborted) return { ok: false, error: 'aborted' };
    if (controller.signal.aborted) return { ok: false, error: 'timeout' };
    if (err instanceof TypeError && /redirect/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`)) return { ok: false, error: 'redirect' };
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

// ── Item → normalizer input ─────────────────────────────────────────────────

/** A statement the source makes itself, with its own words (the shape of `RAJob.marketTags` entries). */
export interface UsaJobsMarketTag {
  tag: string;
  evidenceQuote: string;
  evidenceUrl: string | null;
}

/**
 * The normalizer input plus what the item states about who may apply: the
 * hiring-path tag. `ProviderJobInput` has no field for a source's own tags
 * yet (handoff MKT-5D, Requests): the same words are in the description too.
 */
export type UsaJobsInput = ProviderJobInput & { marketTags?: UsaJobsMarketTag[] };

export type UsaJobsSkip = 'no_external_id' | 'no_apply_url' | 'usajobs_no_close_date';

export type UsaJobsItemResult = { input: UsaJobsInput; payUnmapped: boolean } | { skip: UsaJobsSkip };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
/** A text field: a string, or a list of strings written one per line (`MajorDuties` is either). */
const prose = (v: unknown): string =>
  list(v)
    .map(str)
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_SECTION_CHARS)
    .trim();

/** An https page of usajobs.gov, as given (the API's own channel parameter is kept); null for any other link. */
export function usaJobsLink(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (host !== 'usajobs.gov' && !host.endsWith('.usajobs.gov'))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The calendar day of a date value ('2016-12-01T00:00:00Z', '2026-10-19T23:59:59.9970', '2026-10-19'), or null. */
export function usaJobsDay(value: unknown): string | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(str(value));
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? `${hit[1]}-${hit[2]}-${hit[3]}` : null;
}

export type UsaJobsPayPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';

/** The item's own interval wording → our period. Exact phrases only: "Bi-weekly" is not a week. */
const PERIOD_BY_DESCRIPTION: Readonly<Record<string, UsaJobsPayPeriod>> = {
  'per year': 'year',
  'per month': 'month',
  'per week': 'week',
  'per day': 'day',
  'per hour': 'hour',
};
/** The one code the reference documents with its meaning (`"RateIntervalCode": "PA", "Description": "Per Year"`). */
const PERIOD_BY_CODE: Readonly<Record<string, UsaJobsPayPeriod>> = { PA: 'year' };

/** The period of a remuneration entry, or null when its interval is not one we can state (never guessed; a code and a description that disagree give null). */
export function usaJobsPayPeriod(code: unknown, description: unknown): UsaJobsPayPeriod | null {
  const byDescription = PERIOD_BY_DESCRIPTION[str(description).toLowerCase().replace(/\s+/g, ' ')] ?? null;
  const byCode = PERIOD_BY_CODE[str(code).toUpperCase()] ?? null;
  if (byDescription && byCode && byDescription !== byCode) return null;
  return byDescription ?? byCode;
}

/** A positive amount as the item writes it ("92108", "21.50"), or null. */
function amount(value: unknown): number | null {
  const raw = str(value).replace(/,/g, '');
  if (!/^\d{1,9}(?:\.\d{1,4})?$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export interface UsaJobsPay {
  min: number | null;
  max: number | null;
  period: UsaJobsPayPeriod;
  /**
   * The range in the item's own figures and interval wording ("$21.50 - $27.95
   * Per Hour"), only when a figure has cents: `RAJob.salaryMin` / `salaryMax`
   * are whole numbers, so the exact words are kept beside the rounded figures.
   */
  text: string | null;
}

/** The first remuneration entry that states an amount: its range and period, `'unmapped'` when its interval cannot be stated, null when the item states no amount. */
export function usaJobsPay(remuneration: unknown): UsaJobsPay | 'unmapped' | null {
  for (const entry of list(remuneration)) {
    if (!isRecord(entry)) continue;
    const min = amount(entry.MinimumRange);
    const max = amount(entry.MaximumRange);
    if (min === null && max === null) continue;
    const period = usaJobsPayPeriod(entry.RateIntervalCode, entry.Description);
    if (!period) return 'unmapped';
    const wording = str(entry.Description).replace(/\s+/g, ' ');
    const stated = [min === null ? '' : str(entry.MinimumRange), max === null ? '' : str(entry.MaximumRange)].filter(Boolean).map((figure) => `$${figure}`);
    const cents = [min, max].some((n) => n !== null && !Number.isInteger(n));
    return { min, max, period, text: cents && wording ? `${stated.join(' - ')} ${wording}` : null };
  }
  return null;
}

/**
 * The `HiringPath` codes with their names: the definitions of the search
 * reference's HiringPath table, and for the two federal-employee paths the
 * fuller name of the site's hiring-paths page (both read 2026-10-12). A code
 * that is not here is not named.
 */
export const USAJOBS_HIRING_PATHS: Readonly<Record<string, string>> = {
  public: 'Open to the public',
  vet: 'Veterans',
  nguard: 'National Guard & Reserves',
  disability: 'Individuals with disabilities',
  native: 'Native Americans',
  mspouse: 'Military spouses',
  student: 'Students',
  ses: 'Senior executives',
  peace: 'Peace Corps & AmeriCorps Vista',
  overseas: 'Family of overseas employees',
  'fed-internal-search': 'Internal to an agency',
  graduates: 'Recent graduates',
  'fed-excepted': 'Federal employees - Excepted service',
  'fed-competitive': 'Federal employees - Competitive service',
  'fed-transition': 'Career transition (CTAP, ICTAP, RPL)',
  land: 'Land & base management',
  'special-authorities': 'Special authorities',
};

const clip = (text: string): string => (text.length <= MAX_QUOTE_CHARS ? text : text.slice(0, MAX_QUOTE_CHARS).trimEnd());

/**
 * Who may apply, in the item's own words: `WhoMayApply.Name` (the documented
 * field) and the names of its `HiringPath` codes when the answer carries them.
 * Null when the item says nothing.
 */
export function usaJobsHiringPath(details: unknown): string | null {
  if (!isRecord(details)) return null;
  const who = isRecord(details.WhoMayApply) ? str(details.WhoMayApply.Name) : str(details.WhoMayApply);
  const paths = list(details.HiringPath)
    .map((code) => USAJOBS_HIRING_PATHS[str(code).toLowerCase()] ?? '')
    .filter(Boolean);
  const said = [...new Set([who, ...paths].filter(Boolean))];
  return said.length ? clip(said.join('; ')) : null;
}

/** The announcement's text, each part under the heading the announcement page gives it. `HowToApply` and contact fields are never read. */
function describe(descriptor: Record<string, unknown>, details: Record<string, unknown>, openTo: string | null): string {
  const requirements = [...list(details.KeyRequirements).map(str).filter(Boolean).map((r) => `- ${r}`), prose(details.Requirements)].filter(Boolean).join('\n').slice(0, MAX_SECTION_CHARS);
  const sections: Array<[string | null, string]> = [
    [null, prose(details.JobSummary)],
    ['Duties', prose(details.MajorDuties)],
    ['Qualifications', prose(descriptor.QualificationSummary)],
    ['Education', prose(details.Education)],
    ['Requirements', requirements],
    ['This job is open to', openTo ?? ''],
  ];
  return sections
    .filter(([, text]) => text)
    .map(([heading, text]) => (heading ? `${heading}\n${text}` : text))
    .join('\n\n');
}

const CONTROL_NUMBER = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * One search result in the normalizer's input shape. Pure. An item with no
 * control number, no page on usajobs.gov or no close date is skipped (never
 * given an invented id, link or date).
 */
export function usaJobsItemToInput(item: UsaJobsItem, now: Date): UsaJobsItemResult {
  const descriptor = isRecord(item.MatchedObjectDescriptor) ? item.MatchedObjectDescriptor : {};
  const details = isRecord(descriptor.UserArea) && isRecord(descriptor.UserArea.Details) ? descriptor.UserArea.Details : {};

  const control = str(item.MatchedObjectId);
  if (!CONTROL_NUMBER.test(control)) return { skip: 'no_external_id' };
  const page = usaJobsLink(descriptor.PositionURI);
  const applyUrl = list(descriptor.ApplyURI).map(usaJobsLink).find((u): u is string => !!u) ?? page;
  if (!applyUrl) return { skip: 'no_apply_url' };
  const closes = usaJobsDay(descriptor.ApplicationCloseDate) ?? usaJobsDay(descriptor.PositionEndDate);
  if (!closes) return { skip: 'usajobs_no_close_date' };

  const places = list(descriptor.PositionLocation).filter(isRecord);
  const names = [...new Set(places.map((p) => str(p.LocationName)).filter(Boolean))].slice(0, MAX_LOCATIONS);
  const first = places[0];
  const schedules = list(descriptor.PositionSchedule)
    .filter(isRecord)
    .map((s) => str(s.Name))
    .filter(Boolean);
  const pay = usaJobsPay(descriptor.PositionRemuneration);
  const openTo = usaJobsHiringPath(details);
  const tags: UsaJobsMarketTag[] = openTo ? [{ tag: USAJOBS_HIRING_PATH_TAG, evidenceQuote: openTo, evidenceUrl: page ?? applyUrl }] : [];

  const input: UsaJobsInput = {
    externalId: `usajobs:${control}`,
    sourceBoard: USAJOBS_BOARD,
    title: str(descriptor.PositionTitle),
    company: str(descriptor.OrganizationName) || str(descriptor.DepartmentName),
    description: describe(descriptor, details, openTo),
    // D1: the user applies on the official announcement.
    applyUrl,
    sourceUrl: page ?? applyUrl,
    sourcePublisher: USAJOBS_PUBLISHER,
    location: names[0] ?? (str(descriptor.PositionLocationDisplay) || null),
    locations: names.length ? names : null,
    // The country and state the item states for its first location; nothing is assumed when it states none.
    locationRegion: first ? str(first.CountrySubDivisionCode) || null : null,
    locationCountry: first ? str(first.CountryCode) || null : null,
    employmentType: schedules.length === 1 ? schedules[0]! : null,
    ...(pay && pay !== 'unmapped'
      ? { salaryMin: pay.min, salaryMax: pay.max, salaryCurrency: 'USD', salaryPeriod: pay.period, ...(pay.text ? { salaryText: pay.text } : {}) }
      : { salaryMin: null, salaryMax: null }),
    // Pay is what the remuneration fields state and nothing else: the description is not read for a figure.
    payFromFieldsOnly: true,
    postedAt: usaJobsDay(descriptor.PublicationStartDate),
    fetchedAt: now,
    // A calendar day: open through that day (the normalizer's rule for a date-only deadline).
    expiresAt: closes,
    ...(tags.length ? { marketTags: tags } : {}),
  };
  return { input, payUnmapped: pay === 'unmapped' };
}

// ── The cursor ──────────────────────────────────────────────────────────────

/** `RAIngestQuery.params.cursor` of the adapter's standing query (JSON text). */
export interface UsaJobsCursor {
  v: 1;
  /** UTC day ('YYYY-MM-DD') of the run in progress, or of the last finished run when `page` is 0. Null before the first run. */
  day: string | null;
  /** The next page to ask for in the run of `day`; 0 when that run is finished. */
  page: number;
  /** A first run (the 7-day window) was read to its end. */
  firstRunDone: boolean;
  /** UTC day of the last run read to its end. */
  doneDay: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function emptyUsaJobsCursor(): UsaJobsCursor {
  return { v: 1, day: null, page: 0, firstRunDone: false, doneDay: null };
}

/** Reads a stored cursor. Anything that is not one starts with the first run. Never throws. */
export function parseUsaJobsCursor(text: string | null | undefined): UsaJobsCursor {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return emptyUsaJobsCursor();
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.v !== 1) return emptyUsaJobsCursor();
    const day = typeof raw.day === 'string' && DAY_RE.test(raw.day) ? raw.day : null;
    const doneDay = typeof raw.doneDay === 'string' && DAY_RE.test(raw.doneDay) ? raw.doneDay : null;
    const page = typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page >= 0 && raw.page <= USAJOBS_MAX_PAGE ? raw.page : 0;
    // A finished first run always left its day behind: without one the first run is still to do.
    return { v: 1, day, page: day ? page : 0, firstRunDone: raw.firstRunDone === true && doneDay !== null, doneDay };
  } catch {
    return emptyUsaJobsCursor();
  }
}

export function formatUsaJobsCursor(cursor: UsaJobsCursor): string {
  return JSON.stringify(cursor);
}

/** The UTC calendar day of an instant, 'YYYY-MM-DD'. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * `DatePosted` of a run on `today`: 7 on the first run, then the days since
 * the last finished run (1 when the source is read every day), at most the
 * API's 60.
 */
export function usaJobsWindowDays(cursor: Pick<UsaJobsCursor, 'firstRunDone' | 'doneDay'>, today: string): number {
  if (!cursor.firstRunDone || !cursor.doneDay) return USAJOBS_FIRST_RUN_DAYS;
  const gap = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${cursor.doneDay}T00:00:00Z`)) / DAY_MS);
  return Math.min(USAJOBS_MAX_WINDOW_DAYS, Math.max(USAJOBS_DAILY_DAYS, Number.isFinite(gap) ? gap : USAJOBS_DAILY_DAYS));
}

// ── The adapter ─────────────────────────────────────────────────────────────

export interface UsaJobsAdapterDeps {
  fetch?: UsaJobsFetchLike;
  env?: EnvSource;
}

export function createUsaJobsAdapter(deps: UsaJobsAdapterDeps = {}): JobSourceAdapter {
  const env = (): EnvSource => deps.env ?? process.env;
  return {
    provider: USAJOBS_PROVIDER,
    kind: 'cursor',
    markets: ['intl'],
    costModel: 'free',
    sourceBoards: [USAJOBS_BOARD],
    transport: () => 'api',
    disabledReason: () => {
      try {
        const status = usaJobsStatus(env());
        return status.enabled ? null : status.reason;
      } catch {
        return 'disabled';
      }
    },
    isEnabled: () => {
      try {
        return usaJobsEnabled(env());
      } catch {
        return false;
      }
    },
    supportsCountry: (country) => typeof country === 'string' && country.trim().toUpperCase() === 'US',
    // A free key: the API states row limits, no call quota.
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      try {
        // The switch and the market are checked here too: without a key nothing is ever fetched.
        if (!usaJobsEnabled(env()) || query.market !== 'intl') return { jobs: [], calls: 0, exhausted: true };
        const today = utcDay(ctx.now);
        let cursor = parseUsaJobsCursor(query.params.cursor);
        // Today's run is finished: nothing is asked until the next UTC day.
        if (cursor.day === today && cursor.page === 0) return { jobs: [], calls: 0, exhausted: true };
        if (cursor.day !== today || cursor.page < 1) cursor = { ...cursor, day: today, page: 1 };
        // Not done, and nothing asked: the ingest tick sets the source aside for the rest of the tick
        // (ingest/run.ts) and the query stays due for the next one.
        if (ctx.signal?.aborted || (ctx.budgetMs !== undefined && ctx.budgetMs < USAJOBS_MIN_BUDGET_MS)) return { jobs: [], calls: 0, exhausted: false };

        const request: UsaJobsRequest = { datePosted: usaJobsWindowDays(cursor, today), page: cursor.page };
        const timeoutMs = ctx.budgetMs === undefined ? USAJOBS_TIMEOUT_MS : Math.min(USAJOBS_TIMEOUT_MS, Math.max(5_000, ctx.budgetMs - 5_000));
        const page = await requestUsaJobs(request, { fetch: deps.fetch, env: env(), signal: ctx.signal, timeoutMs });
        if (!page.ok) {
          // Our own cut, not the source's failure.
          if (page.error === 'aborted') return { jobs: [], calls: 0, exhausted: false };
          logger.warn('JOB_SOURCES', 'usajobs request failed', { error: page.error, page: request.page, datePosted: request.datePosted });
          // Ingest stores no cursor for an error result: the same page is asked again later.
          return { jobs: [], calls: 1, error: `usajobs:${page.error}` };
        }

        const jobs: ProviderJobInput[] = [];
        const notes: Record<string, number> = {};
        const bump = (key: string) => {
          notes[key] = (notes[key] ?? 0) + 1;
        };
        for (const item of page.items) {
          const mapped = usaJobsItemToInput(item, ctx.now);
          if ('skip' in mapped) {
            bump(mapped.skip);
            continue;
          }
          jobs.push(mapped.input);
          if (mapped.payUnmapped) bump('usajobs_pay_interval_unmapped');
        }

        // A full page has a next one, up to the API's 10,000 rows a query.
        const full = page.items.length >= USAJOBS_PAGE_SIZE;
        const more = full && cursor.page < USAJOBS_MAX_PAGE;
        if (full && !more) bump('usajobs_row_cap');
        const next: UsaJobsCursor = more ? { ...cursor, page: cursor.page + 1 } : { v: 1, day: today, page: 0, firstRunDone: true, doneDay: today };
        if (!more) logger.info('JOB_SOURCES', 'usajobs run ended', { day: today, pages: cursor.page, datePosted: request.datePosted });
        return { jobs, calls: 1, cursor: formatUsaJobsCursor(next), exhausted: !more, notes };
      } catch (err) {
        return { jobs: [], calls: 0, error: err instanceof Error ? `usajobs:${err.message.slice(0, 160)}` : 'usajobs_failed' };
      }
    },
  };
}
