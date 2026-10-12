// server/src/features/jobs/sources/twOpenData.ts — 台灣就業通 open-data
// vacancies (MKT-3E; MARKET_STRATEGY §1.3, §1.5, JT-2, critic C12).
//
// The source. 勞動部勞動力發展署 publishes 台灣就業通's live vacancies as
// data.gov.tw dataset 44062 「台灣就業通網站職缺清單」 under the 政府資料開放授權
// 條款 第1版 (OGDL v1): commercial use and redisplay are allowed WITH
// attribution (twHooks.ts puts the sentence on every row; no 台灣就業通 logo is
// ever used: trademarks are outside the licence). The licence is confirmed by
// reading (MARKET_STRATEGY §8), so the adapter is ON by default.
//
//   GET <TW_OPEN_DATA_JOBS_URL>?CITY=<code>&COUNT=1000&T=CSV[&zipno=<3 digits>][&jobno=<2 digits>]
//
// No key, no paging, at most 1,000 rows per answer. Shape confirmed against
// the live endpoint on 2026-10-11 (structure only; no posting was kept): a
// UTF-8 CSV with a byte-order mark; every header carries its Chinese label in
// full-width brackets ("OCCU_DESC（職務名稱）"), so columns are matched on the
// ASCII part; STOP_DATE is YYYYMMDD or the words 額滿為止; NT_L / NT_U are
// digits or "-"; `CITY` combines with `zipno` and with `jobno`.
//
// What the filters are NOT. `CITY` and `zipno` do not select on the place a
// row displays (CITYNAME). Measured on the live endpoint on 2026-10-11:
// `CITY=01&zipno=103` (大同區, 127 rows, under the cap) returned one row that
// displays 台北市中正區 and one that displays 台北市不限, and left out rows the
// county answer displays in 大同區; a county answer holds a few rows that
// display another county. So a row's place name never tells which request
// returns it, and nothing here infers one from the other.
//
// The sweep. Everything under the cap is read by splitting:
//   county (22 `CITY` codes)
//     → a county that returns 1,000 rows is walked district by district
//       (`zipno`, geo/twDistricts)
//       → a district that returns 1,000 is walked 大類 by 大類 (`jobno`,
//         taxonomy/twJobno); a leaf that still returns 1,000 keeps its rows
//         and marks the sweep incomplete.
//   With no district table a capped county is walked by 大類 instead.
// What the split misses is MEASURED, not assumed: while a capped county is
// walked, the cursor keeps the ids of the county's own answer (its first
// 1,000 rows) and drops each id a narrower request returns. What is left when
// the districts are done are rows that no district request returns
// (`notes.tw_county_only`): the share of that sample the split cannot reach.
// When it is TW_OPEN_DATA_COUNTY_WALK_MIN rows or more (default 50, 5% of the
// sample; 0 = never) the county is read a second time, 大類 by 大類
// (`CITY=<code>&jobno=01..22`). A (county, 大類) answer of that second walk
// that is still capped is counted (`tw_capped_county_major`) and does not
// make the sweep incomplete: it is extra coverage, not part of the split.
// A full sweep is a few hundred sequential requests and cannot finish in one
// 300 s function run, so it is a RESUMABLE CURSOR: the adapter's standing
// query keeps `params.cursor` (JSON, `TwSweepCursor`). One fetch makes at most
// TW_OPEN_DATA_REQUESTS_PER_FETCH requests, strictly one after the other with
// TW_OPEN_DATA_PAUSE_MS between them and the identifying User-Agent, then
// answers `exhausted: false`; ingest leases it again while its tick has
// budget. The pause also holds between the last request of one fetch and the
// first of the next (the adapter remembers when its last request ended; a
// fetch whose budget cannot hold that wait makes no request). After the last
// county the adapter answers without any request until
// TW_OPEN_DATA_SWEEP_HOURS after the sweep's start: one sweep a day.
//
// Errors. A failed request ends the fetch and leaves the position where it
// was (the next fetch retries it); the strike count lives in the cursor. The
// third consecutive failure at one position marks the sweep incomplete and
// moves on. The result is not an ingest `error`, because ingest writes no
// cursor for an error result and the count would be lost: the failure is
// logged and counted in `notes.tw_request_errors`.
//
// Closure. A posting leaves the source without a signal, so a row is closed
// when two consecutive complete sweeps did not see it: when a complete sweep
// ends and an earlier complete sweep exists, open public rows of this board
// last seen before that earlier sweep began are candidates, returned as
// `closedExternalIds` ('source_removed'; the upsert revives a row the source
// lists again). An incomplete sweep closes nothing. Absence proves a posting
// gone only where the sweep read a listing to its end, and the only listing
// known to be read to its end is a county answer under the cap. So a
// candidate is closed only when the county it displays was read whole, by its
// own answer, in BOTH sweeps. Rows of a county that hit the cap in either
// sweep are never closed by absence, whatever district they display (see
// "What the filters are NOT"): they end on STOP_DATE (`expiresAt`) or the age
// rule, and are counted in `notes.tw_absence_unproven`.
// Known limit of this rule: a row that displays a county read whole but is
// returned under a capped one (seen: a few per thousand) is judged by the
// county it displays. Closing by the request that last returned the row
// needs that request stored with the row (handoff: schema request
// RAJob.sourceScope).
//
// The shift (MKT-5F, JT-7). WKTIME（工作時間） is the source's own statement of
// the shift pattern: one or more of a short list of values joined by 、
// (`TW_SHIFT_VALUES`; every value seen on the live endpoint is listed in the
// fixtures README). It maps to `ProviderJobInput.workShift`:
//   日班 → day · 中班 → evening · 夜班 → night · 輪班… → rotating ·
//   部份工時… → part_time
// A row that lists several takes `rotating` when a 輪班 value is among them,
// else the first value that maps. A value outside the list maps to nothing
// (null), and the shift is never read out of the title or JOB_DETAIL. So that
// nothing the source said is lost, WKTIME is appended to the description as
// one line under the column's own label whenever it says more than the stored
// value does (several values, the rota, the hours of a part-time job, an
// unknown value).
//
// D1: the user applies on job.taiwanjobs.gov.tw (`URL_QUERY`). D3: a row
// without EMPLOYER_ID and HIRE_ID in its URL is skipped and counted
// (`notes.no_external_id`; `no_apply_url` when the cell is not a vacancy link
// at all), never given an invented id; pay comes only from the numeric NT_L /
// NT_U fields and the statutory threshold is never stored or inferred.
//
// Counters of a fetch (`notes`): no_external_id, no_apply_url,
// tw_request_errors, tw_skipped_position, tw_capped_leaf, tw_county_only,
// tw_county_unreached, tw_capped_county_major, tw_sweep_finished,
// tw_sweep_incomplete, tw_absence_unproven. `tw_sweep_finished` says the
// sweep read every position of its split under the cap; it does NOT say every
// open vacancy was read: `tw_county_only` is the measured gap.

import { parse as parseCsv } from 'csv-parse/sync';
import type { EnvSource } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import { TW_COUNTIES, districtsOfCounty, findTwDistrict, type TwCounty, type TwDistrict } from '../geo/index.js';
import type { ProviderJobInput, WorkShift } from '../normalize/index.js';
import { TW_JOBNO_MAJORS, twRoleForJobno } from '../taxonomy/index.js';
import type { JobSourceAdapter, SourceFetchResult } from './types.js';
import { sourceUserAgent } from './userAgent.js';

export const TW_OPEN_DATA_PROVIDER = 'tw_open_data';
export const TW_OPEN_DATA_BOARD = 'tw_open_data';
export const TW_OPEN_DATA_PUBLISHER = '台灣就業通';
/** The documented endpoint (interface document of 115-08-03). */
export const TW_OPEN_DATA_DEFAULT_URL = 'https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx';
/** Rows one answer holds at most; an answer of this size was cut. */
export const TW_OPEN_DATA_ROW_CAP = 1000;
export const TW_OPEN_DATA_TIMEOUT_MS = 20_000;
export const TW_OPEN_DATA_MAX_BYTES = 8 * 1024 * 1024;
/** Consecutive failures at one position before the sweep gives it up. */
export const TW_OPEN_DATA_MAX_STRIKES = 3;
/** Rows one closure step reads (and so closes at most). */
export const TW_OPEN_DATA_CLOSE_PAGE = 5000;
/** A later request of a fetch starts only when the caller's budget still holds this much. */
const REQUEST_RESERVE_MS = 8_000;
/**
 * Rows of a capped county's own answer that no district request returned, at
 * or above which the county is read a second time by 大類: 5% of the sample
 * of 1,000. Below it the second walk costs more requests than it finds rows.
 */
export const TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT = 50;

/** The dataset, as the licence's Exhibit wants it named (provider, dataset name, licence). */
export const TW_OPEN_DATA_DATASET = {
  id: 44062,
  name: '台灣就業通網站職缺清單',
  provider: '勞動部勞動力發展署',
  page: 'https://data.gov.tw/dataset/44062',
  licence: '政府資料開放授權條款第1版',
  licenceUrl: 'https://data.gov.tw/license',
} as const;

// ── Switches ────────────────────────────────────────────────────────────────

export type TwOpenDataStatus = { enabled: true } | { enabled: false; reason: 'kill_switch' | 'url_invalid' };

const OFF_WORDS = new Set(['false', '0', 'off', 'no']);

function intEnv(env: EnvSource, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/**
 * The endpoint: TW_OPEN_DATA_JOBS_URL, else the documented one. https only,
 * no credentials, and only a host of taiwanjobs.gov.tw (an override can move
 * the path or the subdomain, never point the adapter at another site). Null
 * when the configured value is not usable.
 */
export function twOpenDataBaseUrl(env: EnvSource = process.env): string | null {
  const raw = env.TW_OPEN_DATA_JOBS_URL?.trim() || TW_OPEN_DATA_DEFAULT_URL;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (host !== 'taiwanjobs.gov.tw' && !host.endsWith('.taiwanjobs.gov.tw')) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** On unless TW_OPEN_DATA_JOBS_ENABLED is explicitly false / 0 / off / no. */
export function twOpenDataStatus(env: EnvSource = process.env): TwOpenDataStatus {
  const flag = env.TW_OPEN_DATA_JOBS_ENABLED?.trim().toLowerCase();
  if (flag && OFF_WORDS.has(flag)) return { enabled: false, reason: 'kill_switch' };
  if (!twOpenDataBaseUrl(env)) return { enabled: false, reason: 'url_invalid' };
  return { enabled: true };
}

export function twOpenDataEnabled(env: EnvSource = process.env): boolean {
  return twOpenDataStatus(env).enabled;
}

export interface TwOpenDataConfig {
  requestsPerFetch: number;
  pauseMs: number;
  sweepMs: number;
  /** See TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT; 0 = a capped county is never read a second time. */
  countyWalkMin: number;
}

export function twOpenDataConfig(env: EnvSource = process.env): TwOpenDataConfig {
  return {
    requestsPerFetch: intEnv(env, 'TW_OPEN_DATA_REQUESTS_PER_FETCH', 5, 1, 50),
    pauseMs: intEnv(env, 'TW_OPEN_DATA_PAUSE_MS', 1500, 0, 60_000),
    sweepMs: intEnv(env, 'TW_OPEN_DATA_SWEEP_HOURS', 24, 1, 24 * 14) * 3_600_000,
    countyWalkMin: intEnv(env, 'TW_OPEN_DATA_COUNTY_WALK_MIN', TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT, 0, TW_OPEN_DATA_ROW_CAP),
  };
}

// ── One request ─────────────────────────────────────────────────────────────

export type TwFetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}>;

export interface TwOpenDataRequest {
  /** County code (`CITY`), two digits. */
  city: string;
  /** District: the first three digits of the postal code. */
  zipno?: string | null;
  /** 通俗職業 大類, two digits. */
  jobno?: string | null;
}

/** A row keyed by the ASCII part of each header. */
export type TwOpenDataRow = Record<string, string>;

export type TwOpenDataPage = { ok: true; rows: TwOpenDataRow[] } | { ok: false; error: string };

export function twOpenDataUrl(base: string, req: TwOpenDataRequest): string {
  const url = new URL(base);
  url.searchParams.set('CITY', req.city);
  if (req.zipno) url.searchParams.set('zipno', req.zipno);
  if (req.jobno) url.searchParams.set('jobno', req.jobno);
  url.searchParams.set('COUNT', String(TW_OPEN_DATA_ROW_CAP));
  url.searchParams.set('T', 'CSV');
  return url.toString();
}

/** 'OCCU_DESC（職務名稱）' → 'OCCU_DESC': the ASCII part before the bracket. */
export function twOpenDataHeader(header: unknown): string {
  return String(header ?? '')
    .replace(/^﻿/, '')
    .split(/[（(]/)[0]!
    .trim()
    .toUpperCase();
}

/** The columns an answer must carry to be the dataset at all. */
const REQUIRED_COLUMNS = ['OCCU_DESC', 'URL_QUERY', 'COMPNAME'] as const;

/** Parses one CSV answer. An empty body is an empty listing; anything that is not the dataset's CSV is an error. Never throws. */
export function parseTwOpenDataCsv(text: string): TwOpenDataPage {
  const body = text.replace(/^﻿/, '');
  if (!body.trim()) return { ok: true, rows: [] };
  let header: string[] = [];
  let rows: TwOpenDataRow[];
  try {
    rows = parseCsv(body, {
      columns: (names: string[]) => (header = names.map(twOpenDataHeader)),
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as TwOpenDataRow[];
  } catch {
    return { ok: false, error: 'not_csv' };
  }
  if (REQUIRED_COLUMNS.some((c) => !header.includes(c))) return { ok: false, error: 'not_csv' };
  return { ok: true, rows };
}

export interface TwRequestDeps {
  fetch?: TwFetchLike;
  env?: EnvSource;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One GET of the open-data endpoint. Never throws: a failure is `{ ok: false, error }` with a short code. */
export async function requestTwOpenData(req: TwOpenDataRequest, deps: TwRequestDeps = {}): Promise<TwOpenDataPage> {
  const env = deps.env ?? process.env;
  const base = twOpenDataBaseUrl(env);
  if (!base) return { ok: false, error: 'url_invalid' };
  if (deps.signal?.aborted) return { ok: false, error: 'aborted' };
  const doFetch: TwFetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TW_OPEN_DATA_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(twOpenDataUrl(base, req), {
      signal: controller.signal,
      headers: { Accept: 'text/csv', 'User-Agent': sourceUserAgent('intl', env) },
      redirect: 'error',
    });
    // A fetch that ignores `redirect` must still not be followed.
    if (res.status >= 300 && res.status < 400) return { ok: false, error: 'redirect' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const declared = Number(res.headers?.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > TW_OPEN_DATA_MAX_BYTES) return { ok: false, error: 'response_too_large' };
    const text = await res.text();
    if (text.length > TW_OPEN_DATA_MAX_BYTES || Buffer.byteLength(text, 'utf8') > TW_OPEN_DATA_MAX_BYTES) return { ok: false, error: 'response_too_large' };
    return parseTwOpenDataCsv(text);
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

// ── Row → normalizer input ──────────────────────────────────────────────────

/** A cell as the source wrote it (titles, names and places keep their own punctuation). */
const cell = (row: TwOpenDataRow, name: string): string => (typeof row[name] === 'string' ? row[name]!.trim() : '');
/** A cell we parse (dates, numbers, the fixed wordings): width-folded, so a full-width digit or bracket reads the same. */
const field = (row: TwOpenDataRow, name: string): string => cell(row, name).normalize('NFKC');

/** 'YYYYMMDD' → the parts, or null for anything else (額滿為止, an empty cell, an impossible date). */
function ymd(value: string): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!hit) return null;
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? { y, m, d } : null;
}

/** Taipei time is UTC+8 all year. */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The first instant of a Taipei calendar day, in UTC. */
function taipeiDayStart(value: string): Date | null {
  const p = ymd(value);
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d) - TAIPEI_OFFSET_MS) : null;
}

/** The last second of a Taipei calendar day, in UTC (STOP_DATE 20261231 → 2026-12-31T15:59:59Z). */
function taipeiDayEnd(value: string): Date | null {
  const start = taipeiDayStart(value);
  return start ? new Date(start.getTime() + 24 * 3_600_000 - 1000) : null;
}

/** A pay bound: the digits of NT_L / NT_U, or null for "-" and anything that is not a positive number. */
function payBound(value: string): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

/** SALARYCD → the pay period; null for 論件計酬 (piece work has no period) and for the no-figure sentence. */
function payPeriod(salaryCd: string): 'month' | 'hour' | 'day' | null {
  if (salaryCd === '月薪' || /^部[分份]工時\(月薪\)$/.test(salaryCd)) return 'month';
  if (salaryCd === '時薪') return 'hour';
  if (salaryCd === '日薪') return 'day';
  return null;
}

/** EDGRDESC → the education input's level word; anything else (高中, 高職, 國中 …) is left unset. */
function educationLabel(value: string): string | null {
  if (value === '不拘') return 'none';
  if (value === '專科') return 'associate';
  if (value === '大學') return 'bachelor';
  if (value === '碩士') return 'master';
  if (value === '博士') return 'phd';
  return null;
}

/** EXPERIENCE → the normalizer's band: 無 / 不拘 → no experience asked, N年以上 → at least N, N年內 → up to N. */
function experienceBand(value: string): string | null {
  if (value === '無' || value === '不拘') return '0+';
  const atLeast = /^(\d{1,2})年以上$/.exec(value);
  if (atLeast) return `${Number(atLeast[1])}+`;
  const within = /^(\d{1,2})年內$/.exec(value);
  if (within) return `0-${Number(within[1])}`;
  return null;
}

// ── WKTIME（工作時間） → the shift ───────────────────────────────────────────

/** The column's own label (the header reads `WKTIME（工作時間）`): data of the source, not UI copy. */
export const TW_WKTIME_LABEL = '工作時間';

/**
 * The values WKTIME carries and the shift each one states. Only values that
 * were read on the live endpoint (2026-10-12, 2,000 rows of two counties;
 * fixtures README) or that the research note names (日班, 輪班, 部份工時) are
 * here: a value this list does not know maps to nothing.
 *   - 中班 is the shift between the day and the night shift, so `evening`.
 *   - 輪班 comes with its rota (輪班二班制, 輪班三班制, 輪班四班二輪制): a value
 *     that starts with 輪班 states rotating shifts, whatever rota follows.
 *   - 部份工時 comes with its hours (部份工時：N時N分至N時N分) or with the
 *     empty template (部份工時：時分至時分); the dataset's pay column spells
 *     the same word 部分工時, so both spellings are read.
 */
export const TW_SHIFT_VALUES: ReadonlyArray<{ value: string; shift: WorkShift; test: (token: string) => boolean }> = [
  { value: '日班', shift: 'day', test: (t) => t === '日班' },
  { value: '中班', shift: 'evening', test: (t) => t === '中班' },
  { value: '夜班', shift: 'night', test: (t) => t === '夜班' },
  { value: '輪班', shift: 'rotating', test: (t) => t.startsWith('輪班') },
  { value: '部份工時', shift: 'part_time', test: (t) => /^部[份分]工時/.test(t) },
];

/** A WKTIME cell split into its values (the source joins them with 、). */
function shiftTokens(raw: string): string[] {
  return raw
    .normalize('NFKC')
    .split(/[、,;]/)
    .map((t) => t.replace(/\s+/g, ''))
    .filter(Boolean);
}

/**
 * WKTIME → the stored shift: `rotating` when a 輪班 value is among the values,
 * else the first value that maps, else null (an empty cell, or only values the
 * list does not know). Pure.
 */
export function twWorkShift(raw: string | null | undefined): WorkShift | null {
  if (typeof raw !== 'string') return null;
  const mapped = shiftTokens(raw).flatMap((token) => {
    const hit = TW_SHIFT_VALUES.find((v) => v.test(token));
    return hit ? [hit.shift] : [];
  });
  return mapped.includes('rotating') ? 'rotating' : (mapped[0] ?? null);
}

/** The part-time template with no hours filled in says nothing beyond "part time". */
const EMPTY_HOURS_RE = /^部[份分]工時(?:[:：]時分至時分)?$/;

/**
 * True when the cell says more than the stored shift does: several values, a
 * rota, the hours of a part-time job, or a value the list does not know. A
 * single 日班 / 中班 / 夜班, the bare part-time value and an empty cell do not.
 */
export function twShiftSaysMore(raw: string | null | undefined): boolean {
  const tokens = typeof raw === 'string' ? shiftTokens(raw) : [];
  if (!tokens.length) return false;
  if (tokens.length > 1) return true;
  const only = tokens[0]!;
  return !(only === '日班' || only === '中班' || only === '夜班' || EMPTY_HOURS_RE.test(only));
}

/** JOB_DETAIL, plus WKTIME as one labelled line when it says more than the stored shift (nothing the source said is lost). */
function descriptionWithShift(detail: string, shiftText: string): string {
  if (!twShiftSaysMore(shiftText)) return detail;
  const line = `${TW_WKTIME_LABEL}：${shiftText}`;
  return detail.trim() ? `${detail.replace(/\s+$/, '')}\n\n${line}` : line;
}

const ID_PART = /^[A-Za-z0-9_-]{1,40}$/;
const EXTERNAL_ID_PREFIX = 'tw:';

/** The vacancy page and the two ids its query string carries; null when the cell is not a usable taiwanjobs.gov.tw link. */
export function twVacancyLink(value: string): { url: string; employerId: string | null; hireId: string | null } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || (host !== 'taiwanjobs.gov.tw' && !host.endsWith('.taiwanjobs.gov.tw'))) return null;
  const param = (name: string): string | null => {
    for (const [k, v] of url.searchParams) if (k.toUpperCase() === name && ID_PART.test(v.trim())) return v.trim();
    return null;
  };
  return { url: url.toString(), employerId: param('EMPLOYER_ID'), hireId: param('HIRE_ID') };
}

export type TwRowResult = { input: ProviderJobInput } | { skip: 'no_external_id' | 'no_apply_url' };

/**
 * One dataset row in the normalizer's input shape. Pure. A row with no usable
 * vacancy link, or without both ids in it, is skipped (never given an
 * invented id). Pay figures come only from numeric NT_L / NT_U; with none,
 * SALARYCD is handed over verbatim as the posting's pay text.
 */
export function twOpenDataRowToInput(row: TwOpenDataRow, now: Date): TwRowResult {
  const link = twVacancyLink(cell(row, 'URL_QUERY'));
  if (!link) return { skip: 'no_apply_url' };
  if (!link.employerId || !link.hireId) return { skip: 'no_external_id' };

  const place = cell(row, 'CITYNAME');
  const district = findTwDistrict(place)?.district ?? null;
  const salaryCd = field(row, 'SALARYCD');
  const period = payPeriod(salaryCd);
  // 論件計酬 (piece work) states amounts per piece, not pay for a period: no figure is taken.
  const min = period ? payBound(field(row, 'NT_L')) : null;
  const max = period ? payBound(field(row, 'NT_U')) : null;
  const hasFigure = min !== null || max !== null;
  const headcount = Number(field(row, 'JOB_PERSON'));
  const shift = cell(row, 'WKTIME');

  const input: ProviderJobInput = {
    externalId: `${EXTERNAL_ID_PREFIX}${link.employerId}:${link.hireId}`,
    sourceBoard: TW_OPEN_DATA_BOARD,
    title: cell(row, 'OCCU_DESC'),
    company: cell(row, 'COMPNAME'),
    description: descriptionWithShift(typeof row.JOB_DETAIL === 'string' ? row.JOB_DETAIL : '', shift),
    // D1: the user applies on the vacancy page of job.taiwanjobs.gov.tw.
    applyUrl: link.url,
    sourceUrl: link.url,
    sourcePublisher: TW_OPEN_DATA_PUBLISHER,
    location: place || null,
    locationCountry: 'TW',
    locationDistrict: district,
    employmentType: cell(row, 'WK_TYPE') || null,
    ...(hasFigure
      ? { salaryMin: min, salaryMax: max, salaryCurrency: 'TWD', salaryPeriod: period }
      : { salaryMin: null, salaryMax: null, salaryText: cell(row, 'SALARYCD') || null }),
    // Pay is what the numeric fields state and nothing else: the normalizer does not look for a
    // figure in JOB_DETAIL (a piece-work row has none on purpose).
    payFromFieldsOnly: true,
    // TRANDATE is the row's update date, not the day the employer posted it: cards say "last verified".
    postedAt: taipeiDayStart(field(row, 'TRANDATE')),
    postedAtEstimated: true,
    fetchedAt: now,
    expiresAt: taipeiDayEnd(field(row, 'STOP_DATE')),
    experienceLevel: experienceBand(field(row, 'EXPERIENCE')),
    educationLevel: educationLabel(field(row, 'EDGRDESC')),
    // The source's own occupation code (通俗職業 小類) → our role; an unmapped code leaves the title to decide.
    taxonomyId: twRoleForJobno(field(row, 'CJOB2_COUNT')),
    headcount: Number.isInteger(headcount) && headcount > 0 ? headcount : null,
    // The source's own field, mapped; never read out of the title or the description (JT-7).
    workShift: twWorkShift(shift),
  };
  return { input };
}

// ── The sweep cursor ────────────────────────────────────────────────────────

export interface TwSweepCounts {
  requests: number;
  rows: number;
  errors: number;
  cappedLeaves: number;
  skippedPositions: number;
  /**
   * Rows of capped counties' own answers that no district request returned:
   * the measured share of each county's first 1,000 rows that the split by
   * district does not reach.
   */
  countyOnly: number;
  /** Rows of capped counties' own answers that no narrower request returned at all, where the county was also walked by 大類. */
  unreached: number;
  /** (county, 大類) answers of a second walk that were still at the cap. */
  cappedCountyMajors: number;
}

/** A closure still to do (or to continue): rows last seen before `before`, read in id order after `afterId`. */
export interface TwSweepClose {
  before: string;
  afterId: string | null;
  /** County codes whose own answer hit the cap in either of the two sweeps: their rows are not closed by absence. */
  partial: string[];
}

/** `RAIngestQuery.params.cursor` of the adapter's standing query (JSON text). */
export interface TwSweepCursor {
  v: 1;
  /** Start of the sweep in progress, or of the last one when `county` is past the end. Null before the first. */
  sweepStartedAt: string | null;
  /** Start of the complete sweep before `lastCompleteSweepStartedAt`. */
  prevSweepStartedAt: string | null;
  /** Start of the latest sweep that read every position under the cap. */
  lastCompleteSweepStartedAt: string | null;
  /** Index into the county list; the list's length when the sweep is finished. */
  county: number;
  /** Index into the county's districts while it is walked by district, else null. */
  zip: number | null;
  /** Index into the 大類 list while a district or the county is walked by 大類, else null. */
  jobno: number | null;
  /** The county is being read a second time, 大類 by 大類, after its districts (`zip` is null, `jobno` is set). */
  second: boolean;
  /**
   * While a capped county is walked: the ids ('<EMPLOYER_ID>:<HIRE_ID>') of
   * the county's own answer that no narrower request has returned yet. Null
   * outside a capped county. At most 1,000 short strings.
   */
  pending: string[] | null;
  /** A leaf was still capped, or a position was given up: this sweep closes nothing. */
  incomplete: boolean;
  /** Consecutive failed requests at the current position. */
  errors: number;
  /** County codes whose own answer hit the cap in this sweep (the county was not read whole by one request). */
  partial: string[];
  /** The same list of the latest complete sweep. */
  lastCompletePartial: string[];
  close: TwSweepClose | null;
  counts: TwSweepCounts;
}

const ZERO_COUNTS: TwSweepCounts = { requests: 0, rows: 0, errors: 0, cappedLeaves: 0, skippedPositions: 0, countyOnly: 0, unreached: 0, cappedCountyMajors: 0 };

export function emptyTwSweepCursor(): TwSweepCursor {
  return {
    v: 1,
    sweepStartedAt: null,
    prevSweepStartedAt: null,
    lastCompleteSweepStartedAt: null,
    county: 0,
    zip: null,
    jobno: null,
    second: false,
    pending: null,
    incomplete: false,
    errors: 0,
    partial: [],
    lastCompletePartial: [],
    close: null,
    counts: { ...ZERO_COUNTS },
  };
}

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const indexOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const codes = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((c): c is string => typeof c === 'string' && /^\d{2}$/.test(c)))] : []);
/** '<EMPLOYER_ID>:<HIRE_ID>': the two parts of a row's externalId. */
const ROW_ID = /^[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}$/;
const rowIds = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === 'string' && ROW_ID.test(id)))].slice(0, TW_OPEN_DATA_ROW_CAP) : []);

/** Reads a stored cursor. Anything that is not one (the bank adapters' cursors, a hand edit, another version) starts a fresh sweep. Never throws. */
export function parseTwSweepCursor(text: string | null | undefined): TwSweepCursor {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return emptyTwSweepCursor();
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyTwSweepCursor();
    raw = parsed as Record<string, unknown>;
  } catch {
    return emptyTwSweepCursor();
  }
  if (raw.v !== 1) return emptyTwSweepCursor();
  const c = (raw.counts && typeof raw.counts === 'object' ? raw.counts : {}) as Record<string, unknown>;
  const close = (raw.close && typeof raw.close === 'object' ? raw.close : null) as Record<string, unknown> | null;
  const closeBefore = close ? isoOrNull(close.before) : null;
  const zip = indexOrNull(raw.zip);
  const jobno = indexOrNull(raw.jobno);
  return {
    v: 1,
    sweepStartedAt: isoOrNull(raw.sweepStartedAt),
    prevSweepStartedAt: isoOrNull(raw.prevSweepStartedAt),
    lastCompleteSweepStartedAt: isoOrNull(raw.lastCompleteSweepStartedAt),
    county: indexOrNull(raw.county) ?? 0,
    zip,
    jobno,
    // A second walk is a county read by 大類: any other position cannot be one.
    second: raw.second === true && zip === null && jobno !== null,
    pending: Array.isArray(raw.pending) ? rowIds(raw.pending) : null,
    incomplete: raw.incomplete === true,
    errors: count(raw.errors),
    partial: codes(raw.partial),
    lastCompletePartial: codes(raw.lastCompletePartial),
    close: closeBefore ? { before: closeBefore, afterId: typeof close!.afterId === 'string' && close!.afterId ? close!.afterId : null, partial: codes(close!.partial) } : null,
    counts: {
      requests: count(c.requests),
      rows: count(c.rows),
      errors: count(c.errors),
      cappedLeaves: count(c.cappedLeaves),
      skippedPositions: count(c.skippedPositions),
      countyOnly: count(c.countyOnly),
      unreached: count(c.unreached),
      cappedCountyMajors: count(c.cappedCountyMajors),
    },
  };
}

export function formatTwSweepCursor(cursor: TwSweepCursor): string {
  return JSON.stringify(cursor);
}

/** The tables the sweep walks (injected by tests; the committed tables otherwise). */
export interface TwSweepTables {
  counties: readonly Pick<TwCounty, 'code' | 'name'>[];
  districtsOf(countyCode: string): readonly Pick<TwDistrict, 'zip3'>[];
  /** The 大類 codes, in order. */
  majors: readonly string[];
}

export const TW_SWEEP_TABLES: TwSweepTables = {
  counties: TW_COUNTIES,
  districtsOf: districtsOfCounty,
  majors: TW_JOBNO_MAJORS.map((m) => m.code),
};

/** True when the sweep the cursor describes has read its last county. */
export function twSweepFinished(cursor: TwSweepCursor, tables: TwSweepTables = TW_SWEEP_TABLES): boolean {
  return cursor.sweepStartedAt !== null && cursor.county >= tables.counties.length;
}

/** The request the cursor stands at; null when the sweep is finished. */
export function twSweepRequest(cursor: TwSweepCursor, tables: TwSweepTables = TW_SWEEP_TABLES): TwOpenDataRequest | null {
  const county = tables.counties[cursor.county];
  if (!county) return null;
  const district = cursor.zip !== null ? tables.districtsOf(county.code)[cursor.zip] : undefined;
  const major = cursor.jobno !== null ? tables.majors[cursor.jobno] : undefined;
  return { city: county.code, zipno: district?.zip3 ?? null, jobno: major ?? null };
}

/** What an answer tells the sweep besides its size, and the one knob the walk has. */
export interface TwSweepStep {
  /** The ids ('<EMPLOYER_ID>:<HIRE_ID>') of the answer's rows. Absent: nothing is measured for this answer. */
  ids?: readonly string[];
  /** `TwOpenDataConfig.countyWalkMin` (default TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT). */
  countyWalkMin?: number;
}

const walkMinOf = (step: TwSweepStep): number => step.countyWalkMin ?? TW_OPEN_DATA_COUNTY_WALK_MIN_DEFAULT;

/**
 * Leaves the county the cursor stands in. A capped county first settles what
 * its walk measured: after the districts, the rows of its own answer that no
 * district request returned (and, when they are `walkMin` or more, the county
 * is read again by 大類 instead of being left); after a walk by 大類, the rows
 * no narrower request returned at all.
 */
function leaveCounty(cursor: TwSweepCursor, tables: TwSweepTables, walkMin: number): TwSweepCursor {
  const next: TwSweepCursor = { ...cursor, county: cursor.county + 1, zip: null, jobno: null, second: false, pending: null, errors: 0 };
  if (cursor.pending === null) return next;
  const left = cursor.pending.length;
  if (cursor.zip !== null) {
    const counts: TwSweepCounts = { ...cursor.counts, countyOnly: cursor.counts.countyOnly + left };
    if (walkMin > 0 && left >= walkMin && tables.majors.length > 0) return { ...cursor, zip: null, jobno: 0, second: true, errors: 0, counts };
    return { ...next, counts };
  }
  if (cursor.jobno !== null) return { ...next, counts: { ...cursor.counts, unreached: cursor.counts.unreached + left } };
  return next;
}

/** Moves past the current node without splitting it (a node under the cap, a leaf, or a position given up). */
function stepOver(cursor: TwSweepCursor, tables: TwSweepTables, walkMin: number): TwSweepCursor {
  const county = tables.counties[cursor.county];
  if (!county) return cursor;
  if (cursor.jobno !== null && cursor.jobno + 1 < tables.majors.length) return { ...cursor, jobno: cursor.jobno + 1, errors: 0 };
  // A district (or its last 大類) is done: the next district; after the last one the county is done.
  if (cursor.zip !== null && cursor.zip + 1 < tables.districtsOf(county.code).length) return { ...cursor, zip: cursor.zip + 1, jobno: null, errors: 0 };
  return leaveCounty(cursor, tables, walkMin);
}

/**
 * The cursor after an answer of `rows` rows at its position. An answer at the
 * cap splits the node: county → its districts (or its 大類 when the district
 * table has none for it), district → its 大類; a capped leaf stays a leaf and
 * marks the sweep incomplete. A capped county remembers the ids of its own
 * answer, and every narrower answer takes its ids off that list (see
 * `leaveCounty`). Pure.
 */
export function advanceTwSweep(cursor: TwSweepCursor, rows: number, tables: TwSweepTables = TW_SWEEP_TABLES, step: TwSweepStep = {}): TwSweepCursor {
  const county = tables.counties[cursor.county];
  if (!county) return cursor;
  const walkMin = walkMinOf(step);
  const counts: TwSweepCounts = { ...cursor.counts, requests: cursor.counts.requests + 1, rows: cursor.counts.rows + rows };
  const atCounty = cursor.zip === null && cursor.jobno === null;
  const got = !atCounty && cursor.pending?.length && step.ids?.length ? new Set(step.ids) : null;
  const base: TwSweepCursor = { ...cursor, errors: 0, counts, pending: got ? cursor.pending!.filter((id) => !got.has(id)) : cursor.pending };
  const capped = rows >= TW_OPEN_DATA_ROW_CAP;
  if (!capped) return stepOver(base, tables, walkMin);
  // A node that is still cut and cannot be split further: its rows are kept, the sweep is not complete.
  const cappedLeaf = (at: TwSweepCursor): TwSweepCursor => stepOver({ ...at, incomplete: true, counts: { ...at.counts, cappedLeaves: at.counts.cappedLeaves + 1 } }, tables, walkMin);
  if (atCounty) {
    // The county was not read whole by its own answer: keep what that answer held, then split it.
    const open: TwSweepCursor = { ...base, pending: rowIds(step.ids ?? []), partial: [...new Set([...base.partial, county.code])] };
    if (tables.districtsOf(county.code).length > 0) return { ...open, zip: 0 };
    return tables.majors.length > 0 ? { ...open, jobno: 0 } : cappedLeaf(open);
  }
  // The second walk is extra coverage: a (county, 大類) answer still at the cap is counted, the sweep stays complete.
  if (base.second) return stepOver({ ...base, counts: { ...counts, cappedCountyMajors: counts.cappedCountyMajors + 1 } }, tables, walkMin);
  if (base.jobno !== null) return cappedLeaf(base);
  // A capped district: by 大類.
  return tables.majors.length > 0 ? { ...base, jobno: 0 } : cappedLeaf(base);
}

/** The cursor after a failed request: the position stays; the third strike gives it up and marks the sweep incomplete. */
export function failTwSweep(cursor: TwSweepCursor, tables: TwSweepTables = TW_SWEEP_TABLES, step: TwSweepStep = {}): TwSweepCursor {
  const counts: TwSweepCounts = { ...cursor.counts, requests: cursor.counts.requests + 1, errors: cursor.counts.errors + 1 };
  const errors = cursor.errors + 1;
  if (errors < TW_OPEN_DATA_MAX_STRIKES) return { ...cursor, errors, counts };
  return stepOver({ ...cursor, incomplete: true, counts: { ...counts, skippedPositions: counts.skippedPositions + 1 } }, tables, walkMinOf(step));
}

/** A new sweep at `now`; what is known about earlier complete sweeps is kept. */
export function startTwSweep(cursor: TwSweepCursor, now: Date): TwSweepCursor {
  return { ...cursor, sweepStartedAt: now.toISOString(), county: 0, zip: null, jobno: null, second: false, pending: null, incomplete: false, errors: 0, partial: [], counts: { ...ZERO_COUNTS } };
}

/**
 * Closes the books of a sweep that has read its last county. A complete sweep
 * becomes the latest complete one and, when an earlier complete sweep exists,
 * schedules the closure of rows neither of the two saw. An incomplete sweep
 * changes nothing and closes nothing.
 */
export function finishTwSweep(cursor: TwSweepCursor): TwSweepCursor {
  if (cursor.incomplete || !cursor.sweepStartedAt) return cursor;
  const earlier = cursor.lastCompleteSweepStartedAt;
  return {
    ...cursor,
    prevSweepStartedAt: earlier,
    lastCompleteSweepStartedAt: cursor.sweepStartedAt,
    lastCompletePartial: [...cursor.partial],
    close: earlier ? { before: earlier, afterId: null, partial: [...new Set([...cursor.partial, ...cursor.lastCompletePartial])] } : null,
  };
}

// ── Closure ─────────────────────────────────────────────────────────────────

/** The rows the closure step reads. */
export interface TwClosureRow {
  id: string;
  externalId: string;
  location: string | null;
}

/** The database surface the adapter needs: one read of open rows of this board. */
export interface TwOpenDataDb {
  rAJob: {
    findMany(args: {
      where: { sourceBoard: string; market: string; visibility: string; archivedAt: null; lastSeenAt: { lt: Date }; id?: { gt: string } };
      select: { id: true; externalId: true; location: true };
      orderBy: { id: 'asc' };
      take: number;
    }): Promise<TwClosureRow[]>;
  };
}

/**
 * Does a row's absence from the two sweeps prove it gone? Only when the
 * county it displays was read whole, by its own answer under the cap, in both
 * (`partial` holds the counties that hit the cap in either). The district a
 * row displays proves nothing: `zipno` does not select on it (file header).
 */
export function twAbsenceProven(location: string | null | undefined, partial: ReadonlySet<string>): boolean {
  const place = findTwDistrict(location);
  return place !== null && !partial.has(place.countyCode);
}

/** The sweep's own counts that are also counters of a fetch (`notes`). */
const COUNT_NOTES: ReadonlyArray<[keyof TwSweepCounts, string]> = [
  ['cappedLeaves', 'tw_capped_leaf'],
  ['skippedPositions', 'tw_skipped_position'],
  ['countyOnly', 'tw_county_only'],
  ['unreached', 'tw_county_unreached'],
  ['cappedCountyMajors', 'tw_capped_county_major'],
];

async function defaultDb(): Promise<TwOpenDataDb> {
  return (await import('../../../lib/prisma.js')).default as unknown as TwOpenDataDb;
}

// ── The adapter ─────────────────────────────────────────────────────────────

export interface TwOpenDataAdapterDeps {
  fetch?: TwFetchLike;
  env?: EnvSource;
  /** Database for the closure read (default: the app Prisma client, loaded lazily). */
  db?: () => Promise<TwOpenDataDb> | TwOpenDataDb;
  /** The pause between two requests (default: a timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Elapsed-time clock for the caller's budget (default Date.now). */
  clock?: () => number;
  tables?: TwSweepTables;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createTwOpenDataAdapter(deps: TwOpenDataAdapterDeps = {}): JobSourceAdapter {
  const env = (): EnvSource => deps.env ?? process.env;
  const tables = deps.tables ?? TW_SWEEP_TABLES;
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? Date.now;
  /** When this adapter's last request ended (on `clock`): the pause is owed across two fetches too. */
  let lastRequestEndedAt: number | null = null;

  /** One closure step: no request to the source, one database read. */
  async function closeStep(cursor: TwSweepCursor): Promise<SourceFetchResult> {
    const close = cursor.close!;
    let rows: TwClosureRow[];
    try {
      const db = await (deps.db ?? defaultDb)();
      rows = await db.rAJob.findMany({
        where: {
          sourceBoard: TW_OPEN_DATA_BOARD,
          market: 'intl',
          visibility: 'public',
          archivedAt: null,
          lastSeenAt: { lt: new Date(close.before) },
          ...(close.afterId ? { id: { gt: close.afterId } } : {}),
        },
        select: { id: true, externalId: true, location: true },
        orderBy: { id: 'asc' },
        take: TW_OPEN_DATA_CLOSE_PAGE,
      });
    } catch (err) {
      // The closure stays scheduled in the stored cursor and is tried again on the next lease.
      return { jobs: [], calls: 0, error: err instanceof Error ? `tw_open_data_closure:${err.message.slice(0, 160)}` : 'tw_open_data_closure_failed' };
    }
    const partial = new Set(close.partial);
    const closed = rows.filter((r) => twAbsenceProven(r.location, partial)).map((r) => r.externalId);
    const more = rows.length >= TW_OPEN_DATA_CLOSE_PAGE;
    const next: TwSweepCursor = { ...cursor, close: more ? { ...close, afterId: rows[rows.length - 1]!.id } : null };
    const kept = rows.length - closed.length;
    return {
      jobs: [],
      calls: 0,
      cursor: formatTwSweepCursor(next),
      exhausted: !more,
      closedExternalIds: closed,
      closeReason: 'source_removed',
      notes: { ...(kept > 0 ? { tw_absence_unproven: kept } : {}) },
    };
  }

  return {
    provider: TW_OPEN_DATA_PROVIDER,
    kind: 'cursor',
    markets: ['intl'],
    costModel: 'free',
    sourceBoards: [TW_OPEN_DATA_BOARD],
    transport: () => 'api',
    disabledReason: () => {
      try {
        const status = twOpenDataStatus(env());
        return status.enabled ? null : status.reason;
      } catch {
        return 'disabled';
      }
    },
    isEnabled: () => {
      try {
        return twOpenDataEnabled(env());
      } catch {
        return false;
      }
    },
    supportsCountry: (country) => typeof country === 'string' && country.trim().toUpperCase() === 'TW',
    // Open data: no metered plan.
    dailyCallLimit: () => null,
    async fetch(query, ctx): Promise<SourceFetchResult> {
      try {
        // The kill switch and the market are checked here too: nothing is ever fetched while off.
        if (!twOpenDataEnabled(env()) || query.market !== 'intl') return { jobs: [], calls: 0, exhausted: true };
        const config = twOpenDataConfig(env());
        let cursor = parseTwSweepCursor(query.params.cursor);

        if (cursor.close) return await closeStep(cursor);

        if (cursor.sweepStartedAt === null) cursor = startTwSweep(cursor, ctx.now);
        else if (twSweepFinished(cursor, tables)) {
          // One sweep a day: nothing is asked of the source until the next start is due.
          if (ctx.now.getTime() - Date.parse(cursor.sweepStartedAt) < config.sweepMs) return { jobs: [], calls: 0, exhausted: true };
          cursor = startTwSweep(cursor, ctx.now);
        }

        const jobs: ProviderJobInput[] = [];
        const notes: Record<string, number> = {};
        const bump = (key: string, by = 1) => {
          if (by > 0) notes[key] = (notes[key] ?? 0) + by;
        };
        /** What a step added to the sweep's own counts, as counters of this fetch. */
        const tally = (before: TwSweepCursor, after: TwSweepCursor) => {
          for (const [key, note] of COUNT_NOTES) bump(note, after.counts[key] - before.counts[key]);
        };
        const step: TwSweepStep = { countyWalkMin: config.countyWalkMin };
        const startedAt = clock();
        let calls = 0;
        let failed = false;
        let cut = false;

        while (calls < config.requestsPerFetch) {
          const request = twSweepRequest(cursor, tables);
          if (!request) break;
          if (ctx.signal?.aborted) {
            cut = true;
            break;
          }
          // The pause holds between any two requests of this adapter: inside a fetch, and between the last
          // request of one fetch and the first of the next (ingest leases a running sweep again at once).
          const wait = calls > 0 ? config.pauseMs : lastRequestEndedAt === null ? 0 : Math.min(config.pauseMs, Math.max(0, config.pauseMs - (clock() - lastRequestEndedAt)));
          // The caller's budget (the ingest tick): a request not started now is the next fetch's first. A fetch's
          // first request runs whatever the budget, unless it would have to wait: then nothing is asked.
          if (ctx.budgetMs !== undefined && (calls > 0 || wait > 0) && clock() - startedAt + wait + REQUEST_RESERVE_MS > ctx.budgetMs) {
            cut = true;
            break;
          }
          if (wait > 0) await sleep(wait);
          const page = await requestTwOpenData(request, { fetch: deps.fetch, env: env(), signal: ctx.signal });
          lastRequestEndedAt = clock();
          calls += 1;
          if (!page.ok) {
            if (page.error === 'aborted') {
              // Our own cut, not the source's failure: no strike.
              cut = true;
              break;
            }
            const before = cursor;
            cursor = failTwSweep(cursor, tables, step);
            bump('tw_request_errors');
            tally(before, cursor);
            logger.warn('JOB_SOURCES', 'tw_open_data request failed', { error: page.error, city: request.city, zipno: request.zipno ?? null, jobno: request.jobno ?? null, strikes: before.errors + 1 });
            failed = true;
            break;
          }
          const ids: string[] = [];
          for (const row of page.rows) {
            const mapped = twOpenDataRowToInput(row, ctx.now);
            if ('skip' in mapped) bump(mapped.skip);
            else {
              jobs.push(mapped.input);
              ids.push(mapped.input.externalId.slice(EXTERNAL_ID_PREFIX.length));
            }
          }
          const before = cursor;
          cursor = advanceTwSweep(cursor, page.rows.length, tables, { ...step, ids });
          tally(before, cursor);
        }

        const finished = twSweepFinished(cursor, tables);
        if (finished) {
          cursor = finishTwSweep(cursor);
          // "Finished" is the split read to its end under the cap, not every open vacancy read: the gap the
          // split leaves is the measured `countyOnly` (and `unreached`) of the same line.
          bump(cursor.incomplete ? 'tw_sweep_incomplete' : 'tw_sweep_finished');
          logger.info('JOB_SOURCES', 'tw_open_data sweep ended', { complete: !cursor.incomplete, startedAt: cursor.sweepStartedAt, cappedCounties: cursor.partial.length, ...cursor.counts });
        }
        return {
          jobs,
          calls,
          cursor: formatTwSweepCursor(cursor),
          notes,
          // More to read now: the sweep is not finished and no request failed; or a closure waits for its own step
          // (after this fetch's rows are written, so a row seen in the sweep's last answer is never closed).
          // A fetch cut before its first request (the budget could not hold the pause and a request) says
          // "more" as well: it is not done for half an hour. The ingest tick sets a source aside for the rest
          // of the tick when it answers "more" without having asked anything (ingest/run.ts), so this cannot
          // spin, and the query stays due for the next tick.
          exhausted: finished ? cursor.close === null : failed,
        };
      } catch (err) {
        return { jobs: [], calls: 0, error: err instanceof Error ? `tw_open_data:${err.message.slice(0, 160)}` : 'tw_open_data_failed' };
      }
    },
  };
}
