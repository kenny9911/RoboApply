// server/src/features/jobs/sources/twGovJobs.ts — 事求人 public-sector
// vacancies (MKT-5D; MARKET_STRATEGY §1.3, §1.5, JT-9; JOB_SOURCES_TW §3.2).
//
// The source. 行政院人事行政總處 publishes the vacancies of government agencies,
// schools and state bodies as data.gov.tw dataset 7229 「行政院人事行政總處事求人
// 機關徵才資料」 under the 政府資料開放授權條款 第1版 (OGDL v1): free, commercial
// use and redisplay allowed WITH attribution. twHooks.ts already holds the
// attribution sentence and the source name for `sourceBoard = 'tw_gov_jobs'`,
// and feed/sourceLine.ts holds such a row out of every surface that cannot
// print the sentence. So this adapter only has to write that board.
//
//   GET https://web3.dgpa.gov.tw/WANT03FRONT/AP/WANTF00003.aspx?GETJOB=Y
//
// One XML file, no key, no parameters, no paging: the file is the complete
// listing. Shape confirmed with one read-only request on 2026-10-12
// (structure, value shapes and counts only; nothing of a vacancy was kept; see
// __fixtures__/twgov/README.md): 6.3 MB, 2,054 records,
// `<ROOT><ANNOUNCE_DATE>…</ANNOUNCE_DATE><ROW>…</ROW>…</ROOT>`, 26 flat elements
// per record, no attributes, no CDATA, entities `&amp; &lt; &gt;`, empty
// elements written `<RANK />`. The dataset record on data.gov.tw
// (`/api/v2/rest/dataset/7229`, read the same day) says: licence 第1版, free,
// updated every 12 hours.
//
// PRIVACY. `VITAE_EMAIL` and `CONTACT_METHOD` hold officials' names, e-mail
// addresses and phone numbers, and the licence does not cover third-party
// privacy. They are NEVER read: the reader takes only the elements of
// `TW_GOV_READ_FIELDS` out of a record, so those two (and every element this
// file does not know) are dropped before a record object exists; nothing here
// logs a record. Contact details also sit INSIDE the free-text fields of some
// records (an "@" in 5 `WORK_ITEM`, 5 `WORK_QUALITY` and 3 `WORK_ADDRESS`
// values, a phone number in about 40, on 2026-10-12), so a sentence of those
// fields that holds an e-mail address, a phone number (with or without its
// area code), an extension, a contact label or a named person to contact is
// left out too (`withoutContactDetails`). Checked on that day's file outside
// the repository with a detector that shares no pattern with the scrub (every
// "@", every run of seven or more digits, every 分機 / 轉 number and every
// contact label with a colon, in the description and the place of all 2,054
// records): 58 sentences were taken out of 53 records and nothing of a contact
// was left; the 33 digit runs that stayed are dates, clock ranges, document,
// selection and position numbers, one amount and parts of page addresses. A
// bare name with no number, label or honorific is not recognised, and titles
// are not scrubbed. The user applies on the vacancy's own page (`VIEW_URL`),
// where the agency states how (D1).
//
// Who may apply (`PERSON_KIND`, 人員區分). The research note confirms three
// kinds as open to the public: 約僱人員, 聘用人員, 其他人員. They are ingested.
// 一般人員 posts are transfers for serving civil servants (商調): skipped and
// counted (`tw_gov_internal_transfer`). The live file holds thirteen more kinds
// the note does not rule on (工友, 教育人員, 駕駛, 主計人員, 人事人員, 技工 …):
// nothing confirms that a member of the public may apply, so they are skipped
// and counted apart (`tw_gov_kind_unconfirmed`), never assumed open (D3).
// TW_GOV_JOBS_INCLUDE_TRANSFERS=true ingests both groups; each such row then
// carries a tag with the PERSON_KIND text as its quote, and every row's
// description opens with its 人員區分 line.
//
// Pay. The file has no pay field. Pay points and amounts appear as text in
// 資格條件 (`WORK_QUALITY`) and are left to the normalizer's pay-text reader:
// this adapter never turns one into a figure.
//
// Dates. `DATE_FROM` / `DATE_TO` are Republic-of-China dates (1151231 =
// 2026-12-31: year + 1911). They are handed over as calendar days, which the
// normalizer reads in Taipei time (`naiveOffsetMinutesFor`): the deadline is
// the end of that day in Taipei. `9991231` (seen on two records) is "no end
// date": no deadline is stored.
//
// Cadence and closure. One request per Taipei calendar day (cursor
// `{ v: 1, day, rows, listed }` in the standing query's `params.cursor`); every
// later lease of that day answers without a request. Because the file is the
// complete listing, a fetch reports it (`listing`, reason 'source_removed') and
// ingest archives the open rows of this board that are not in it, by the rule
// the employer boards use (ingest/upsert.ts `archiveUnlistedJobs`); the upsert
// revives a row the file lists again. What closes rows is the list of ids that
// came out of the file, so a doubtful read closes nothing:
//   - an answer that is not the whole document is an error, and so is a file
//     without a record;
//   - a whole file out of which NO vacancy could be listed (every record
//     skipped: a reworded 人員區分, a moved page address, a changed layout) is
//     the error `nothing_listed`: no cursor is stored, ingest asks again and
//     the admin status shows it;
//   - a file that holds fewer than half of the records of the last read, or
//     out of which fewer than half of the vacancies of the last read could be
//     listed, is ingested but closes nothing that day (the next day's read
//     decides).
//
// Counters of a fetch (`notes`): no_stable_id (no VIEW_URL), no_apply_url
// (VIEW_URL is not a page of dgpa.gov.tw), tw_gov_internal_transfer,
// tw_gov_kind_unconfirmed, tw_gov_contact_text_removed (postings that had a
// sentence with contact details taken out), tw_gov_listing_shrank (a read that
// closed nothing because the records or the listed vacancies fell below half).

import { createHash } from 'node:crypto';
import type { EnvSource } from '../../../platform/brand/index.js';
import { logger } from '../../../services/LoggerService.js';
import { findTwDistrict } from '../geo/index.js';
import type { ProviderJobInput } from '../normalize/index.js';
import type { JobSourceAdapter, SourceFetchResult } from './types.js';
import { sourceUserAgent } from './userAgent.js';

export const TW_GOV_JOBS_PROVIDER = 'tw_gov_jobs';
export const TW_GOV_JOBS_BOARD = 'tw_gov_jobs';
export const TW_GOV_JOBS_PUBLISHER = '事求人';
/** The dataset's download address (data.gov.tw dataset 7229, `resourceDownloadUrl`). */
export const TW_GOV_JOBS_DEFAULT_URL = 'https://web3.dgpa.gov.tw/WANT03FRONT/AP/WANTF00003.aspx?GETJOB=Y';
export const TW_GOV_JOBS_TIMEOUT_MS = 30_000;
/** Largest answer read (the file was 6.3 MB on 2026-10-12). */
export const TW_GOV_JOBS_MAX_BYTES = 20 * 1024 * 1024;
/** A fetch starts its one request only when the caller can still give it this much time (the download and the write of its rows). */
export const TW_GOV_JOBS_MIN_BUDGET_MS = 20_000;
/** A file with fewer than this share of the last read's records, or of its listed vacancies, closes nothing that day. */
export const TW_GOV_JOBS_SHRINK_HOLD = 0.5;
/** Longest address shown as part of the place (longer cells hold directions or instructions, not an address). */
const MAX_ADDRESS_CHARS = 100;
/** Longest record read (the longest of 2026-10-12 was under 10,000 characters); a longer one is not this dataset. */
export const TW_GOV_JOBS_MAX_RECORD_CHARS = 100_000;

/** The dataset, as the licence's Exhibit wants it named (provider, dataset name, licence). */
export const TW_GOV_JOBS_DATASET = {
  id: 7229,
  name: '行政院人事行政總處事求人機關徵才資料',
  provider: '行政院人事行政總處',
  page: 'https://data.gov.tw/dataset/7229',
  licence: '政府資料開放授權條款第1版',
  licenceUrl: 'https://data.gov.tw/license',
} as const;

// ── Switches ────────────────────────────────────────────────────────────────

export type TwGovJobsStatus = { enabled: true } | { enabled: false; reason: 'kill_switch' | 'url_invalid' };

const OFF_WORDS = new Set(['false', '0', 'off', 'no']);
const ON_WORDS = new Set(['true', '1', 'on', 'yes']);
const SITE = 'dgpa.gov.tw';

const onSite = (host: string): boolean => host === SITE || host.endsWith(`.${SITE}`);

/**
 * The address the file is read from: TW_GOV_JOBS_URL, else the dataset's own.
 * https only, no credentials, and only a host of dgpa.gov.tw (an override can
 * move the path or the subdomain, never point the adapter at another site).
 * Null when the configured value is not usable.
 */
export function twGovJobsUrl(env: EnvSource = process.env): string | null {
  const raw = env.TW_GOV_JOBS_URL?.trim() || TW_GOV_JOBS_DEFAULT_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !onSite(url.hostname.toLowerCase())) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** On unless TW_GOV_JOBS_ENABLED is explicitly false / 0 / off / no. */
export function twGovJobsStatus(env: EnvSource = process.env): TwGovJobsStatus {
  const flag = env.TW_GOV_JOBS_ENABLED?.trim().toLowerCase();
  if (flag && OFF_WORDS.has(flag)) return { enabled: false, reason: 'kill_switch' };
  if (!twGovJobsUrl(env)) return { enabled: false, reason: 'url_invalid' };
  return { enabled: true };
}

export function twGovJobsEnabled(env: EnvSource = process.env): boolean {
  return twGovJobsStatus(env).enabled;
}

/** TW_GOV_JOBS_INCLUDE_TRANSFERS=true: posts outside the three public kinds are ingested too, each tagged with its kind. */
export function twGovJobsIncludeTransfers(env: EnvSource = process.env): boolean {
  const flag = env.TW_GOV_JOBS_INCLUDE_TRANSFERS?.trim().toLowerCase();
  return !!flag && ON_WORDS.has(flag);
}

// ── The file ────────────────────────────────────────────────────────────────

/** The elements a record is built from. Nothing else of a `<ROW>` is ever read. */
export const TW_GOV_READ_FIELDS = [
  'ORG_NAME',
  'PERSON_KIND',
  'TITLE',
  'NUMBER_OF',
  'WORK_PLACE_TYPE',
  'DATE_FROM',
  'DATE_TO',
  'WORK_QUALITY',
  'WORK_ITEM',
  'WORK_ADDRESS',
  'VIEW_URL',
] as const;
export type TwGovField = (typeof TW_GOV_READ_FIELDS)[number];

/** Officials' names, e-mail addresses and phone numbers: never read into a record, a log or a fixture. */
export const TW_GOV_NEVER_READ: readonly string[] = ['VITAE_EMAIL', 'CONTACT_METHOD'];

/** One vacancy: the wanted elements, decoded. An element the record lacks is absent; an empty one is ''. */
export type TwGovRow = Partial<Record<TwGovField, string>>;

export type TwGovDocument = { ok: true; rows: TwGovRow[] } | { ok: false; error: string };

const WANTED: ReadonlySet<string> = new Set<string>(TW_GOV_READ_FIELDS.filter((f) => !TW_GOV_NEVER_READ.includes(f)));
const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text of an element: CDATA sections opened, the five XML entities and numeric references decoded. Anything else stays as written. */
function decodeXml(value: string): string {
  if (!value.includes('&') && !value.includes('<![CDATA[')) return value;
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_whole, cdata: string | undefined, entity: string | undefined) => {
    if (cdata !== undefined) return cdata;
    if (!entity) return '';
    if (entity[0] !== '#') return NAMED_ENTITIES[entity] ?? '';
    const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    // A reference that is not a character (out of range, a surrogate half, a control character other than tab and line ends) is dropped.
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) return '';
    return String.fromCodePoint(code);
  });
}

/** A flat element: `<NAME>text</NAME>` or the empty `<NAME />`. Attributes (the live file has none) are passed over. */
const ELEMENT = /<([A-Za-z_][\w.-]*)(?:\s+[^<>]*?)?\s*(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
/** The start of a record: `<ROW>`, with or without attributes; not the empty `<ROW />`. */
const ROW_OPEN = /<ROW(?:\s[^<>]*)?(?<!\/)>/;

/** The wanted elements of one record. The two contact elements never reach the object. */
function readRow(segment: string): TwGovRow {
  const row: TwGovRow = {};
  for (const hit of segment.matchAll(ELEMENT)) {
    const name = hit[1]!.toUpperCase();
    if (!WANTED.has(name)) continue;
    const field = name as TwGovField;
    // A repeated element: the first one stands.
    if (row[field] === undefined) row[field] = decodeXml(hit[2] ?? '');
  }
  return row;
}

/**
 * Reads the dataset file: a small tolerant element reader for flat records
 * (no dependency; element names in any case, whitespace between elements,
 * CDATA and numeric references are all accepted). The document is taken whole
 * or not at all: without its closing `</ROOT>`, or with a record that is not
 * closed, the answer was cut and is an error, because a shorter listing would
 * close live rows. Never throws.
 */
export function parseTwGovXml(text: string): TwGovDocument {
  if (typeof text !== 'string') return { ok: false, error: 'not_xml' };
  const body = text.replace(/^﻿/, '').trim();
  if (!body) return { ok: false, error: 'empty' };
  if (!/<ROOT[\s>]/.test(body.slice(0, 600))) return { ok: false, error: 'not_xml' };
  if (!/<\/ROOT\s*>$/.test(body)) return { ok: false, error: 'truncated' };
  const rows: TwGovRow[] = [];
  const open = new RegExp(ROW_OPEN.source, 'g');
  for (let hit = open.exec(body); hit; hit = open.exec(body)) {
    const start = open.lastIndex;
    const end = body.indexOf('</ROW>', start);
    if (end < 0) return { ok: false, error: 'truncated' };
    // A record of an impossible size is not read at all (and bounds the work of the element reader).
    if (end - start > TW_GOV_JOBS_MAX_RECORD_CHARS) return { ok: false, error: 'malformed' };
    const segment = body.slice(start, end);
    // A record that opens inside another one: a close tag is missing somewhere.
    if (ROW_OPEN.test(segment)) return { ok: false, error: 'malformed' };
    rows.push(readRow(segment));
    open.lastIndex = end + '</ROW>'.length;
  }
  return rows.length > 0 ? { ok: true, rows } : { ok: false, error: 'empty_listing' };
}

export type TwGovFetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' | 'manual' | 'follow' },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}>;

export interface TwGovRequestDeps {
  fetch?: TwGovFetchLike;
  env?: EnvSource;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One GET of the dataset file. Never throws: a failure is `{ ok: false, error }` with a short code. */
export async function requestTwGovJobs(deps: TwGovRequestDeps = {}): Promise<TwGovDocument> {
  const env = deps.env ?? process.env;
  const url = twGovJobsUrl(env);
  if (!url) return { ok: false, error: 'url_invalid' };
  if (deps.signal?.aborted) return { ok: false, error: 'aborted' };
  const doFetch: TwGovFetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TW_GOV_JOBS_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/xml, text/xml', 'User-Agent': sourceUserAgent('intl', env) },
      redirect: 'error',
    });
    // A fetch that ignores `redirect` must still not be followed.
    if (res.status >= 300 && res.status < 400) return { ok: false, error: 'redirect' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const declared = Number(res.headers?.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > TW_GOV_JOBS_MAX_BYTES) return { ok: false, error: 'response_too_large' };
    const text = await res.text();
    if (text.length > TW_GOV_JOBS_MAX_BYTES || Buffer.byteLength(text, 'utf8') > TW_GOV_JOBS_MAX_BYTES) return { ok: false, error: 'response_too_large' };
    return parseTwGovXml(text);
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

// ── Record → normalizer input ───────────────────────────────────────────────

/** 人員區分 values a member of the public may apply for (JOB_SOURCES_TW §3.2). */
export const TW_GOV_PUBLIC_KINDS: readonly string[] = ['約僱人員', '聘用人員', '其他人員'];
/** 人員區分 of a transfer post for serving civil servants (商調). */
export const TW_GOV_TRANSFER_KIND = '一般人員';
/** The tag a row outside the public kinds carries; its quote is the PERSON_KIND text. */
export const TW_GOV_PERSON_KIND_TAG = 'tw_gov_person_kind';

/** A statement the source makes itself, with its own words (the shape of `RAJob.marketTags` entries). */
export interface TwGovMarketTag {
  tag: string;
  evidenceQuote: string;
  evidenceUrl: string | null;
}

/**
 * The normalizer input plus what the source states about who may apply.
 * `ProviderJobInput` has no field for it yet (handoff MKT-5D, Requests): until
 * the normalizer passes `marketTags` on, the same words are the first line of
 * the description.
 */
export type TwGovJobsInput = ProviderJobInput & { marketTags?: TwGovMarketTag[] };

export type TwGovSkip = 'no_stable_id' | 'no_apply_url' | 'tw_gov_internal_transfer' | 'tw_gov_kind_unconfirmed';

export type TwGovRowResult = { input: TwGovJobsInput; contactRemoved: boolean } | { skip: TwGovSkip };

const cell = (row: TwGovRow, name: TwGovField): string => (typeof row[name] === 'string' ? row[name]!.trim() : '');

/**
 * A Republic-of-China date ('1151231': year 115 + 1911) as a calendar day
 * 'YYYY-MM-DD'. Null for anything else, for an impossible date and for a year
 * that is no real date (`9991231`, the file's "no end date").
 */
export function rocDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const hit = /^(\d{2,3})(\d{2})(\d{2})$/.exec(value.normalize('NFKC').trim());
  if (!hit) return null;
  const roc = Number(hit[1]);
  if (roc < 1 || roc >= 200) return null;
  const [y, m, d] = [roc + 1911, Number(hit[2]), Number(hit[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${hit[2]}-${hit[3]}`;
}

/** ',60-嘉義市,61-嘉義縣' → ['嘉義市', '嘉義縣']: the numeric prefix is dropped; 跨縣市 ("several counties") is not a place. */
export function twGovPlaces(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  const places = value
    .split(/[,，]/)
    .map((part) => part.trim().replace(/^\d{1,3}\s*[-－]\s*/, '').trim())
    .filter((part) => part && part !== '跨縣市');
  return [...new Set(places)].slice(0, 30);
}

const ID_VALUE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The vacancy's own page and a stable id for it; null when the cell is not a
 * page of dgpa.gov.tw. The id is the page's `work_id` parameter when it has
 * one, else the first 16 hex characters of sha1(VIEW_URL): stable for as long
 * as the page address is, never invented.
 */
export function twGovVacancyLink(value: string | null | undefined): { url: string; id: string } | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || !onSite(url.hostname.toLowerCase())) return null;
  let id: string | null = null;
  for (const [key, v] of url.searchParams) {
    if (key.toLowerCase() === 'work_id' && ID_VALUE.test(v.trim())) {
      id = v.trim();
      break;
    }
  }
  return { url: url.toString(), id: id ?? createHash('sha1').update(raw).digest('hex').slice(0, 16) };
}

// What counts as a contact detail inside a free-text field. Every rule reads one sentence, folded with
// NFKC (full-width digits, colons and brackets read as their plain forms). The digits in the examples
// are made up. The rules lean toward taking a sentence out: the posting's own page still has it.
const AT_SIGN = /[@＠]/;
/** A Taiwan phone number with its area code, mobile prefix or country code: (02)5550-0100, 02-55500100, 0900-000-000, 0900000000, +886-2-55500100, 886-2-5550-0100. Not a decimal (1.0900…). */
const PHONE = /(?<!\d)(?<!\d\.)(?:\+?886[\s-]?\(?0?\d{1,3}\)?|\(?0\d{1,3}\)?)[\s\-–—]?\d{3,4}[\s\-–—]?\d{3,4}(?!\d)/;
/** A Republic-of-China date written as one number (1151031): never a phone number. */
const ROC_DAY = '1[01]\\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])(?!\\d)';
/** A number announced as one ("電話：5550-0100", "洽詢專線 55500100", "請撥 5550-0100", "分機 550100"), whatever its form. */
const NUMBER_AFTER_WORD = new RegExp(
  `(?:電話|手機|傳真|分機|專線|來電|電洽|請電|請撥|致電|撥打|洽詢|聯絡方式|連絡方式|\\btel\\b|\\bfax\\b|\\bphone\\b)[^。；;\\n]{0,15}?(?<!\\d)(?!${ROC_DAY})\\d(?:[\\s\\-()#轉]*\\d){5,}`,
  'i',
);
/** A number of seven or eight digits in one run after a word of contact ("請洽 55500100"). Not an amount, not a document number. */
const NUMBER_AFTER_CONTACT_VERB = /(?:洽|聯絡|連絡|聯繫)[^。；;\n]{0,15}?(?<!\d)[2-9]\d{6,7}(?!\d)(?!\s*(?:元|圓|號))/;
/**
 * A local number without its area code (5550-0100, 555-0100, 5550-0100-12 with its extension), the
 * usual form inside one city. Not a pair of years (2025-2026), not a range that a unit follows (an
 * amount, a count, a clock time), and not the start or the middle of a longer hyphenated code.
 */
const LOCAL_NUMBER =
  /(?<![\d/:.\-‐–—])(?!(?:19|20)\d\d[\s\-‐–—](?:19|20)\d\d(?!\d))[2-9]\d{2,3}[\s\-‐–—]\d{4}(?![\d/:]|[\-‐–—](?!\d{1,5}(?![\d\-‐–—])))(?!\s*(?:元|圓|點|年|月|日|時|號|歲|[%％]))/;
/** An extension: "分機 1234" wherever it stands, "轉 12" beside a word of contact. */
const EXTENSION = /分機[\s:#]*\d{2,6}(?!\d)|(?:洽|聯絡|連絡|聯繫|承辦|請電|請撥|致電|來電)[^。；;\n]{0,40}轉\s*\d{2,5}(?!\d)(?!\s*(?:年|月|日|職等|名|人|元|點|條|項|款))/;
/** A contact label with its colon ("聯絡人：", "承辦人：", "聯絡方式："): what follows is a person or a way to reach one. */
const CONTACT_LABEL = /(?:聯絡人|連絡人|聯繫人|承辦人|聯絡方式|連絡方式|聯絡窗口|連絡窗口)\s*[:：]/;
/** A person to contact, named ("請洽王小姐", "聯絡人陳先生"). */
const NAMED_CONTACT = /(?:聯絡|連絡|聯繫|洽|承辦)[^。；;\n]{0,40}(?:先生|小姐|女士)/;

const CONTACT_RULES: readonly RegExp[] = [AT_SIGN, PHONE, NUMBER_AFTER_WORD, NUMBER_AFTER_CONTACT_VERB, LOCAL_NUMBER, EXTENSION, CONTACT_LABEL, NAMED_CONTACT];

const holdsContact = (text: string): boolean => {
  const folded = text.normalize('NFKC');
  return CONTACT_RULES.some((rule) => rule.test(folded));
};

/**
 * The text without the sentences that hold an e-mail address, a phone number
 * (with or without its area code), an extension, a contact label or a named
 * person to contact: an official's contact details written into a free-text
 * field. A sentence ends at 。；;！!？? or at the line end; the name beside a
 * number is in the same sentence, so it goes with it. `removed` counts the
 * sentences left out.
 */
export function withoutContactDetails(text: string | null | undefined): { text: string; removed: number } {
  if (typeof text !== 'string' || !text) return { text: '', removed: 0 };
  if (!holdsContact(text)) return { text, removed: 0 };
  let removed = 0;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!holdsContact(line)) {
      lines.push(line);
      continue;
    }
    const kept = line.split(/(?<=[。；;！!？?])/).filter((sentence) => {
      if (!holdsContact(sentence)) return true;
      removed += 1;
      return false;
    });
    if (kept.join('').trim()) lines.push(kept.join(''));
  }
  return { text: lines.join('\n').trim(), removed };
}

/** A postal code written before an address ("100006 臺北市…", "(100)臺北市…"): three digits, or three with two or three more. */
const LEADING_POSTAL_CODE = /^[\s(（[［]*[\d０-９]{3}(?:[-－]?[\d０-９]{2,3})?[)）\]］\s]*/;

/**
 * The address as part of a place: its first line, without contact details,
 * when it is short enough to be one. A postal code before the county is left
 * out (129 of 2,043 addresses on 2026-10-12 start with one): what follows is
 * then read for its county and district. Digits that no county follows stay.
 */
function addressOf(value: string): { address: string | null; removed: number } {
  const scrubbed = withoutContactDetails(value);
  const first = scrubbed.text.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  const bare = first.replace(LEADING_POSTAL_CODE, '');
  const line = bare !== first && findTwDistrict(bare) ? bare : first;
  return { address: line && line.length <= MAX_ADDRESS_CHARS ? line : null, removed: scrubbed.removed };
}

/**
 * One record in the normalizer's input shape. Pure. A record with no page
 * address is skipped (never given an invented id); one whose 人員區分 is not
 * one of the public kinds is skipped unless `includeTransfers`, and then it is
 * tagged with that kind. No pay figure is ever produced here.
 */
export function twGovRowToInput(row: TwGovRow, now: Date, options: { includeTransfers?: boolean } = {}): TwGovRowResult {
  if (!cell(row, 'VIEW_URL')) return { skip: 'no_stable_id' };
  const link = twGovVacancyLink(row.VIEW_URL);
  if (!link) return { skip: 'no_apply_url' };

  const kind = cell(row, 'PERSON_KIND').normalize('NFC');
  const open = TW_GOV_PUBLIC_KINDS.includes(kind);
  if (!open && !options.includeTransfers) return { skip: kind === TW_GOV_TRANSFER_KIND ? 'tw_gov_internal_transfer' : 'tw_gov_kind_unconfirmed' };

  const item = withoutContactDetails(cell(row, 'WORK_ITEM'));
  const quality = withoutContactDetails(cell(row, 'WORK_QUALITY'));
  const { address, removed: addressRemoved } = addressOf(cell(row, 'WORK_ADDRESS'));
  const places = twGovPlaces(row.WORK_PLACE_TYPE);
  // An address that names its county stands alone; any other one follows the first listed place.
  const named = address ? findTwDistrict(address) : null;
  const location = address ? (named || !places[0] ? address : `${places[0]} ${address}`) : (places[0] ?? null);
  const headcount = Number(cell(row, 'NUMBER_OF').normalize('NFKC'));

  // 人員區分, 工作項目 and 資格條件 are the dataset's own field names (data.gov.tw dataset 7229).
  const description = [kind ? `人員區分：${kind}` : '', item.text ? `工作項目：\n${item.text}` : '', quality.text ? `資格條件：\n${quality.text}` : ''].filter(Boolean).join('\n\n');

  const input: TwGovJobsInput = {
    externalId: `dgpa:${link.id}`,
    sourceBoard: TW_GOV_JOBS_BOARD,
    title: cell(row, 'TITLE'),
    company: cell(row, 'ORG_NAME'),
    description,
    // D1: the user applies as the vacancy's own page says.
    applyUrl: link.url,
    sourceUrl: link.url,
    sourcePublisher: TW_GOV_JOBS_PUBLISHER,
    location,
    // The listed counties first: they are what the place parser resolves; the address is what is shown.
    locations: places.length ? places : null,
    locationCountry: 'TW',
    locationDistrict: named?.district ?? null,
    postedAt: rocDate(row.DATE_FROM),
    fetchedAt: now,
    // A calendar day: open through that day in Taipei (the normalizer's rule for this provider).
    expiresAt: rocDate(row.DATE_TO),
    headcount: Number.isInteger(headcount) && headcount > 0 ? headcount : null,
    ...(open || !kind ? {} : { marketTags: [{ tag: TW_GOV_PERSON_KIND_TAG, evidenceQuote: kind, evidenceUrl: link.url }] }),
  };
  return { input, contactRemoved: item.removed + quality.removed + addressRemoved > 0 };
}

// ── The cursor ──────────────────────────────────────────────────────────────

/** `RAIngestQuery.params.cursor` of the adapter's standing query (JSON text). */
export interface TwGovCursor {
  v: 1;
  /** The Taipei calendar day ('YYYY-MM-DD') of the last file read; null before the first. */
  day: string | null;
  /** Records the last file held (0 before the first). */
  rows: number;
  /** Vacancies of that file that went into the listing (0 before the first, and in a cursor written before this count existed). */
  listed: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a stored cursor. Anything that is not one starts fresh. Never throws. */
export function parseTwGovCursor(text: string | null | undefined): TwGovCursor {
  const empty: TwGovCursor = { v: 1, day: null, rows: 0, listed: 0 };
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return empty;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const c = raw as Record<string, unknown>;
    if (c.v !== 1) return empty;
    const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
    return { v: 1, day: typeof c.day === 'string' && DAY_RE.test(c.day) ? c.day : null, rows: count(c.rows), listed: count(c.listed) };
  } catch {
    return empty;
  }
}

export function formatTwGovCursor(cursor: TwGovCursor): string {
  return JSON.stringify(cursor);
}

/** Taipei time is UTC+8 all year. */
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** The Taipei calendar day of an instant, 'YYYY-MM-DD'. */
export function taipeiDay(at: Date): string {
  return new Date(at.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

// ── The adapter ─────────────────────────────────────────────────────────────

export interface TwGovJobsAdapterDeps {
  fetch?: TwGovFetchLike;
  env?: EnvSource;
}

export function createTwGovJobsAdapter(deps: TwGovJobsAdapterDeps = {}): JobSourceAdapter {
  const env = (): EnvSource => deps.env ?? process.env;
  return {
    provider: TW_GOV_JOBS_PROVIDER,
    kind: 'cursor',
    markets: ['intl'],
    costModel: 'free',
    sourceBoards: [TW_GOV_JOBS_BOARD],
    transport: () => 'api',
    disabledReason: () => {
      try {
        const status = twGovJobsStatus(env());
        return status.enabled ? null : status.reason;
      } catch {
        return 'disabled';
      }
    },
    isEnabled: () => {
      try {
        return twGovJobsEnabled(env());
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
        if (!twGovJobsEnabled(env()) || query.market !== 'intl') return { jobs: [], calls: 0, exhausted: true };
        const cursor = parseTwGovCursor(query.params.cursor);
        const today = taipeiDay(ctx.now);
        // One request a day: nothing is asked of the source until the next Taipei day.
        if (cursor.day === today) return { jobs: [], calls: 0, exhausted: true };
        // Not done, and nothing asked: the ingest tick sets the source aside for the rest of the tick
        // (ingest/run.ts) and the query stays due for the next one.
        if (ctx.signal?.aborted || (ctx.budgetMs !== undefined && ctx.budgetMs < TW_GOV_JOBS_MIN_BUDGET_MS)) return { jobs: [], calls: 0, exhausted: false };

        const timeoutMs = ctx.budgetMs === undefined ? TW_GOV_JOBS_TIMEOUT_MS : Math.min(TW_GOV_JOBS_TIMEOUT_MS, Math.max(5_000, ctx.budgetMs - 5_000));
        const doc = await requestTwGovJobs({ fetch: deps.fetch, env: env(), signal: ctx.signal, timeoutMs });
        if (!doc.ok) {
          // Our own cut, not the source's failure.
          if (doc.error === 'aborted') return { jobs: [], calls: 0, exhausted: false };
          logger.warn('JOB_SOURCES', 'tw_gov_jobs request failed', { error: doc.error });
          // Ingest stores no cursor for an error result: the day stays unread and the query is retried later.
          return { jobs: [], calls: doc.error === 'url_invalid' ? 0 : 1, error: `tw_gov_jobs:${doc.error}` };
        }

        const includeTransfers = twGovJobsIncludeTransfers(env());
        const jobs: ProviderJobInput[] = [];
        const listed: string[] = [];
        const notes: Record<string, number> = {};
        const bump = (key: string) => {
          notes[key] = (notes[key] ?? 0) + 1;
        };
        for (const row of doc.rows) {
          const mapped = twGovRowToInput(row, ctx.now, { includeTransfers });
          if ('skip' in mapped) {
            bump(mapped.skip);
            continue;
          }
          jobs.push(mapped.input);
          listed.push(mapped.input.externalId);
          if (mapped.contactRemoved) bump('tw_gov_contact_text_removed');
        }

        // The file is the complete listing, so the rows of this board that are not in it are gone. What
        // closes rows is the list of ids that came out of the file, so the guards count those ids, not
        // only the records.
        const total = doc.rows.length;
        const externalIds = [...new Set(listed)];
        // A whole file out of which no vacancy could be listed (every record skipped: a reworded 人員區分,
        // a moved page address, a changed layout) is a doubtful read, not an empty job market. An error:
        // no cursor is stored, nothing is closed, ingest asks again and the admin status shows it.
        if (externalIds.length === 0) {
          logger.warn('JOB_SOURCES', 'tw_gov_jobs: the file was read whole but no vacancy could be listed; nothing is closed', { records: total, ...notes });
          return { jobs: [], calls: 1, error: 'tw_gov_jobs:nothing_listed', notes };
        }
        // A file that lost more than half of its records, or of the vacancies we list, since the last
        // read closes nothing today; the next day's read decides.
        const shrank = (cursor.rows > 0 && total < cursor.rows * TW_GOV_JOBS_SHRINK_HOLD) || (cursor.listed > 0 && externalIds.length < cursor.listed * TW_GOV_JOBS_SHRINK_HOLD);
        if (shrank) {
          bump('tw_gov_listing_shrank');
          logger.warn('JOB_SOURCES', 'tw_gov_jobs listing shrank: nothing is closed today', { records: total, before: cursor.rows, listed: externalIds.length, listedBefore: cursor.listed });
        }
        logger.info('JOB_SOURCES', 'tw_gov_jobs file read', { records: total, postings: jobs.length, ...notes });
        return {
          jobs,
          calls: 1,
          cursor: formatTwGovCursor({ v: 1, day: today, rows: total, listed: externalIds.length }),
          exhausted: true,
          notes,
          ...(shrank ? {} : { listing: { externalIds, reason: 'source_removed' as const } }),
        };
      } catch (err) {
        return { jobs: [], calls: 0, error: err instanceof Error ? `tw_gov_jobs:${err.message.slice(0, 160)}` : 'tw_gov_jobs_failed' };
      }
    },
  };
}
