#!/usr/bin/env node
// scripts/board-seeds/validate.mjs: does an employer's public job board answer,
// and is it that employer's? (MARKET_STRATEGY.md M-1 and section 1.2 "Company
// list for tier 0"; requirements JI-3, JC-4, JT-5; ruling D3.)
//
//   node scripts/board-seeds/validate.mjs --candidates <file.jsonl> --date YYYY-MM-DD --out <report.json>
//
// A candidate is a GUESS: "this employer hosts its careers on this job-board
// system under this board id". This script turns a guess into a fact, or into
// a reason why not, by asking the board itself. Nothing but the answer of the
// live board ever puts an employer into a seed file (./build-seeds.mjs).
//
// What it asks. ONE list-only read per candidate, on the documented public
// endpoint the server's connector already uses for that system
// (server/src/features/jobs/sources/atsPublic/connectors.ts):
//
//   greenhouse       GET boards-api.greenhouse.io/v1/boards/{id}/jobs
//   lever            GET api.lever.co/v0/postings/{id}?mode=json&skip&limit
//   lever_eu         the same on api.eu.lever.co (reported only: the server has
//                    no connector for the EU host yet, so it is never seeded)
//   ashby            GET api.ashbyhq.com/posting-api/job-board/{id}
//   smartrecruiters  GET api.smartrecruiters.com/v1/companies/{id}/postings
//
// No other host is ever asked (a URL outside these five is refused before it
// is sent), none of these needs a key, and redirects are not followed. A paged
// listing (Lever, SmartRecruiters) is read page by page, at most --pages pages
// per candidate; `--pages 1` makes it exactly one request per candidate. A
// SmartRecruiters listing states its length on its first page: one that is
// longer than the page limit is not paged at all (its count is the board's own
// total, its countries are those of the first page, and it is marked
// incomplete), so no request is spent on a listing that cannot be finished.
//
// How politely. At most 2 requests in flight per host; at least 300 ms between
// one request to a host and the next one to it (counted from when a request
// starts and from when one ends); one retry after a network error; a 404 is
// never asked again; after a 429 the host is left alone for the rest of the
// run; and never more than --max requests per run (default 800). Every request
// carries the identifying User-Agent the server's board sync sends
// (`RoboApplyJobs/1.0 (+<contact>)`, contact from JOB_SOURCES_CONTACT, else
// the site): we never pose as a browser.
//
// When a candidate is VALID. The board answers 200 with at least one posting,
// AND its name is right:
//   - where the answer states the company (Greenhouse `company_name`,
//     SmartRecruiters `company.name`): that name equals the candidate's
//     employer, or one of its `aliases`, once case, punctuation, accents and
//     legal forms (Inc, Ltd, GmbH, …) are set aside;
//   - where it states none (Lever, Ashby): the board id equals the employer's
//     name set the same way (`ramp` is Ramp). A board id that does not spell
//     the name can be listed in `aliases`, but that is a claim no answer of
//     the board confirms, so the employer's name is taken only with
//     `aliasSource`: a document of this repository that confirms whose board
//     it is (`board_id_alias`; the source goes into the report and into the
//     seed's note). Without one the board is still a live board with
//     postings, and is reported as `board_id_only`: the seed then carries the
//     board id as its name, the placeholder the server already knows, and
//     never the guessed employer.
//
// What it keeps. A report (--out): per candidate valid or the reason not; for
// a board that answered, the company name as the answer stated it, how many
// postings it listed, and how many of them per ISO country, taken from the
// LOCATION FIELDS ONLY (./places.mjs). No posting title and no posting text is
// read into a variable that outlives the request, written to disk or printed.
// The date in the report is the --date argument; the clock is used only to
// space the requests.
//
// Running it again with the same --out asks only the candidates that have no
// final answer yet (not reached before the request cap, or a failure in
// passing), so a long list is worked through in runs of --max requests.
// `--redo-incomplete` with a larger --pages reads long listings to their end;
// `--redo <keys>` asks named candidates again. `--rejudge` asks nothing: it
// applies the names of the candidates file, as it is now, to the answers the
// report already holds (a person added an alias after reading what a board
// stated; see README.md for when that is honest and when it is not).
//
// `postings` is the number of rows a board listed (for a listing cut short:
// the board's own total); `read` is the number of distinct postings read. A
// listing that changes while it is paged can repeat a row, so the two can
// differ by one or two on a long board.
//
// Exit code: 0 every candidate has a final answer; 3 some are still open (run
// it again); 2 a usage error or an unreadable input.
//
// Plain Node (24 or newer), no dependency, no import from the server.
// scripts/board-seeds/validate.test.ts runs it against a mocked fetch.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { countryFromField, countryOfLocation, countryOfStatedLocation, gazetteerInfo } from './places.mjs';

export const USAGE = `usage: node scripts/board-seeds/validate.mjs --candidates <file.jsonl> --date YYYY-MM-DD --out <report.json> [options]

Reads employer-board candidates and asks each board's documented public API
once, read-only. Writes a report of counts; stores no posting title or text.

inputs
  --candidates <file>   JSON lines, one candidate per line:
                          { "ats": "greenhouse" | "lever" | "lever_eu" | "ashby" | "smartrecruiters",
                            "token": "<board id>", "employer": "<company name>",
                            "aliases": ["<another spelling of the name, or of the board id>"],   optional
                            "aliasSource": "docs/<file>.md <section>",   optional, lever and ashby only: the document
                                           that confirms a board id listed in aliases belongs to this employer
                                           (without it such a board is seeded under its board id, not under the name)
                            "countries": ["CN"] }   optional, smartrecruiters only: ask with the API's country filter
                        Empty lines and lines starting with # are skipped.
  --date <YYYY-MM-DD>   the validation date written into the report (the clock is never read for it)
  --out <file>          the report. If it exists (same date), only candidates without a final answer are asked.

options
  --max <n>             hard cap of requests in this run (default 800)
  --pages <n>           pages read per paged listing, Lever and SmartRecruiters, 100 postings each (default 10)
  --only <ats,ats>      ask only these systems in this run
  --fresh               ignore an existing report at --out and ask every candidate again
  --redo <key,key>      ask these candidates again whatever the report holds (key: ats:token, as the report writes it)
  --redo-incomplete     also ask again the valid boards whose listing was longer than --pages (use with a larger --pages)
  --rejudge             ask nothing: apply the names and aliases of the candidates file, as it is now, to the
                        answers already in the report (after an alias was added for a board that stated another name)
  --pause <ms>          pause between two requests to one host (default 300, never less)
  --timeout <ms>        per request (default 20000)
  --help                this text

politeness: 2 requests in flight per host, the pause above, one retry after a network error, no retry of a 404,
a host that answers 429 is left alone for the rest of the run.
exit code: 0 all candidates answered, 3 some are still open (run again), 2 usage error.`;

// ── Constants ────────────────────────────────────────────────────────────

/** The systems a candidate may name. `lever_eu` is validated and reported, never seeded (no connector reads that host yet). */
export const CANDIDATE_ATS = ['greenhouse', 'lever', 'lever_eu', 'ashby', 'smartrecruiters'];

/** The documented public posting API of each system. Nothing else is ever asked. */
export const ATS_HOST = {
  greenhouse: 'boards-api.greenhouse.io',
  lever: 'api.lever.co',
  lever_eu: 'api.eu.lever.co',
  ashby: 'api.ashbyhq.com',
  smartrecruiters: 'api.smartrecruiters.com',
};
export const ALLOWED_HOSTS = Object.values(ATS_HOST);

/** The systems whose answer states no company name: only the board id can speak for the employer. */
export const STATES_NO_COMPANY = ['lever', 'lever_eu', 'ashby'];

/** An alias source names a document of this repository, with the section: "docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5". */
export const ALIAS_SOURCE_PATTERN = /^docs\/[A-Za-z0-9_./-]+\.md(\s\S.*)?$/;

/** Same shape as the server's BOARD_TOKEN_PATTERN (sources/atsPublic/contract.ts). */
export const BOARD_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;

export const IN_FLIGHT_PER_HOST = 2;
export const MIN_PAUSE_MS = 300;
export const DEFAULT_MAX_REQUESTS = 800;
export const DEFAULT_PAGES = 10;
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Largest answer read, in characters (the server's connectors use the same limit). */
export const MAX_RESPONSE_CHARS = 15 * 1024 * 1024;
export const PAGE_SIZE = 100;

export const VERIFIED_BY = 'live board API';

/** Reasons that are final: asking again would get the same answer. */
export const FINAL_REASONS = new Set(['not_found', 'no_postings', 'name_mismatch', 'name_unconfirmed', 'unexpected_shape', 'not_json', 'redirect', 'response_too_large', 'host_not_allowed']);

// ── Who is asking ────────────────────────────────────────────────────────

/** The site named when no contact is set (server: the brand registry's canonical origin of RoboApply). */
export const DEFAULT_CONTACT = 'https://www.roboapply.io';
export const USER_AGENT_MAX = 200;

/**
 * The identifying User-Agent, the same text the server's board sync sends for
 * the international brand (server: `sourceUserAgent('intl', env)` in
 * features/jobs/sources/userAgent.ts; the test compares the two).
 */
export function userAgent(env = process.env) {
  const raw = typeof env.JOB_SOURCES_CONTACT === 'string' ? env.JOB_SOURCES_CONTACT : '';
  const firstLine = raw.split(/[\r\n]+/).find((line) => line.trim()) ?? '';
  const contact =
    firstLine
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || DEFAULT_CONTACT;
  const head = 'RoboApplyJobs/1.0 (+';
  return `${head}${contact.slice(0, USER_AGENT_MAX - head.length - 1).trimEnd()})`;
}

// ── Arguments and candidates ─────────────────────────────────────────────

export class UsageError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function intArg(name, raw, min, max) {
  if (!/^\d+$/.test(String(raw ?? ''))) throw new UsageError(`${name} needs a whole number`);
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}`);
  return n;
}

export function parseArgs(argv) {
  const out = { help: false, candidates: null, date: null, out: null, max: DEFAULT_MAX_REQUESTS, pages: DEFAULT_PAGES, only: null, fresh: false, rejudge: false, redoIncomplete: false, redo: [], pauseMs: MIN_PAUSE_MS, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--candidates') out.candidates = value();
    else if (arg === '--date') out.date = value();
    else if (arg === '--out') out.out = value();
    else if (arg === '--max') out.max = intArg('--max', value(), 1, 5000);
    else if (arg === '--pages') out.pages = intArg('--pages', value(), 1, 200);
    else if (arg === '--pause') out.pauseMs = intArg('--pause', value(), MIN_PAUSE_MS, 60_000);
    else if (arg === '--timeout') out.timeoutMs = intArg('--timeout', value(), 1000, 120_000);
    else if (arg === '--fresh') out.fresh = true;
    else if (arg === '--rejudge') out.rejudge = true;
    else if (arg === '--redo-incomplete') out.redoIncomplete = true;
    else if (arg === '--redo')
      out.redo = value()
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    else if (arg === '--only') {
      out.only = value()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const unknown = out.only.find((a) => !CANDIDATE_ATS.includes(a));
      if (unknown) throw new UsageError(`--only: unknown job-board system "${unknown}" (allowed: ${CANDIDATE_ATS.join(', ')})`);
    } else throw new UsageError(`unknown argument ${arg}`);
  }
  if (out.help) return out;
  if (!out.candidates) throw new UsageError('--candidates is required');
  if (!out.date) throw new UsageError('--date is required (the validation date, YYYY-MM-DD; the clock is never read for it)');
  if (!isDate(out.date)) throw new UsageError('--date must be a real day written YYYY-MM-DD');
  if (!out.out) throw new UsageError('--out is required');
  if (out.rejudge && out.fresh) throw new UsageError('--rejudge reads the existing report; it cannot be combined with --fresh');
  return out;
}

/** What makes two candidate lines the same question to the same board. */
export function candidateKey(c) {
  const countries = Array.isArray(c.countries) && c.countries.length ? `@${[...c.countries].sort().join(',')}` : '';
  return `${c.ats}:${c.token}${countries}`;
}

/** Parses the candidates file. Returns the candidates and every line that is not one (with its number and why). */
export function parseCandidates(text) {
  const candidates = [];
  const errors = [];
  const seen = new Set();
  String(text)
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const bad = (why) => errors.push({ line: i + 1, why });
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return bad('not JSON');
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) return bad('not an object');
      if (!CANDIDATE_ATS.includes(row.ats)) return bad(`unknown job-board system (allowed: ${CANDIDATE_ATS.join(', ')})`);
      if (typeof row.token !== 'string' || !BOARD_TOKEN_PATTERN.test(row.token)) return bad('invalid board id');
      if (typeof row.employer !== 'string' || !row.employer.trim() || row.employer.length > 200) return bad('no employer name');
      if (!normalizeName(row.employer)) return bad('the employer name holds no letter or digit');
      const aliases = row.aliases === undefined ? [] : row.aliases;
      if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string' || !a.trim())) return bad('aliases must be a list of names');
      let countries = [];
      if (row.countries !== undefined) {
        if (row.ats !== 'smartrecruiters') return bad('countries is for smartrecruiters only (the one API with a country filter)');
        if (!Array.isArray(row.countries) || row.countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))) return bad('countries must be ISO alpha-2 codes in upper case');
        countries = [...new Set(row.countries)].sort();
      }
      let aliasSource = null;
      if (row.aliasSource !== undefined) {
        if (!STATES_NO_COMPANY.includes(row.ats)) return bad('aliasSource is for lever, lever_eu and ashby only (the systems that state no company name)');
        if (aliases.length === 0) return bad('aliasSource needs the alias it is the source of');
        if (typeof row.aliasSource !== 'string' || !ALIAS_SOURCE_PATTERN.test(row.aliasSource.trim())) return bad('aliasSource must name a document of this repository and the section (docs/<file>.md <section>)');
        aliasSource = row.aliasSource.trim();
      }
      const candidate = { ats: row.ats, token: row.token, employer: row.employer.trim(), aliases: aliases.map((a) => a.trim()), countries, ...(aliasSource ? { aliasSource } : {}) };
      const key = candidateKey(candidate);
      if (seen.has(key)) return bad(`${key} is listed twice`);
      seen.add(key);
      candidates.push(candidate);
    });
  return { candidates, errors };
}

// ── Names ────────────────────────────────────────────────────────────────

/** Legal forms set aside when two company names are compared (only at the end of a name). */
const LEGAL_FORMS = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'pbc', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'se', 'sa', 'sas', 'sarl',
  'bv', 'nv', 'ab', 'as', 'asa', 'oy', 'oyj', 'aps', 'kk', 'pte', 'pty', 'srl', 'spa', 'sl', 'sro', 'kg', 'kgaa', 'ug', 'lda', 'ltda', 'sdn', 'bhd', 'pvt', 'jsc', 'kft', 'doo', 'ou',
]);

/**
 * A company name with case, accents, punctuation, a leading "the" and trailing
 * legal forms set aside, written without spaces: "Stripe, Inc." -> "stripe",
 * "Hims & Hers" -> "himsandhers", "ACME Co., Ltd." -> "acme".
 */
export function normalizeName(name) {
  if (typeof name !== 'string') return '';
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\ba\/s\b/g, 'as')
    .replace(/\bsp\.?\s*z\s*o\.?\s*o\.?/g, ' ')
    .replace(/[.'’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** A board id as compared with a name: lower case, letters and digits only. */
export function normalizeToken(token) {
  return String(token ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Is the board this employer's? `stated` is the company name the board's answer
 * carried, or null when the system states none. Returns how it was confirmed,
 * or the reason it was not.
 *
 * Where the system states no name and the board id does not spell the
 * employer's, an alias equal to the board id is the candidates file speaking,
 * not the board. It gives the employer's name only with the document that
 * confirms it (`board_id_alias`, with `nameSource`). Without one the answer is
 * `board_id_only`: a live board whose employer nothing confirms, to be listed
 * under its board id.
 */
export function checkName(candidate, stated) {
  const aliases = candidate.aliases ?? [];
  if (typeof stated === 'string' && stated.trim()) {
    const got = normalizeName(stated);
    if (got && got === normalizeName(candidate.employer)) return { ok: true, nameCheck: 'stated_name' };
    if (got && aliases.some((a) => normalizeName(a) === got)) return { ok: true, nameCheck: 'stated_name_alias' };
    return { ok: false, reason: 'name_mismatch' };
  }
  const token = normalizeToken(candidate.token);
  if (token && token === normalizeName(candidate.employer)) return { ok: true, nameCheck: 'board_id_is_name' };
  if (token && aliases.some((a) => normalizeToken(a) === token || normalizeName(a) === token)) {
    const source = typeof candidate.aliasSource === 'string' && ALIAS_SOURCE_PATTERN.test(candidate.aliasSource) ? candidate.aliasSource : null;
    return source ? { ok: true, nameCheck: 'board_id_alias', nameSource: source } : { ok: true, nameCheck: 'board_id_only' };
  }
  return { ok: false, reason: 'name_unconfirmed' };
}

/** A result from the judgement of its name and the facts its listing gave. */
function judged(base, name, facts) {
  if (!name.ok) return { ...base, valid: false, reason: name.reason, ...facts };
  return { ...base, valid: true, nameCheck: name.nameCheck, ...(name.nameSource ? { nameSource: name.nameSource } : {}), ...facts };
}

// ── Politeness ───────────────────────────────────────────────────────────

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * At most `inFlight` calls run at once per host, and a call to a host starts
 * no sooner than `pauseMs` after the previous call to that host started and
 * no sooner than `pauseMs` after any call to it ended. Callers wait in order.
 */
export function createHostLimiter({ inFlight = IN_FLIGHT_PER_HOST, pauseMs = MIN_PAUSE_MS, now = () => Date.now(), sleep = realSleep } = {}) {
  const hosts = new Map();
  return async function run(host, fn) {
    let h = hosts.get(host);
    if (!h) hosts.set(host, (h = { active: 0, waiting: [], notBefore: 0 }));
    if (h.active >= inFlight) await new Promise((resolve) => h.waiting.push(resolve));
    else h.active += 1;
    try {
      // Wait until the host may be asked again. Looked at once more after every wait: a request
      // that ended meanwhile has moved the time on.
      for (;;) {
        const wait = h.notBefore - now();
        if (wait <= 0) break;
        await sleep(wait);
      }
      h.notBefore = now() + pauseMs;
      try {
        return await fn();
      } finally {
        h.notBefore = Math.max(h.notBefore, now() + pauseMs);
      }
    } finally {
      const next = h.waiting.shift();
      if (next) next();
      else h.active -= 1;
    }
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

/** Why a read gave no listing. `reason` goes into the report. */
export class ReadError extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.name = 'ReadError';
    this.reason = reason;
    this.status = status;
  }
}

class NetworkError extends Error {}

export function assertAllowedHost(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReadError('host_not_allowed');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) throw new ReadError('host_not_allowed');
  return parsed.hostname;
}

/**
 * The one way out to the network. Counts every request, refuses any host that
 * is not a documented board API, stops at the cap, retries once after a
 * network error, and leaves a host alone after a 429.
 */
export function createClient({ fetchImpl = globalThis.fetch, max = DEFAULT_MAX_REQUESTS, inFlight = IN_FLIGHT_PER_HOST, pauseMs = MIN_PAUSE_MS, timeoutMs = DEFAULT_TIMEOUT_MS, agent = userAgent(), now, sleep } = {}) {
  const limiter = createHostLimiter({ inFlight, pauseMs: Math.max(MIN_PAUSE_MS, pauseMs), ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) });
  const state = { requests: 0, limited: new Set() };

  async function once(url, host) {
    return limiter(host, async () => {
      if (state.limited.has(host)) throw new ReadError('host_rate_limited');
      if (state.requests >= max) throw new ReadError('request_cap');
      state.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      let body;
      try {
        res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': agent }, redirect: 'manual', signal: controller.signal });
        if (res.status === 200) body = await res.text();
      } catch (err) {
        throw new NetworkError(controller.signal.aborted ? 'timeout' : 'network_error', { cause: err });
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400) throw new ReadError('redirect', res.status);
      if (res.status === 404) throw new ReadError('not_found', 404);
      if (res.status === 429) {
        state.limited.add(host);
        throw new ReadError('rate_limited', 429);
      }
      if (res.status !== 200) throw new ReadError(`http_${res.status}`, res.status);
      if (body.length > MAX_RESPONSE_CHARS) throw new ReadError('response_too_large', 200);
      try {
        return JSON.parse(body);
      } catch {
        throw new ReadError('not_json', 200);
      }
    });
  }

  return {
    get requests() {
      return state.requests;
    },
    limitedHosts: () => [...state.limited],
    async getJson(url) {
      const host = assertAllowedHost(url);
      // Nothing waits in a queue once the run may not ask any more.
      if (state.limited.has(host)) throw new ReadError('host_rate_limited');
      if (state.requests >= max) throw new ReadError('request_cap');
      try {
        return await once(url, host);
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
      }
      // One retry after a network error, through the same queue and pause.
      try {
        return await once(url, host);
      } catch (err) {
        if (err instanceof NetworkError) throw new ReadError(err.message);
        throw err;
      }
    },
  };
}

const enc = encodeURIComponent;
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);

/** The listing URLs, the same the server's connectors build. */
export const LISTING_URL = {
  greenhouse: (token) => `https://${ATS_HOST.greenhouse}/v1/boards/${enc(token)}/jobs`,
  lever: (token, page = 0) => `https://${ATS_HOST.lever}/v0/postings/${enc(token)}?mode=json&skip=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`,
  lever_eu: (token, page = 0) => `https://${ATS_HOST.lever_eu}/v0/postings/${enc(token)}?mode=json&skip=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`,
  ashby: (token) => `https://${ATS_HOST.ashby}/posting-api/job-board/${enc(token)}`,
  smartrecruiters: (token, page = 0, country = null) =>
    `https://${ATS_HOST.smartrecruiters}/v1/companies/${enc(token)}/postings?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${country ? `&country=${enc(country.toLowerCase())}` : ''}`,
};

/**
 * What one listing read measured. `places` holds, per posting READ, the ISO
 * countries its location fields name (nothing else of a posting is kept).
 * `credited` are postings a country-filtered SmartRecruiters pass states
 * beyond the rows read: the API's own count for that country.
 */
function measurement() {
  return { stated: null, places: [], credited: {}, total: 0, complete: true, requests: 0 };
}

/**
 * The countries a posting's location lines name: each line is one place. A
 * country the board states belongs to the first line, and the line's own text
 * decides when it names a place (./places.mjs `countryOfStatedLocation`).
 */
function placesOf(lines, statedFirst = null) {
  const out = new Set();
  lines.forEach((line, i) => {
    const country = i === 0 ? countryOfStatedLocation(line, statedFirst) : countryOfLocation(line);
    if (country) out.add(country);
  });
  if (lines.length === 0 && statedFirst) out.add(statedFirst);
  return out;
}

const READERS = {
  async greenhouse(candidate, client) {
    const m = measurement();
    const body = record(await client.getJson(LISTING_URL.greenhouse(candidate.token)));
    m.requests += 1;
    if (!body || !Array.isArray(body.jobs)) throw new ReadError('unexpected_shape');
    for (const raw of body.jobs) {
      const job = record(raw);
      if (!job || (typeof job.id !== 'number' && !text(job.id)) || !text(job.title)) continue;
      m.stated ??= text(job.company_name);
      const lines = [text(record(job.location)?.name), ...list(job.offices).map((o) => text(record(o)?.location) ?? text(record(o)?.name))].filter(Boolean);
      m.places.push(placesOf([...new Set(lines)]));
    }
    m.total = m.places.length;
    return m;
  },

  async lever(candidate, client, opts, ats = 'lever') {
    const m = measurement();
    m.complete = false;
    for (let page = 0; page < opts.pages; page += 1) {
      const body = await client.getJson(LISTING_URL[ats](candidate.token, page));
      m.requests += 1;
      if (!Array.isArray(body)) throw new ReadError('unexpected_shape');
      for (const raw of body) {
        const job = record(raw);
        if (!job || !text(job.id) || !text(job.text)) continue;
        const cat = record(job.categories) ?? {};
        const lines = [text(cat.location), ...list(cat.allLocations).map(text)].filter(Boolean);
        // Lever states the country of the posting's first location.
        m.places.push(placesOf([...new Set(lines)], countryFromField(job.country)));
      }
      if (body.length < PAGE_SIZE) {
        m.complete = true;
        break;
      }
    }
    // Lever states no total: a listing cut at the page limit counts what was read.
    m.total = m.places.length;
    return m;
  },

  lever_eu(candidate, client, opts) {
    return READERS.lever(candidate, client, opts, 'lever_eu');
  },

  async ashby(candidate, client) {
    const m = measurement();
    const body = record(await client.getJson(LISTING_URL.ashby(candidate.token)));
    m.requests += 1;
    if (!body || !Array.isArray(body.jobs)) throw new ReadError('unexpected_shape');
    for (const raw of body.jobs) {
      const job = record(raw);
      if (!job || !text(job.id) || !text(job.title) || job.isListed === false) continue;
      const places = placesOf([text(job.location)].filter(Boolean), countryFromField(record(record(job.address)?.postalAddress)?.addressCountry));
      for (const s of list(job.secondaryLocations)) {
        const second = record(s);
        const country = countryOfStatedLocation(text(second?.location), countryFromField(record(record(second?.address)?.postalAddress)?.addressCountry));
        if (country) places.add(country);
      }
      m.places.push(places);
    }
    m.total = m.places.length;
    return m;
  },

  async smartrecruiters(candidate, client, opts) {
    const m = measurement();
    const seen = new Set();
    // One pass per country the candidate names (the API's own filter), else one pass over everything.
    for (const filter of candidate.countries.length ? candidate.countries : [null]) {
      let read = 0;
      let stated = null;
      let allInFilter = true;
      let ended = false;
      for (let page = 0; page < opts.pages && !ended; page += 1) {
        const body = record(await client.getJson(LISTING_URL.smartrecruiters(candidate.token, page, filter)));
        m.requests += 1;
        if (!body || !Array.isArray(body.content)) throw new ReadError('unexpected_shape');
        if (page === 0 && typeof body.totalFound === 'number' && Number.isFinite(body.totalFound)) stated = body.totalFound;
        for (const raw of body.content) {
          const row = record(raw);
          const id = row && text(row.id);
          if (!row || !id || !text(row.name)) continue;
          read += 1;
          m.stated ??= text(record(row.company)?.name);
          const loc = record(row.location) ?? {};
          // The line the server's connector passes on with the stated country: the full location, else city and region.
          const country = countryOfStatedLocation(text(loc.fullLocation) ?? [text(loc.city), text(loc.region)].filter(Boolean).join(', '), countryFromField(loc.country));
          if (filter && country !== filter) allInFilter = false;
          if (seen.has(id)) continue;
          seen.add(id);
          m.places.push(new Set(country ? [country] : []));
        }
        ended = body.content.length < PAGE_SIZE || (stated !== null && (page + 1) * PAGE_SIZE >= stated);
        // A filtered pass needs no second page: its total is the API's own count for that country (credited below).
        if (filter && allInFilter && read > 0) break;
        // A listing the page limit cannot reach the end of is not paged at all: its first page says how long it is.
        if (stated !== null && stated > opts.pages * PAGE_SIZE) break;
      }
      const total = ended ? read : Math.max(stated ?? 0, read);
      m.total += total;
      if (!ended) {
        // The rest of a country-filtered pass is the API's own count for that country, once every row read was there.
        if (filter && allInFilter && read > 0) m.credited[filter] = (m.credited[filter] ?? 0) + (total - read);
        else m.complete = false;
      }
    }
    return m;
  },
};

/** Counts per country from the places of the postings read (a posting counts once for each country it is located in). */
export function tally(m) {
  const byCountry = {};
  let unplaced = 0;
  let elsewhere = 0;
  for (const places of m.places) {
    if (places.size === 0) unplaced += 1;
    for (const c of places) byCountry[c] = (byCountry[c] ?? 0) + 1;
    // The international market: a location outside mainland China and Taiwan, or none that could be placed.
    if (places.size === 0 || [...places].some((c) => c !== 'CN' && c !== 'TW')) elsewhere += 1;
  }
  for (const [c, n] of Object.entries(m.credited)) {
    byCountry[c] = (byCountry[c] ?? 0) + n;
    if (c !== 'CN' && c !== 'TW') elsewhere += n;
  }
  const sorted = Object.fromEntries(Object.entries(byCountry).sort(([a], [b]) => a.localeCompare(b)));
  return { byCountry: sorted, unplaced, mainland: sorted.CN ?? 0, taiwan: sorted.TW ?? 0, elsewhere };
}

/** One candidate: read its listing once and judge it. Never throws. */
export async function validateCandidate(candidate, client, opts = {}) {
  const base = { ats: candidate.ats, token: candidate.token, employer: candidate.employer, ...(candidate.countries.length ? { countries: candidate.countries } : {}) };
  let m;
  try {
    m = await READERS[candidate.ats](candidate, client, { pages: opts.pages ?? DEFAULT_PAGES });
  } catch (err) {
    if (err instanceof ReadError) return { ...base, valid: false, reason: err.reason };
    // A fault of this script, not an answer of the board: reported, never final, and said out loud.
    opts.onFault?.(candidate, err);
    return { ...base, valid: false, reason: 'internal_error' };
  }
  if (m.total === 0) return { ...base, valid: false, reason: 'no_postings', requests: m.requests };
  const facts = { companyName: m.stated, postings: m.total, read: m.places.length, complete: m.complete, ...tally(m), requests: m.requests };
  return judged(base, checkName(candidate, m.stated), facts);
}

/**
 * The name rule applied again to an answer already in a report, with the
 * candidate as the file states it now. Only an answer that listed postings can
 * change (valid, name_mismatch, name_unconfirmed); nothing is asked.
 */
export function rejudge(result, candidate) {
  if (!candidate || typeof result.postings !== 'number' || result.postings < 1 || !(result.valid || result.reason === 'name_mismatch' || result.reason === 'name_unconfirmed')) return result;
  const { valid: _valid, reason: _reason, nameCheck: _nameCheck, nameSource: _nameSource, ats, token, employer: _employer, countries, ...facts } = result;
  const base = { ats, token, employer: candidate.employer, ...(countries ? { countries } : {}) };
  return judged(base, checkName(candidate, result.companyName ?? null), facts);
}

/** Is this result the board's last word (so it is not asked again)? */
export function isFinal(result) {
  if (!result) return false;
  if (result.valid === true) return true;
  const reason = result.reason ?? '';
  if (FINAL_REASONS.has(reason)) return true;
  // A refusal (4xx) is the board's answer; "try later" (408, 429) and a server error are not.
  return /^http_4\d\d$/.test(reason) && reason !== 'http_408';
}

/**
 * All candidates. Each host has its own queue, worked by as many callers as it
 * may have requests in flight, so a slow host never holds up another one.
 * Results come back in the order of `candidates`.
 */
export async function validateAll(candidates, client, opts = {}) {
  const results = new Array(candidates.length);
  const queues = new Map();
  candidates.forEach((candidate, index) => {
    const host = ATS_HOST[candidate.ats];
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push({ candidate, index });
  });
  await Promise.all(
    [...queues.values()].map(async (queue) => {
      let next = 0;
      const worker = async () => {
        for (;;) {
          const item = queue[next++];
          if (!item) return;
          results[item.index] = await validateCandidate(item.candidate, client, opts);
          opts.onResult?.(results[item.index]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(IN_FLIGHT_PER_HOST, queue.length) }, worker));
    }),
  );
  return results;
}

// ── The report ───────────────────────────────────────────────────────────

export const REPORT_ABOUT =
  'Employer-board seed validation (scripts/board-seeds/validate.mjs): what each candidate board answered on the date below. ' +
  'Counts only. No posting title or text is stored: per board, the company name its own answer stated, the number of postings it listed, ' +
  'and the number per ISO country taken from the location fields. A candidate is a guess; only "valid": true makes it a fact. ' +
  'nameCheck says how the name was confirmed; "board_id_only" is a live board whose employer nothing confirms (it is listed under its board id), ' +
  'and nameSource is the document that confirms a board id for an employer where the system states no company name.';

export function resultKey(r) {
  return candidateKey({ ats: r.ats, token: r.token, countries: r.countries ?? [] });
}

/** Per job-board system: candidates tried, valid, postings on valid boards, and the reasons of the others. */
export function summarize(results) {
  const out = {};
  const row = () => ({ tried: 0, valid: 0, postings: 0, open: 0, reasons: {} });
  for (const r of results) {
    for (const key of [r.ats, 'all']) {
      const s = (out[key] ??= row());
      s.tried += 1;
      if (r.valid) {
        s.valid += 1;
        s.postings += r.postings ?? 0;
      } else {
        s.reasons[r.reason] = (s.reasons[r.reason] ?? 0) + 1;
        if (!isFinal(r)) s.open += 1;
      }
    }
  }
  return out;
}

/** The report as text: a readable header, then one result per line. */
export function renderReport(report) {
  const { results, ...head } = report;
  const lines = results.map((r) => `    ${JSON.stringify(r)}`);
  return `${JSON.stringify(head, null, 2).replace(/\n}$/, '')},\n  "results": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/**
 * Merges this run into what an earlier run left: a new answer replaces the old
 * one for the same candidate. One exception: a failure in passing (a timeout,
 * the request cap) never replaces a final answer, so asking a board again
 * cannot lose what it answered before.
 */
export function mergeResults(previous, results) {
  const byKey = new Map();
  for (const r of previous ?? []) byKey.set(resultKey(r), r);
  for (const r of results) {
    const before = byKey.get(resultKey(r));
    if (!(before && isFinal(before) && !isFinal(r))) byKey.set(resultKey(r), r);
  }
  return [...byKey.values()];
}

// ── The command ──────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  const readFile = deps.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data));
  const exists = deps.exists ?? existsSync;
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e instanceof UsageError ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }

  let parsed;
  try {
    parsed = parseCandidates(readFile(args.candidates));
  } catch (e) {
    err(`cannot read ${args.candidates}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (parsed.errors.length) {
    for (const e of parsed.errors.slice(0, 20)) err(`${args.candidates}:${e.line}: ${e.why}`);
    err(`${parsed.errors.length} line(s) are not candidates; nothing was asked.`);
    return 2;
  }

  let previous = null;
  if (!args.fresh && exists(args.out)) {
    try {
      previous = JSON.parse(readFile(args.out));
    } catch {
      err(`${args.out} exists and is not a report; pass --fresh to replace it.`);
      return 2;
    }
    if (previous?.date !== args.date) {
      err(`${args.out} is the report of ${previous?.date}; use another --out for ${args.date}, or --fresh.`);
      return 2;
    }
  }
  if (args.rejudge) {
    if (!previous) {
      err(`--rejudge needs the report at ${args.out}; there is none.`);
      return 2;
    }
    const byKey = new Map(parsed.candidates.map((c) => [candidateKey(c), c]));
    let changed = 0;
    const results = previous.results.map((r) => {
      const again = rejudge(r, byKey.get(resultKey(r)));
      if (again.valid !== r.valid || again.nameCheck !== r.nameCheck || again.nameSource !== r.nameSource) changed += 1;
      return again;
    });
    writeFile(args.out, renderReport({ ...previous, summary: summarize(results), results }));
    out(`Asked nothing. ${changed} answer(s) changed under the names of ${args.candidates}. Report ${args.out}: ${summarize(results).all?.valid ?? 0} valid boards.`);
    return 0;
  }
  const answered = new Map((previous?.results ?? []).map((r) => [resultKey(r), r]));
  const unknown = args.redo.filter((key) => !parsed.candidates.some((c) => candidateKey(c) === key));
  if (unknown.length) {
    err(`--redo: not in ${args.candidates}: ${unknown.join(', ')}`);
    return 2;
  }
  const settled = (r) => isFinal(r) && !(args.redoIncomplete && r.valid === true && r.complete === false);
  const todo = parsed.candidates.filter((c) => args.redo.includes(candidateKey(c)) || ((!args.only || args.only.includes(c.ats)) && !settled(answered.get(candidateKey(c)))));

  const agent = userAgent(deps.env ?? process.env);
  const client = createClient({ fetchImpl: deps.fetch ?? globalThis.fetch, max: args.max, pauseMs: args.pauseMs, timeoutMs: args.timeoutMs, agent, now: deps.now, sleep: deps.sleep });
  out(`${parsed.candidates.length} candidates, ${todo.length} to ask (cap ${args.max} requests, ${args.pages} page(s) per paged listing). Asking as ${agent}`);
  const results = await validateAll(todo, client, {
    pages: args.pages,
    onFault: (candidate, e) => err(`fault while reading ${candidateKey(candidate)}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`),
  });

  // The report keeps the order of the candidates file; answers to lines since removed follow.
  const merged = mergeResults(previous?.results, results);
  const stood = results.filter((r) => !isFinal(r) && isFinal(answered.get(resultKey(r))));
  if (stood.length) out(`${stood.length} candidate(s) could not be asked again (a failure in passing); their earlier answer stands: ${stood.map(resultKey).join(', ')}`);
  const order = new Map(parsed.candidates.map((c, i) => [candidateKey(c), i]));
  merged.sort((a, b) => (order.get(resultKey(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(resultKey(b)) ?? Number.MAX_SAFE_INTEGER));
  const report = {
    about: REPORT_ABOUT,
    date: args.date,
    verifiedBy: VERIFIED_BY,
    userAgent: agent,
    politeness: { inFlightPerHost: IN_FLIGHT_PER_HOST, pauseMs: Math.max(MIN_PAUSE_MS, args.pauseMs), retriesAfterNetworkError: 1 },
    places: gazetteerInfo(),
    requests: (previous?.requests ?? 0) + client.requests,
    runs: [
      ...(previous?.runs ?? []),
      { asked: todo.length, requests: client.requests, max: args.max, pages: args.pages, ...(args.only ? { only: args.only } : {}), ...(args.redo.length ? { redo: args.redo.length } : {}), ...(args.redoIncomplete ? { redoIncomplete: true } : {}) },
    ],
    summary: summarize(merged),
    results: merged,
  };
  writeFile(args.out, renderReport(report));

  const final = new Map(merged.map((r) => [resultKey(r), r]));
  const open = parsed.candidates.filter((c) => !isFinal(final.get(candidateKey(c)))).length;
  const s = report.summary.all ?? { tried: 0, valid: 0, postings: 0, reasons: {} };
  out(`This run: ${client.requests} requests. Report ${args.out}: ${s.tried} answered so far, ${s.valid} valid boards, ${s.postings} postings.`);
  for (const ats of CANDIDATE_ATS) {
    const a = report.summary[ats];
    if (a) out(`  ${ats}: tried ${a.tried}, valid ${a.valid}, postings ${a.postings}, not valid ${JSON.stringify(a.reasons)}`);
  }
  if (client.limitedHosts().length) out(`Asked to slow down (429) and left alone for this run: ${client.limitedHosts().join(', ')}`);
  if (open > 0) {
    out(`${open} candidate(s) have no final answer yet. Run the same command again to ask them.`);
    return 3;
  }
  return 0;
}

/** True when this file is the script being run (not imported by a test). */
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
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
