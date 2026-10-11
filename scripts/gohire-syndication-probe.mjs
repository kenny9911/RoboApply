#!/usr/bin/env node
// scripts/gohire-syndication-probe.mjs: does the GoHire syndication endpoint
// answer with the agreed page? (requirements JC-2 and JC-3; MARKET_STRATEGY.md
// section 7 items 9 and 10; the contract is written out for the engineer of
// the RoboHire / GoHire backend in
// docs/jobright-clone/market/GOHIRE_SYNDICATION.md).
//
//   node --env-file=.env scripts/gohire-syndication-probe.mjs [--limit 50] [--cursor "<ISO time>|<job id>"]
//
// Run by the owner, never by CI and never by a test against the real host.
//
// What it does: ONE GET of one page of
//   <GOHIRE_SYNDICATION_URL>?limit=<n>[&cursor=…]
// with the service key in the X-API-Key header (GOHIRE_SYNDICATION_KEY, else
// GOHIRE_API_KEY), read from the environment of THIS shell. No redirect is
// followed, the limit is 20 s and 5 MB, and nothing is written anywhere: it
// is a read. The URL must be https (http is accepted for localhost and
// 127.0.0.1 only: a stub or a tunnel on this machine); any other URL is
// refused before a request is made.
//
// What it prints: the endpoint without its query, which variable gave the key
// (never the key), the HTTP status, and COUNTS: items, tombstones, how many
// jobs state a verified employer, a consent to syndicate and a validity end,
// how many times were sent without a zone, whether more pages follow, and the
// page's cursor. When the page does not fit the contract it prints the schema
// problems by FIELD NAME and code ("items[].updatedAt: not_iso (3)").
// It prints no job text, no company name, no id other than the one inside the
// cursor, no part of an error body and no key.
//
// Exit code: 0 when the page fits the contract; 1 when it does not, or the
// endpoint could not be read; 2 on a usage error or a missing setting.
//
// Plain Node (24 or newer), no dependency, no import from the server. The
// field table below is a small copy of the schema in
// server/src/features/jobs/ingest/adapters/syndication.ts, which stays the
// source of truth: server/src/features/jobs/ingest/adapters/syndication.test.ts
// compares the two field by field and case by case, so they cannot drift.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const USAGE = 'usage: node --env-file=.env scripts/gohire-syndication-probe.mjs [--limit 1-200] [--cursor "<ISO time>|<job id>"]';

export const URL_ENV = 'GOHIRE_SYNDICATION_URL';
export const KEY_ENV = 'GOHIRE_SYNDICATION_KEY';
export const FALLBACK_KEY_ENV = 'GOHIRE_API_KEY';
/** The header the key is sent in (server: SYNDICATION_KEY_HEADER). */
export const KEY_HEADER = 'X-API-Key';

export const PROBE_TIMEOUT_MS = 20_000;
export const PROBE_MAX_BYTES = 5 * 1024 * 1024;
export const PROBE_MAX_LIMIT = 200;
export const PROBE_DEFAULT_LIMIT = 50;

/** A time without a zone is read as UTC+8 (server: SYNDICATION_NAIVE_OFFSET_MINUTES). */
const NAIVE_OFFSET_MINUTES = 480;
const MINUTE_MS = 60_000;

// ── The contract (a copy; see the header) ─────────────────────────────────
//
// Kinds: 'id'          a job id: a string with no white space and no '|', at most 200 characters
//        'string'      a string
//        'text'        a string or null; the key must be present
//        'text?'       a string or null; the key may be absent
//        'time'        an ISO 8601 time
//        'time|null'   an ISO 8601 time or null; the key must be present
//        'day|null'    an ISO 8601 time or calendar day, or null; the key must be present
//        'int?'        a whole number or null; the key may be absent
//        'number?'     a number or null; the key may be absent
//        'boolean'     true or false
//        'strings?'    a list of strings or null; the key may be absent
//        'any?'        free-form (only [{ city, country }] is read by the server)
//        'company?'    the company object or null; the key may be absent
//        'cursor|null' "<ISO time>|<job id>" or null; the key must be present
//        'jobs' / 'tombstones'   a list of the objects below

export const SYNDICATION_PROBE_FIELDS = {
  page: { items: 'jobs', tombstones: 'tombstones', nextCursor: 'cursor|null', hasMore: 'boolean' },
  job: {
    id: 'id',
    status: 'string',
    publishedAt: 'time|null',
    updatedAt: 'time',
    title: 'text',
    description: 'text?',
    qualifications: 'text?',
    hardRequirements: 'text?',
    niceToHave: 'text?',
    benefits: 'text?',
    location: 'text?',
    locations: 'any?',
    workType: 'text?',
    employmentType: 'text?',
    experienceLevel: 'text?',
    education: 'text?',
    headcount: 'int?',
    salaryMin: 'number?',
    salaryMax: 'number?',
    salaryCurrency: 'text?',
    salaryPeriod: 'text?',
    salaryText: 'text?',
    companyName: 'text',
    requiredKeywordSet: 'strings?',
    company: 'company?',
    employerVerified: 'boolean',
    syndicationConsentAt: 'time|null',
    validFrom: 'day|null',
    validUntil: 'day|null',
  },
  company: { id: 'text?', name: 'text?', logoUrl: 'text?', website: 'text?', industry: 'text?', size: 'text?', headcount: 'int?', founded: 'int?' },
  tombstone: { id: 'id', updatedAt: 'time', reason: 'text?' },
};

const ID_RE = /^[^\s|]{1,200}$/;
const ISO_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day ("2026-02-30" is none). */
function isCalendarDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** True for a real time of day ("24:00" and a 60th second are refused). */
function isClockTime(hoursMinutes, seconds) {
  const [h, min] = hoursMinutes.split(':').map(Number);
  return h <= 23 && min <= 59 && Number(seconds ?? '0') <= 59;
}

/** An ISO 8601 time → { at, zoned, dayOnly }, else null (server: readIsoTime). */
export function readIsoTime(value, { allowDay = false } = {}) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (allowDay && ISO_DAY_RE.test(s)) {
    const ms = isCalendarDay(s) ? Date.parse(`${s}T00:00:00.000Z`) : Number.NaN;
    return Number.isNaN(ms) ? null : { at: new Date(ms - NAIVE_OFFSET_MINUTES * MINUTE_MS), zoned: false, dayOnly: true };
  }
  const m = ISO_TIME_RE.exec(s);
  if (!m || !isCalendarDay(m[1]) || !isClockTime(m[2], m[3])) return null;
  const fraction = (m[4] ?? '').slice(0, 3).padEnd(3, '0');
  const zone = m[5] ? (m[5] === 'Z' ? 'Z' : m[5].includes(':') ? m[5] : `${m[5].slice(0, 3)}:${m[5].slice(3)}`) : null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}.${fraction}${zone ?? 'Z'}`);
  if (Number.isNaN(ms)) return null;
  return { at: new Date(zone ? ms : ms - NAIVE_OFFSET_MINUTES * MINUTE_MS), zoned: zone !== null, dayOnly: false };
}

/** "<ISO time>|<job id>" → its canonical spelling, else null (server: parseSyndicationCursor). */
export function canonicalCursor(value) {
  if (typeof value !== 'string') return null;
  const at = value.indexOf('|');
  if (at <= 0) return null;
  const time = readIsoTime(value.slice(0, at));
  const id = value.slice(at + 1);
  if (!time || !ID_RE.test(id)) return null;
  return `${time.at.toISOString()}|${id}`;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks a response body against the contract. Problems name a field path
 * (list positions collapsed to "[]") and a code: 'missing', 'wrong_type',
 * 'not_iso', 'bad_id' or 'not_cursor'. Never a value of the payload.
 */
export function validateSyndicationPage(raw) {
  const counts = new Map();
  const add = (field, code) => counts.set(`${field}\u0000${code}`, (counts.get(`${field}\u0000${code}`) ?? 0) + 1);

  const checkValue = (value, kind, field) => {
    switch (kind) {
      case 'id':
        if (typeof value !== 'string') add(field, 'wrong_type');
        else if (!ID_RE.test(value)) add(field, 'bad_id');
        return;
      case 'string':
        if (typeof value !== 'string') add(field, 'wrong_type');
        return;
      case 'text':
      case 'text?':
        if (value !== null && typeof value !== 'string') add(field, 'wrong_type');
        return;
      case 'time':
      case 'time|null':
      case 'day|null':
        if (value === null && kind !== 'time') return;
        if (typeof value !== 'string') add(field, 'wrong_type');
        else if (!readIsoTime(value, { allowDay: kind === 'day|null' })) add(field, 'not_iso');
        return;
      case 'int?':
        if (value !== null && !(typeof value === 'number' && Number.isSafeInteger(value))) add(field, 'wrong_type');
        return;
      case 'number?':
        if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) add(field, 'wrong_type');
        return;
      case 'boolean':
        if (typeof value !== 'boolean') add(field, 'wrong_type');
        return;
      case 'strings?':
        if (value === null) return;
        if (!Array.isArray(value)) add(field, 'wrong_type');
        else for (const entry of value) if (typeof entry !== 'string') add(`${field}[]`, 'wrong_type');
        return;
      case 'any?':
        return;
      case 'company?':
        if (value === null) return;
        if (!isObject(value)) add(field, 'wrong_type');
        else checkObject(value, SYNDICATION_PROBE_FIELDS.company, `${field}.`);
        return;
      case 'cursor|null':
        if (value === null) return;
        if (typeof value !== 'string') add(field, 'wrong_type');
        else if (!canonicalCursor(value)) add(field, 'not_cursor');
        return;
      case 'jobs':
      case 'tombstones': {
        if (!Array.isArray(value)) {
          add(field, 'wrong_type');
          return;
        }
        const table = kind === 'jobs' ? SYNDICATION_PROBE_FIELDS.job : SYNDICATION_PROBE_FIELDS.tombstone;
        for (const entry of value) {
          if (!isObject(entry)) add(`${field}[]`, 'wrong_type');
          else checkObject(entry, table, `${field}[].`);
        }
        return;
      }
      default:
        throw new Error(`unknown kind ${kind}`);
    }
  };

  function checkObject(object, table, prefix) {
    for (const [name, kind] of Object.entries(table)) {
      if (!Object.prototype.hasOwnProperty.call(object, name)) {
        if (!kind.endsWith('?')) add(`${prefix}${name}`, 'missing');
        continue;
      }
      checkValue(object[name], kind, `${prefix}${name}`);
    }
  }

  if (!isObject(raw)) add('(page)', 'wrong_type');
  else checkObject(raw, SYNDICATION_PROBE_FIELDS.page, '');

  const problems = [...counts.entries()].map(([key, count]) => {
    const [field, code] = key.split('\u0000');
    return { field, code, count };
  });
  return { ok: problems.length === 0, problems };
}

const JOB_TIME_FIELDS = ['publishedAt', 'updatedAt', 'syndicationConsentAt', 'validFrom', 'validUntil'];

/**
 * A response body → what the probe may print: counts, the page's cursor and
 * the schema problems. Pure. Nothing else of the payload is in the result: no
 * title, no company, no description, no id but the one inside the cursor.
 * The counts are null when the page does not fit the contract.
 */
export function summarizeSyndicationPage(raw) {
  const { ok, problems } = validateSyndicationPage(raw);
  if (!ok) return { ok: false, problems, counts: null, hasMore: null, nextCursor: null };
  // Times of day sent without a zone; a validity given as a calendar day has none by nature and is not counted.
  const zoneless = (value) => {
    const read = value === null ? null : readIsoTime(value, { allowDay: true });
    return !!read && !read.zoned && !read.dayOnly;
  };
  let timesWithoutZone = 0;
  for (const job of raw.items) for (const field of JOB_TIME_FIELDS) if (zoneless(job[field])) timesWithoutZone += 1;
  for (const stone of raw.tombstones) if (zoneless(stone.updatedAt)) timesWithoutZone += 1;
  return {
    ok: true,
    problems: [],
    counts: {
      items: raw.items.length,
      tombstones: raw.tombstones.length,
      verified: raw.items.filter((job) => job.employerVerified === true).length,
      withConsent: raw.items.filter((job) => job.syndicationConsentAt !== null).length,
      withValidity: raw.items.filter((job) => job.validUntil !== null).length,
      timesWithoutZone,
    },
    hasMore: raw.hasMore,
    // Printed in its canonical spelling, so nothing but a time and an id can come out of this field.
    nextCursor: raw.nextCursor === null ? null : canonicalCursor(raw.nextCursor),
  };
}

/** The lines the probe prints for a summary. `limit` is what was asked for: a page that holds more entries fails. */
export function formatSummary(summary, limit = null) {
  if (!summary.ok) {
    return [
      'Schema problems (by field):',
      ...summary.problems.map((p) => `  ${p.field}: ${p.code} (${p.count})`),
      'FAIL: the page does not fit the contract. See docs/jobright-clone/market/GOHIRE_SYNDICATION.md.',
    ];
  }
  const c = summary.counts;
  return [
    `Items: ${c.items}`,
    `Tombstones: ${c.tombstones}`,
    `Jobs with a verified employer: ${c.verified}`,
    `Jobs with a consent to syndicate: ${c.withConsent}`,
    `Jobs with a validity end: ${c.withValidity}`,
    `Times sent without a zone (read as UTC+8; send an offset): ${c.timesWithoutZone}`,
    `More pages: ${summary.hasMore ? 'yes' : 'no'}`,
    `Cursor of this page: ${summary.nextCursor ?? 'none'}`,
    'Schema: OK',
    pageOverLimit(summary, limit) ? `FAIL: the page holds more than the ${limit} entries that were asked for.` : 'PASS',
  ];
}

/** True when a valid page holds more entries (items and tombstones together) than the limit asked for. */
export function pageOverLimit(summary, limit) {
  return summary.ok && limit !== null && summary.counts.items + summary.counts.tombstones > limit;
}

// ── The request ───────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The endpoint and the key from an environment, or the setting that is missing or unusable. */
export function resolveTarget(env = process.env) {
  const url = (env[URL_ENV] ?? '').trim();
  if (!url) return { problem: `${URL_ENV} is not set.` };
  const own = (env[KEY_ENV] ?? '').trim();
  const fallback = (env[FALLBACK_KEY_ENV] ?? '').trim();
  if (!own && !fallback) return { problem: `Neither ${KEY_ENV} nor ${FALLBACK_KEY_ENV} is set.` };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: `${URL_ENV} is not a URL.` };
  }
  const local = parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !local) return { problem: `${URL_ENV} must be https (http is accepted for localhost and 127.0.0.1 only). No request was made.` };
  // Shown without its query and without any user part: a query may carry a token.
  return { url, shown: `${parsed.origin}${parsed.pathname}`, key: own || fallback, keyFrom: own ? KEY_ENV : FALLBACK_KEY_ENV };
}

export function parseArgs(argv) {
  const out = { limit: PROBE_DEFAULT_LIMIT, cursor: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      const n = Number(argv[(i += 1)]);
      if (!Number.isInteger(n) || n < 1 || n > PROBE_MAX_LIMIT) return { error: `--limit takes a whole number from 1 to ${PROBE_MAX_LIMIT}` };
      out.limit = n;
    } else if (arg === '--cursor') {
      const cursor = canonicalCursor(argv[(i += 1)]);
      if (!cursor) return { error: '--cursor takes "<ISO time>|<job id>"' };
      out.cursor = cursor;
    } else {
      return { error: `unknown argument` };
    }
  }
  return out;
}

/** A short reason for an HTTP status, from the status alone (server: syndicationStatusReason). */
export function statusReason(status) {
  if (status === 401) return 'key_refused';
  if (status === 403) return 'key_lacks_scope';
  if (status === 404) return 'route_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unexpected_status';
}

async function readCapped(res, cap) {
  const declared = Number(res.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) throw new Error('response_too_large');
  const reader = res.body?.getReader?.();
  if (!reader) {
    const body = await res.text();
    if (Buffer.byteLength(body, 'utf8') > cap) throw new Error('response_too_large');
    return body;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error('response_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One GET of one page. Resolves to { status, body } (the parsed JSON, or
 * undefined when the answer was not read) or { failure } with a short code.
 * Never an error text of the runtime: it could quote the URL.
 */
export async function fetchPage({ target, limit, cursor, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, maxBytes = PROBE_MAX_BYTES }) {
  const url = new URL(target.url);
  if (cursor) url.searchParams.set('cursor', cursor);
  url.searchParams.set('limit', String(limit));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), { signal: controller.signal, headers: { Accept: 'application/json', [KEY_HEADER]: target.key }, redirect: 'error' });
    if (res.status >= 300 && res.status < 400) return { status: res.status, failure: 'redirect' };
    if (!res.ok) return { status: res.status, failure: statusReason(res.status) };
    let text;
    try {
      text = await readCapped(res, maxBytes);
    } catch (err) {
      return { status: res.status, failure: err instanceof Error && err.message === 'response_too_large' ? 'response_too_large' : controller.signal.aborted ? 'timeout' : 'network' };
    }
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, failure: 'not_json' };
    }
  } catch (err) {
    const redirected = err?.cause instanceof Error && err.cause.message === 'unexpected redirect';
    return { status: null, failure: controller.signal.aborted ? 'timeout' : redirected ? 'redirect' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the probe. Returns the exit code; prints through `out` / `err` (tests collect the lines). */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  const args = parseArgs(argv);
  if (args.error) {
    err(args.error);
    err(USAGE);
    return 2;
  }
  const target = resolveTarget(deps.env ?? process.env);
  if (target.problem) {
    err(target.problem);
    err(USAGE);
    return 2;
  }
  out('GoHire syndication probe: one GET, nothing is written.');
  out(`Endpoint: ${target.shown}`);
  out(`Key: set (${target.keyFrom})`);
  out(`Asked for: limit ${args.limit}${args.cursor ? `, after ${args.cursor}` : ', from the beginning'}`);
  const answer = await fetchPage({ target, limit: args.limit, cursor: args.cursor, fetchImpl: deps.fetch, timeoutMs: deps.timeoutMs, maxBytes: deps.maxBytes });
  out(`HTTP status: ${answer.status ?? 'none'}`);
  if (answer.failure) {
    out(`FAIL: ${answer.failure}`);
    return 1;
  }
  const summary = summarizeSyndicationPage(answer.body);
  for (const line of formatSummary(summary, args.limit)) out(line);
  return summary.ok && !pageOverLimit(summary, args.limit) ? 0 : 1;
}

/** True when this file is the script Node was started with (a symlinked path counts). */
export function isEntryPoint(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // Never the error text: it could quote the URL.
      console.error('FAIL: the probe stopped on an unexpected error.');
      process.exitCode = 1;
    },
  );
}
