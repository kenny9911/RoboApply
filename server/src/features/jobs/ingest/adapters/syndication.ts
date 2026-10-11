// server/src/features/jobs/ingest/adapters/syndication.ts — the GoHire syndication wire
// contract and its HTTP reader (MARKET_STRATEGY §1.4 tier 1, §8 "GoHire bank transport";
// requirements JC-2 and JC-3; the route itself lives in the RoboHire / GoHire backend and is
// specified for its engineer in docs/jobright-clone/market/GOHIRE_SYNDICATION.md).
//
//   GET <GOHIRE_SYNDICATION_URL>?cursor=<updatedAt ISO>|<id>&limit=<n ≤ 200>      X-API-Key
//   → { items: SyndicatedJob[], tombstones: [{ id, updatedAt, reason? }], nextCursor, hasMore }
//
// This file is the source of truth for that shape. Three rules hold here and nowhere else:
//
//   1. A response is VALIDATED before anything is logged, mapped or stored. A job is the
//      columns of BANK_SYNC_SELECT (bank.ts) plus employerVerified, syndicationConsentAt,
//      validFrom and validUntil. Every other key the server sends (recruiter notes,
//      evaluation rules, AI caches, tenant data) is stripped by the schema, whatever it is
//      called, so it can never reach a row, a log line or an error.
//   2. A page that fails validation is ONE error and writes nothing: never a partial page.
//      A problem names the field and a short code ('items[].updatedAt: not_iso'), never a
//      value of the payload.
//   3. The endpoint is reached over TLS only, with the service key in a header, no redirect
//      followed, a 20 s limit and a 5 MB response cap. An error carries a status code and a
//      short reason; never the URL's query, the key or a body excerpt.
//
// `toBankSyncRow` turns a validated job into the row shape the database transport reads, so
// the mapping (inputFromBankSyncRow) and every gate of bank.ts (open AND published, a named
// employer, no test posting, a real posting page) are the same code for every transport.

import { z } from 'zod';
import type { BankCursorPage, BankFetchLike, BankId, BankPageReader, BankSyncRow } from './bank.js';

// ── Times ─────────────────────────────────────────────────────────────────

/**
 * The offset a time WITHOUT a zone is read in. The contract asks for ISO 8601 with an
 * offset; mainland sources write local time (UTC+8 all year, MARKET_STRATEGY §1.5 "Dates"),
 * so a zone-less time is read as UTC+8 and counted ('bank_time_without_zone'). A validity
 * given as a calendar day has no zone by nature: it is a day in UTC+8 and is not counted.
 */
export const SYNDICATION_NAIVE_OFFSET_MINUTES = 480;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** "2026-10-06T08:00", "2026-10-06T08:00:00.123+08:00", "2026-10-06T00:00:00Z". */
const ISO_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** "2026-10-06": a calendar day (validity fields only). */
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day ("2026-02-30" is none: the runtime's own parser would roll it over into March). */
function isCalendarDay(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** True for a real time of day ("24:00" and a 60th second are refused). */
function isClockTime(hoursMinutes: string, seconds: string | undefined): boolean {
  const [h, min] = hoursMinutes.split(':').map(Number) as [number, number];
  return h <= 23 && min <= 59 && Number(seconds ?? '0') <= 59;
}

export interface IsoReading {
  at: Date;
  /** False when the string names no zone (read as UTC+8). */
  zoned: boolean;
  /** True for a calendar day without a time. */
  dayOnly: boolean;
}

/**
 * An ISO 8601 time → its instant, or null when the string is not ISO 8601 (so "yesterday",
 * "10/06/2026" and a bare number are refused, where `new Date()` would guess). A value
 * without a zone is a wall-clock time in UTC+8; a calendar day (accepted only with
 * `allowDay`) is the start of that day in UTC+8.
 */
export function readIsoTime(value: unknown, options: { allowDay?: boolean } = {}): IsoReading | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (options.allowDay && ISO_DAY_RE.test(s)) {
    const ms = isCalendarDay(s) ? Date.parse(`${s}T00:00:00.000Z`) : Number.NaN;
    return Number.isNaN(ms) ? null : { at: new Date(ms - SYNDICATION_NAIVE_OFFSET_MINUTES * MINUTE_MS), zoned: false, dayOnly: true };
  }
  const m = ISO_TIME_RE.exec(s);
  if (!m || !isCalendarDay(m[1]!) || !isClockTime(m[2]!, m[3])) return null;
  const fraction = (m[4] ?? '').slice(0, 3).padEnd(3, '0');
  const zone = m[5] ? (m[5] === 'Z' ? 'Z' : m[5].includes(':') ? m[5] : `${m[5].slice(0, 3)}:${m[5].slice(3)}`) : null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}.${fraction}${zone ?? 'Z'}`);
  if (Number.isNaN(ms)) return null;
  return { at: new Date(zone ? ms : ms - SYNDICATION_NAIVE_OFFSET_MINUTES * MINUTE_MS), zoned: zone !== null, dayOnly: false };
}

/** "<updatedAt ISO>|<id>": the position of the last entry of a page. */
export function parseSyndicationCursor(value: unknown): { updatedAt: Date; id: string } | null {
  if (typeof value !== 'string') return null;
  const at = value.indexOf('|');
  if (at <= 0) return null;
  const time = readIsoTime(value.slice(0, at));
  const id = value.slice(at + 1);
  if (!time || !ID_RE.test(id)) return null;
  return { updatedAt: time.at, id };
}

export function formatSyndicationCursor(position: { updatedAt: Date; id: string }): string {
  return `${position.updatedAt.toISOString()}|${position.id}`;
}

// ── The schema ────────────────────────────────────────────────────────────

/** A job id: no white space and no '|' (the cursor's separator), at most 200 characters. */
const ID_RE = /^[^\s|]{1,200}$/;

const id = z.string().refine((v) => ID_RE.test(v), { message: 'bad_id' });
const time = z.string().refine((v) => readIsoTime(v) !== null, { message: 'not_iso' });
const dayOrTime = z.string().refine((v) => readIsoTime(v, { allowDay: true }) !== null, { message: 'not_iso' });
/** A descriptive column: absent or null reads as null. */
const text = z
  .string()
  .nullish()
  .transform((v) => v ?? null);
const numberOrNull = z
  .number()
  .nullish()
  .transform((v) => v ?? null);
const intOrNull = z
  .number()
  .int()
  .nullish()
  .transform((v) => v ?? null);

/**
 * `locations` is free-form JSON in the bank. Only `[{ city, country }]` is read: every
 * other key and every entry that is not an object is dropped here (never an error, never
 * passed on).
 */
function pickLocations(v: unknown): Array<{ city: string | null; country: string | null }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ city: string | null; country: string | null }> = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const l = entry as Record<string, unknown>;
    out.push({ city: typeof l.city === 'string' ? l.city : null, country: typeof l.country === 'string' ? l.country : null });
  }
  return out.length ? out : null;
}

/** The company relation of BANK_SYNC_SELECT, and nothing else of the company record. */
export const SyndicatedCompanySchema = z.object({
  id: text,
  name: text,
  logoUrl: text,
  website: text,
  industry: text,
  size: text,
  headcount: intOrNull,
  founded: intOrNull,
});

/**
 * One job as the endpoint sends it. The ten keys that decide whether a row is listed and
 * what it may claim (id, status, publishedAt, updatedAt, title, companyName,
 * employerVerified, syndicationConsentAt, validFrom, validUntil) MUST be present; a page
 * without one is rejected whole. The descriptive columns may be absent (read as null).
 */
export const SyndicatedJobSchema = z.object({
  id,
  status: z.string(),
  publishedAt: time.nullable(),
  updatedAt: time,
  title: z.string().nullable(),
  description: text,
  qualifications: text,
  hardRequirements: text,
  niceToHave: text,
  benefits: text,
  location: text,
  locations: z.unknown().optional().transform(pickLocations),
  workType: text,
  employmentType: text,
  experienceLevel: text,
  education: text,
  headcount: intOrNull,
  salaryMin: numberOrNull,
  salaryMax: numberOrNull,
  salaryCurrency: text,
  salaryPeriod: text,
  salaryText: text,
  companyName: z.string().nullable(),
  requiredKeywordSet: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? null),
  company: SyndicatedCompanySchema.nullish().transform((v) => v ?? null),
  /** The bank's verified-employer record (re-verified at least every six months). Only `true` lets a row carry 企业直招. */
  employerVerified: z.boolean(),
  /** When the employer's consent to public syndication was recorded; null = none on record (signed-in users only). */
  syndicationConsentAt: time.nullable(),
  /** The posting's validity period. A calendar day is read in UTC+8. */
  validFrom: dayOrTime.nullable(),
  validUntil: dayOrTime.nullable(),
});

/** A job that left the listing since the cursor: closed, unpublished, re-drafted, expired or consent withdrawn. */
export const SyndicationTombstoneSchema = z.object({
  id,
  updatedAt: time,
  reason: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export const SyndicationPageSchema = z.object({
  items: z.array(SyndicatedJobSchema),
  tombstones: z.array(SyndicationTombstoneSchema),
  /** The position of the last entry of this page; null only for an empty page. */
  nextCursor: z
    .string()
    .refine((v) => parseSyndicationCursor(v) !== null, { message: 'not_cursor' })
    .nullable(),
  hasMore: z.boolean(),
});

export type SyndicatedCompany = z.infer<typeof SyndicatedCompanySchema>;
export type SyndicatedJob = z.infer<typeof SyndicatedJobSchema>;
export type SyndicationTombstone = z.infer<typeof SyndicationTombstoneSchema>;
export type SyndicationPage = z.infer<typeof SyndicationPageSchema>;

/** The field names of the contract, in schema order (the document and the probe script are checked against them). */
export const SYNDICATION_FIELDS = {
  job: Object.keys(SyndicatedJobSchema.shape),
  company: Object.keys(SyndicatedCompanySchema.shape),
  tombstone: Object.keys(SyndicationTombstoneSchema.shape),
  page: Object.keys(SyndicationPageSchema.shape),
} as const;

/** The four fields the endpoint adds to the BANK_SYNC_SELECT columns. */
export const SYNDICATION_EXTRA_JOB_FIELDS = ['employerVerified', 'syndicationConsentAt', 'validFrom', 'validUntil'] as const;

// ── Validation ────────────────────────────────────────────────────────────

/** One kind of problem with a page: where (a field path, array positions collapsed), what, and how often. */
export interface SyndicationProblem {
  field: string;
  /** 'missing' | 'wrong_type' | 'not_iso' | 'bad_id' | 'not_cursor' */
  code: string;
  count: number;
}

export type SyndicationParseResult = { ok: true; page: SyndicationPage; timesWithoutZone: number } | { ok: false; problems: SyndicationProblem[] };

/** The codes our own refinements produce; every other schema issue is 'missing' or 'wrong_type'. */
const REFINEMENT_CODES = new Set(['not_iso', 'bad_id', 'not_cursor']);

/** True when the payload holds a value (null included) at the path; false when a key on the way is absent. */
function existsAt(raw: unknown, path: ReadonlyArray<PropertyKey>): boolean {
  let at: unknown = raw;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(at, key)) return false;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return true;
}

function fieldOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(page)';
  let out = '';
  for (const key of path) out += typeof key === 'number' ? '[]' : out ? `.${String(key)}` : String(key);
  return out;
}

const TIME_FIELDS = ['publishedAt', 'updatedAt', 'syndicationConsentAt', 'validFrom', 'validUntil'] as const;

/** Times of day sent without a zone (a calendar day is not one). */
function countTimesWithoutZone(page: SyndicationPage): number {
  const zoneless = (value: string | null): boolean => {
    const read = value === null ? null : readIsoTime(value, { allowDay: true });
    return !!read && !read.zoned && !read.dayOnly;
  };
  let n = 0;
  for (const job of page.items) for (const field of TIME_FIELDS) if (zoneless(job[field])) n += 1;
  for (const stone of page.tombstones) if (zoneless(stone.updatedAt)) n += 1;
  return n;
}

/**
 * Validates a response body. On success the page holds the contract's fields only (every
 * unknown key is gone). On failure the problems name fields and codes: the schema's own
 * key names, never a key or a value of the payload.
 */
export function parseSyndicationPage(raw: unknown): SyndicationParseResult {
  const parsed = SyndicationPageSchema.safeParse(raw);
  if (parsed.success) return { ok: true, page: parsed.data, timesWithoutZone: countTimesWithoutZone(parsed.data) };
  const byKey = new Map<string, SyndicationProblem>();
  for (const issue of parsed.error.issues) {
    const field = fieldOf(issue.path);
    const code = !existsAt(raw, issue.path) ? 'missing' : issue.code === 'custom' && REFINEMENT_CODES.has(issue.message) ? issue.message : 'wrong_type';
    const key = `${field}\u0000${code}`;
    const seen = byKey.get(key);
    if (seen) seen.count += 1;
    else byKey.set(key, { field, code, count: 1 });
  }
  return { ok: false, problems: [...byKey.values()] };
}

/** "items[].updatedAt: not_iso x3; nextCursor: missing" (at most `max` problems, then a count). */
export function formatSyndicationProblems(problems: readonly SyndicationProblem[], max = 4): string {
  const shown = problems.slice(0, max).map((p) => `${p.field}: ${p.code}${p.count > 1 ? ` x${p.count}` : ''}`);
  if (problems.length > max) shown.push(`+${problems.length - max} more`);
  return shown.join('; ');
}

// ── Row mapping ───────────────────────────────────────────────────────────

/** The instant a stated validity ends: a calendar day runs through its last millisecond (in UTC+8). */
function validityEnd(value: string | null): Date | null {
  const read = readIsoTime(value, { allowDay: true });
  if (!read) return null;
  return read.dayOnly ? new Date(read.at.getTime() + DAY_MS - 1) : read.at;
}

/**
 * A validated job → the row shape of the database transport, so the one mapping
 * (bank.ts `inputFromBankSyncRow`) and the one set of gates (`classifyBankRow`) serve every
 * transport. Times become instants here; nothing else is changed or inferred.
 */
export function toBankSyncRow(job: SyndicatedJob): BankSyncRow {
  return {
    id: job.id,
    status: job.status,
    publishedAt: job.publishedAt === null ? null : (readIsoTime(job.publishedAt)?.at ?? null),
    // The schema guarantees an ISO time; the epoch is unreachable and only keeps the type total.
    updatedAt: readIsoTime(job.updatedAt)?.at ?? new Date(0),
    title: job.title,
    description: job.description,
    qualifications: job.qualifications,
    hardRequirements: job.hardRequirements,
    niceToHave: job.niceToHave,
    benefits: job.benefits,
    location: job.location,
    locations: job.locations,
    workType: job.workType,
    employmentType: job.employmentType,
    experienceLevel: job.experienceLevel,
    education: job.education,
    headcount: job.headcount,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryCurrency: job.salaryCurrency,
    salaryPeriod: job.salaryPeriod,
    salaryText: job.salaryText,
    companyName: job.companyName,
    requiredKeywordSet: job.requiredKeywordSet,
    company: job.company ? { ...job.company } : null,
    employerVerified: job.employerVerified,
    syndicationConsentAt: job.syndicationConsentAt === null ? null : (readIsoTime(job.syndicationConsentAt)?.at ?? null),
    validFrom: readIsoTime(job.validFrom, { allowDay: true })?.at ?? null,
    validUntil: validityEnd(job.validUntil),
  };
}

// ── The HTTP reader ───────────────────────────────────────────────────────

/** The most entries (items + tombstones) the endpoint returns in one page; `limit` is never asked above it. */
export const SYNDICATION_MAX_LIMIT = 200;
/** Per-request limit, body included. */
export const SYNDICATION_TIMEOUT_MS = 20_000;
/** A response larger than this is refused unread (a 200-entry page of full postings is well under 2 MB). */
export const SYNDICATION_MAX_BYTES = 5 * 1024 * 1024;
/** The header the service key is sent in: the same one this repository's GoHire client uses (GoHireResumeParseService). */
export const SYNDICATION_KEY_HEADER = 'X-API-Key';

/** Hosts a plain-http URL is accepted for: a test stub or a developer's tunnel on the same machine. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface SyndicationConfig {
  /** `GOHIRE_SYNDICATION_URL`. */
  url: string;
  /** `GOHIRE_SYNDICATION_KEY`, else `GOHIRE_API_KEY`. Never logged. */
  key: string;
}

/**
 * Why a syndication URL may not be called, or null when it may: it must be https. Plain
 * http is accepted only for this machine (localhost, 127.0.0.1). Checked before any request.
 */
export function syndicationUrlProblem(url: string): 'syndication_url_not_https' | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return null;
    if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.toLowerCase())) return null;
    return 'syndication_url_not_https';
  } catch {
    return 'syndication_url_not_https';
  }
}

/**
 * A failed read. The message is a short code ('http_401 key_refused', 'response_too_large',
 * 'invalid_page (items[].updatedAt: not_iso)', 'cursor_regressed'): never the URL, the key
 * or any part of a response body.
 */
export class SyndicationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'SyndicationError';
  }
}

/** A short reason for an HTTP status, from the status alone (the body is never read for it). */
export function syndicationStatusReason(status: number): string {
  if (status === 401) return 'key_refused';
  if (status === 403) return 'key_lacks_scope';
  if (status === 404) return 'route_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unexpected_status';
}

export interface SyndicationHttpDeps {
  fetch?: BankFetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** The body as text, read at most to the cap: a declared or a streamed size over it is refused. */
async function readCapped(res: Awaited<ReturnType<BankFetchLike>>, cap: number): Promise<string> {
  const declared = Number(res.headers?.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) throw new SyndicationError('response_too_large');
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const body = await res.text();
    if (Buffer.byteLength(body, 'utf8') > cap) throw new SyndicationError('response_too_large');
    return body;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new SyndicationError('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** True for the failure Node's fetch reports when `redirect: 'error'` meets a redirect. */
function isRedirectFailure(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof Error && cause.message === 'unexpected redirect';
}

/**
 * One request to the endpoint, validated. Throws SyndicationError. The cursor sent is the
 * position only (`<updatedAt ISO>|<id>`); with none the endpoint answers from the beginning.
 */
export async function fetchSyndicationPage(
  config: SyndicationConfig,
  cursor: { updatedAt: Date; id: string } | null,
  limit: number,
  deps: SyndicationHttpDeps = {},
): Promise<{ page: SyndicationPage; timesWithoutZone: number }> {
  const problem = syndicationUrlProblem(config.url);
  if (problem) throw new SyndicationError(problem);
  if (deps.signal?.aborted) throw new SyndicationError('aborted');
  const url = new URL(config.url);
  if (cursor) url.searchParams.set('cursor', formatSyndicationCursor(cursor));
  url.searchParams.set('limit', String(limit));

  const doFetch: BankFetchLike = deps.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const controller = new AbortController();
  // The limit covers the body too: the timer runs until the last byte is read.
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SYNDICATION_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  let body: string;
  try {
    const res = await doFetch(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json', [SYNDICATION_KEY_HEADER]: config.key }, redirect: 'error' });
    if (res.status >= 300 && res.status < 400) throw new SyndicationError('redirect');
    if (!res.ok) throw new SyndicationError(`http_${res.status} ${syndicationStatusReason(res.status)}`);
    body = await readCapped(res, deps.maxBytes ?? SYNDICATION_MAX_BYTES);
  } catch (err) {
    if (err instanceof SyndicationError) throw err;
    // Never the underlying message: an error text can quote the URL or a body.
    throw new SyndicationError(controller.signal.aborted ? (deps.signal?.aborted ? 'aborted' : 'timeout') : isRedirectFailure(err) ? 'redirect' : 'network');
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new SyndicationError('not_json');
  }
  const parsed = parseSyndicationPage(json);
  if (!parsed.ok) throw new SyndicationError(`invalid_page (${formatSyndicationProblems(parsed.problems)})`);
  if (parsed.page.items.length + parsed.page.tombstones.length > limit) throw new SyndicationError('page_over_limit');
  return { page: parsed.page, timesWithoutZone: parsed.timesWithoutZone };
}

/** Order of two positions: by time, then by id as plain code units (the contract's `COLLATE "C"`). Negative: `a` sorts first. */
function comparePositions(a: { updatedAt: Date; id: string }, b: { updatedAt: Date; id: string }): number {
  const byTime = a.updatedAt.getTime() - b.updatedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A validated page → what the cursor sync needs. An id is one entry per page: when the
 * endpoint sends it twice, the later `updatedAt` decides and a tie closes the job.
 * Throws 'cursor_regressed' when the page's position sorts before the cursor that was sent,
 * and 'cursor_stalled' when it has not moved although the endpoint says there is more
 * (the next request would be this one again).
 */
export function toCursorPage(page: SyndicationPage, sent: { updatedAt: Date; id: string } | null, timesWithoutZone = 0): BankCursorPage {
  const closedAt = new Map<string, number>();
  for (const stone of page.tombstones) {
    const at = readIsoTime(stone.updatedAt)?.at.getTime() ?? 0;
    closedAt.set(stone.id, Math.max(at, closedAt.get(stone.id) ?? Number.NEGATIVE_INFINITY));
  }
  const rows: BankSyncRow[] = [];
  for (const job of page.items) {
    const row = toBankSyncRow(job);
    const closed = closedAt.get(row.id);
    if (closed !== undefined) {
      if (closed >= row.updatedAt.getTime()) continue; // the tombstone is the later (or equal) word
      closedAt.delete(row.id); // the job was published again after it closed
    }
    rows.push(row);
  }

  let next = parseSyndicationCursor(page.nextCursor);
  if (!next) {
    // No position stated: the last entry read is the position (an empty page keeps the one sent).
    const entries = [...page.items, ...page.tombstones].map((entry) => ({ updatedAt: readIsoTime(entry.updatedAt)?.at ?? new Date(0), id: entry.id }));
    for (const entry of entries) if (!next || comparePositions(entry, next) > 0) next = entry;
  }
  if (sent && next) {
    const moved = comparePositions(next, sent);
    if (moved < 0) throw new SyndicationError('cursor_regressed');
    if (moved === 0 && page.hasMore) throw new SyndicationError('cursor_stalled');
  }
  if (!next && page.hasMore) throw new SyndicationError('cursor_stalled');

  const notes: Record<string, number> = {};
  if (timesWithoutZone > 0) notes.bank_time_without_zone = timesWithoutZone;
  return { rows, closedIds: [...closedAt.keys()], next: next ?? sent, more: page.hasMore, notes };
}

/**
 * The syndication endpoint behind the BankPageReader seam of bank.ts. One request per
 * page; the page is validated before a single row leaves this function.
 */
export function createSyndicationReader(config: SyndicationConfig, deps: SyndicationHttpDeps = {}): BankPageReader {
  return async (_bank: BankId, cursor, take) => {
    const limit = Math.max(1, Math.min(take, SYNDICATION_MAX_LIMIT));
    const { page, timesWithoutZone } = await fetchSyndicationPage(config, cursor, limit, deps);
    return toCursorPage(page, cursor, timesWithoutZone);
  };
}
