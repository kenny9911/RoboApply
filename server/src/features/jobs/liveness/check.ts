// server/src/features/jobs/liveness/check.ts — is this posting still listed? (MKT-5C; JI-10.)
//
// MARKET_STRATEGY 1.5 "Closure": "On job open and on Ready to apply, confirm
// an ATS-host link against the ATS's documented single-posting JSON endpoint;
// show closed instead of a dead link." A source's own sync closes a posting
// hours later at best (a board is read every 2 to 24 hours), and a JSearch row
// has no closure signal at all. This asks the ATS at the moment a person
// opens the job.
//
// `checkPostingLive(job, deps)` → `{ state, checkedAt, via }`:
//   open      the API answered 200 with this posting (now, or earlier in this
//             process within LIVENESS_RECHECK_HOURS), or the ATS's own board
//             sync saw it listed within that window (no request then)
//   closed    the API answered its JSON 404, or the row is closed already
//   unknown   everything else. Nothing is ever concluded from a timeout, a
//             5xx, a 429, a redirect or an answer of another shape.
//
// Which rows are asked about: a PUBLIC, open row that carries an
// `atsPostingKey` (`<ats>:<tenant>:<postingId>`, written by ingest: MKT-3C) of
// one of the three ATSs in postingApi.ts, whichever provider the row came
// from (a JSearch row that links to Greenhouse included). A user's own
// import, a recruiter bank's row, a row with no key and a row keyed to any
// other ATS (Workday, iCIMS, Ashby, Workable) are answered "unknown" WITHOUT a
// request: the bank closes its own rows by tombstone, and no other system
// documents such an endpoint.
//
// The request URL comes from the stored key alone. The key is lower case (it
// is an identity for comparison), and Lever reads its site name with regard to
// case, so the tenant and the id are taken in the spelling of one of the
// row's own identifiers (its apply link, its posting link, a board row's
// `externalId`) when, and only when, that identifier names the SAME key.
// Without one, a Lever key is "unknown" (no request); the other two are asked
// in lower case, which their APIs accept. Nothing else of the row reaches the
// URL: a row whose links point somewhere else is still asked under its key.
//
// One more caution for Lever. Its API answers the SAME 404 for a closed
// posting and for a site name in another letter case. A site name the board
// API itself gave us (a row of our own board sync: `externalId`) is right by
// construction, so a 404 under it is "closed". A site name read from a link
// somebody else wrote (an aggregator's apply link) proves a posting open when
// the API lists it, but a 404 under it is "unknown": it could be the spelling.
// Such a row keeps its other closure (its board row's sync through the shared
// posting key, else its expiry date).
//
// Whose sighting counts. `lastSeenAt` says when the row's SOURCE last listed
// the posting. For the ATS's own board row (a row of our board sync: its board
// is the ATS of the key and its `externalId` is the key) that source is the
// ATS's own listing, so a recent sighting answers the question. For a row of
// any other source it does not: an aggregator answers from a search index that
// keeps a posting after the ATS dropped it, and has no closure signal. Such a
// row is never answered from its own `lastSeenAt`; only an answer of the ATS
// itself (this process's, see below) spares the request.
//
// Throttles, in this order:
//   - LIVENESS_CHECK_DISABLED=true: never a request. Neither with
//     ATS_PUBLIC_SOURCES_DISABLED=true: that switch promises "no read of a
//     public job board", and this is one (an operator who pulled it because a
//     vendor complained must not go on calling that vendor);
//   - the ATS's own board row was seen listed (`lastSeenAt`) under
//     LIVENESS_RECHECK_HOURS ago (default 6): answered from the row;
//   - this process has the ATS's answer for the same key: "listed" is reused
//     for LIVENESS_RECHECK_HOURS (never under 10 minutes), "gone" and "cannot
//     tell" for 10 minutes. So rows that share a posting and people who open
//     the same job share one request, and the ATS is asked about one posting
//     at most once per process per window;
//   - two calls for one key at the same moment share the request in flight;
//   - the ATS's host is paused: it answered 429, or failed three times in a
//     row (a timeout, a 5xx, no connection). No request goes to that host for
//     60 seconds (longer when its `Retry-After` says so, 15 minutes at most);
//   - at most LIVENESS_MAX_IN_FLIGHT requests are open at once in a process:
//     a call beyond that is "unknown" (the ATS is never queued up against);
//   - at most LIVENESS_HOST_REQUESTS_PER_MINUTE new requests go to one host
//     in any 60 seconds from one process, whoever asks (one account walking
//     the job list, a cron): a call beyond that is "unknown" and is not
//     remembered, so the posting is asked about once there is room.
// At most one request per call.
//
// `applyLiveness(db, job, result, opts)` is the one place the answer is
// written:
//   open     `lastSeenAt` = the moment of the check ("last confirmed listed")
//   closed   the row AND every other open public row that names the same
//            posting key (the same posting from another provider, or its copy
//            in the other market) are archived (`archivedAt`, `closedAt`),
//            each with the reason that says who may reopen it:
//              'source_removed'  the ATS's own board row. Its board sync reads
//                                the ATS's listing, so the ingest upsert
//                                reopens it when the board lists it again;
//              'ats_removed'     a row of any other source. The ATS said the
//                                posting is gone; that source listing it again
//                                proves nothing, and the upsert never reopens
//                                this reason (ingest/upsert.ts
//                                `REVIVED_CLOSE_REASONS` does not hold it).
//            Then the dedupe groups they were in are repaired
//            (`opts.repairDedupe`), so a row of the same job that is NOT this
//            posting becomes the one the lists show.
//   unknown  nothing. A row answered from our own records writes nothing.
// A user's private import and a bank row are never written by it.
//
// D1: this reads one public posting. It never opens, fills or submits an
// application form.

import type prisma from '../../../lib/prisma.js';
import { parseBoolEnv, type EnvSource, type Market } from '../../../platform/brand/index.js';
import { atsPostingKeyFromBoardRow, atsPostingKeyOf, atsPostingRefFromUrl } from '../normalize/index.js';
import { POSTING_ENDPOINTS, TENANT_RE, isLivenessAts, requestPosting, type FetchLike, type LivenessAts, type PostingAnswer } from './postingApi.js';

export const LIVENESS_KILL_SWITCH = 'LIVENESS_CHECK_DISABLED';
/** The board sync's kill switch (sources/atsPublic `ATS_PUBLIC_KILL_SWITCH`; named here so this module does not load the connectors). It stops this read too. */
export const LIVENESS_BOARD_KILL_SWITCH = 'ATS_PUBLIC_SOURCES_DISABLED';
export const LIVENESS_RECHECK_ENV = 'LIVENESS_RECHECK_HOURS';
/** A row confirmed listed within this many hours is not asked about again. */
export const LIVENESS_RECHECK_HOURS = 6;
/**
 * How long a "gone" or "cannot tell" answer of this process is reused for the
 * same posting key. A "listed" answer is reused for LIVENESS_RECHECK_HOURS,
 * and never for less than this.
 */
export const LIVENESS_CACHE_MS = 10 * 60_000;
const LIVENESS_CACHE_MAX = 2_000;
/** Requests open at once in one process. */
export const LIVENESS_MAX_IN_FLIGHT = 8;
/** New requests one process sends to one host in any 60 seconds. */
export const LIVENESS_HOST_REQUESTS_PER_MINUTE = 60;
const HOST_BUDGET_WINDOW_MS = 60_000;
/**
 * `closeReason` of the ATS's own board row the check closed. The row's source
 * IS the ATS's listing, so the ingest upsert reopens it when the board lists
 * the posting again (ingest/upsert.ts `REVIVED_CLOSE_REASONS`).
 */
export const LIVENESS_BOARD_CLOSE_REASON = 'source_removed';
/**
 * `closeReason` of every other row the check closed (an aggregator's copy of
 * the posting): the ATS said the posting is gone. That source listing it
 * again proves nothing (it has no closure signal), so this reason is NOT one
 * the upsert reopens: the row stays closed.
 */
export const LIVENESS_CLOSE_REASON = 'ats_removed';
/** Most rows of one posting key archived by one answer. */
const TWIN_LIMIT = 50;
/** No request goes to a host for this long after it answered 429 or failed LIVENESS_HOST_FAILURES_TO_PAUSE times in a row. */
export const LIVENESS_HOST_PAUSE_MS = 60_000;
/** The longest pause a host's `Retry-After` can ask for. */
export const LIVENESS_HOST_PAUSE_MAX_MS = 15 * 60_000;
/** Failures in a row (a timeout, a 5xx, no connection) that pause a host. */
export const LIVENESS_HOST_FAILURES_TO_PAUSE = 3;

const HOUR_MS = 3_600_000;

export type LiveState = 'open' | 'closed' | 'unknown';
/** 'ats_api' = the ATS's posting API said so (now, or earlier in this process while the answer may be reused); 'sync' = our own records of the row. */
export type LiveVia = 'ats_api' | 'sync';

export interface LiveResult {
  state: LiveState;
  /** When the answer was established: the API's answer, or the row's own date for `via: 'sync'`. Null for "unknown". */
  checkedAt: Date | null;
  via: LiveVia | null;
  /** Why this answer (`listed`, `not_found`, `seen_recently`, `cached`, `row_closed`, or the reason nothing could be told). */
  reason: string;
  /** True when this call sent the request. */
  requested: boolean;
}

/** The columns the check reads. */
export const LIVENESS_JOB_SELECT = {
  id: true,
  market: true,
  visibility: true,
  sourceBoard: true,
  externalId: true,
  fromRecruiterBank: true,
  atsPostingKey: true,
  applyUrl: true,
  sourceUrl: true,
  lastSeenAt: true,
  archivedAt: true,
  closedAt: true,
} as const;

export interface LivenessJob {
  id: string;
  market: string;
  visibility: string;
  sourceBoard: string;
  externalId?: string | null;
  fromRecruiterBank?: boolean | null;
  atsPostingKey?: string | null;
  applyUrl?: string | null;
  sourceUrl?: string | null;
  lastSeenAt?: Date | null;
  archivedAt?: Date | null;
  closedAt?: Date | null;
}

// ── The key and the request it names ──────────────────────────────────────

export interface PostingTarget {
  ats: LivenessAts;
  key: string;
  tenant: string;
  postingId: string;
  url: string;
  /**
   * Where the tenant's spelling comes from: 'board' = the board API itself (a
   * row of our own board sync), 'link' = one of the row's links, 'key' = the
   * lower-case key (only for an ATS that reads the tenant without regard to case).
   */
  spelling: 'board' | 'link' | 'key';
}

/** `<ats>:<tenant>:<postingId>` → its three parts (as the key writes them: lower case), or null. */
export function parsePostingKey(key: string | null | undefined): { ats: string; tenant: string; postingId: string } | null {
  if (typeof key !== 'string') return null;
  const parts = key.trim().split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return { ats: parts[0]!, tenant: parts[1]!, postingId: parts[2]! };
}

/**
 * A board row's own identity in the spelling the board API gave it: the board
 * is the ATS and `externalId` is `<boardToken>:<postingId>` (the `#cn` copy of
 * a posting is the same posting). Null unless that identity is exactly `key`
 * (normalize/ats.ts `atsPostingKeyFromBoardRow`, the rule ingest wrote the key with).
 */
function boardRowSpelling(job: Pick<LivenessJob, 'sourceBoard' | 'externalId'>, key: string): { tenant: string; postingId: string } | null {
  if (typeof job.externalId !== 'string' || atsPostingKeyFromBoardRow(job.sourceBoard, job.externalId) !== key) return null;
  const id = job.externalId.trim().replace(/#cn$/i, '');
  const cut = id.indexOf(':');
  return { tenant: id.slice(0, cut), postingId: id.slice(cut + 1) };
}

/**
 * The tenant and posting id in the spelling of one of the row's own
 * identifiers that names exactly `key`; null when none does. The board row's
 * own id comes first: it is the spelling the board API answered under.
 */
function exactSpelling(job: LivenessJob, key: string): { tenant: string; postingId: string; from: 'board' | 'link' } | null {
  const board = boardRowSpelling(job, key);
  if (board) return { ...board, from: 'board' };
  for (const url of [job.applyUrl, job.sourceUrl]) {
    const ref = atsPostingRefFromUrl(url);
    if (ref && atsPostingKeyOf(ref) === key) return { tenant: ref.tenant, postingId: ref.postingId, from: 'link' };
  }
  return null;
}

export type TargetOutcome = { ok: true; target: PostingTarget } | { ok: false; reason: string };

/**
 * The one URL a row's posting key names, or why there is none. Pure: no
 * request is made here. The ATS, the tenant and the posting id are the key's;
 * the row only lends the letter case of a link that names the same key.
 */
export function postingTargetOf(job: LivenessJob): TargetOutcome {
  const key = typeof job.atsPostingKey === 'string' ? job.atsPostingKey.trim().toLowerCase() : '';
  const parts = parsePostingKey(key);
  if (!parts) return { ok: false, reason: 'no_key' };
  if (!isLivenessAts(parts.ats)) return { ok: false, reason: 'ats_not_supported' };
  const endpoint = POSTING_ENDPOINTS[parts.ats];
  if (!TENANT_RE.test(parts.tenant) || !endpoint.idPattern.test(parts.postingId)) return { ok: false, reason: 'key_not_valid' };
  const exact = exactSpelling(job, key);
  if (!exact && endpoint.tenantCaseMatters) return { ok: false, reason: 'tenant_case_unknown' };
  const tenant = exact?.tenant ?? parts.tenant;
  const postingId = exact?.postingId ?? parts.postingId;
  if (!TENANT_RE.test(tenant) || !endpoint.idPattern.test(postingId)) return { ok: false, reason: 'key_not_valid' };
  return { ok: true, target: { ats: parts.ats, key, tenant, postingId, url: endpoint.url(tenant, postingId), spelling: exact?.from ?? 'key' } };
}

// ── Settings ──────────────────────────────────────────────────────────────

/** Off with its own switch, and with the switch that stops every read of a public job board. */
export function livenessEnabled(env: EnvSource = process.env): boolean {
  return !parseBoolEnv(env[LIVENESS_KILL_SWITCH]) && !parseBoolEnv(env[LIVENESS_BOARD_KILL_SWITCH]);
}

/** LIVENESS_RECHECK_HOURS: a whole or decimal number of hours, 0 to 720 (0 = ask every time the cache allows); anything else is the default. */
export function livenessRecheckHours(env: EnvSource = process.env): number {
  const raw = env[LIVENESS_RECHECK_ENV];
  if (typeof raw !== 'string' || !/^\s*\d+(\.\d+)?\s*$/.test(raw)) return LIVENESS_RECHECK_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 720 ? n : LIVENESS_RECHECK_HOURS;
}

// ── The answers of this process ───────────────────────────────────────────

interface CachedAnswer {
  state: LiveState;
  reason: string;
  /** When the API answered. */
  at: number;
}

/** A small least-recently-used map of the ATS's answers by posting key. */
export interface LivenessCache {
  /**
   * The answer for `key` while it may still be reused: a "listed" answer for
   * `openTtlMs` (default: the cache's own time), any other for the cache's own
   * time. Null (and forgotten) once it is older.
   */
  get(key: string, now: number, openTtlMs?: number): CachedAnswer | null;
  set(key: string, answer: CachedAnswer): void;
  clear(): void;
}

export function createLivenessCache(ttlMs: number = LIVENESS_CACHE_MS, max: number = LIVENESS_CACHE_MAX): LivenessCache {
  const entries = new Map<string, CachedAnswer>();
  return {
    get(key, now, openTtlMs = ttlMs) {
      const hit = entries.get(key);
      if (!hit) return null;
      const ttl = hit.state === 'open' ? Math.max(ttlMs, openTtlMs) : ttlMs;
      if (now - hit.at >= ttl || now < hit.at) {
        entries.delete(key);
        return null;
      }
      // Most recently used last.
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, answer) {
      entries.delete(key);
      entries.set(key, answer);
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
  };
}

// ── A host that said to slow down, or stopped answering ───────────────────

/**
 * Per-host back-off. A host that answers 429 is left alone for
 * LIVENESS_HOST_PAUSE_MS (or its `Retry-After`, capped); so is a host that
 * failed LIVENESS_HOST_FAILURES_TO_PAUSE times in a row. Any answer that shows
 * the host working (a posting, its own 404, another 4xx) clears the count.
 * It also holds each host's budget of new requests (`admit`).
 */
export interface LivenessHosts {
  /** The moment until which `host` gets no request (0 = not paused). */
  pausedUntil(host: string, now: number): number;
  /** May one more request go to `host` now? True counts it: at most `perMinute` in any 60 seconds. */
  admit(host: string, now: number): boolean;
  record(host: string, answer: PostingAnswer, now: number): void;
  clear(): void;
}

/** Did the host fail to answer at all (as opposed to answering something we cannot use)? */
const isHostFailure = (reason: string): boolean => reason === 'timeout' || reason === 'network' || /^http_5\d\d$/.test(reason);

export function createLivenessHosts(perMinute: number = LIVENESS_HOST_REQUESTS_PER_MINUTE): LivenessHosts {
  const state = new Map<string, { failures: number; until: number }>();
  /** The moments of the requests sent to each host within the last window. */
  const sent = new Map<string, number[]>();
  return {
    pausedUntil(host, now) {
      const s = state.get(host);
      return s && s.until > now ? s.until : 0;
    },
    admit(host, now) {
      const recent = (sent.get(host) ?? []).filter((at) => at <= now && now - at < HOST_BUDGET_WINDOW_MS);
      const room = recent.length < perMinute;
      if (room) recent.push(now);
      sent.set(host, recent);
      return room;
    },
    record(host, answer, now) {
      const s = state.get(host) ?? { failures: 0, until: 0 };
      if (answer.kind === 'error' && answer.reason === 'http_429') {
        const asked = typeof answer.retryAfterMs === 'number' && answer.retryAfterMs > 0 ? answer.retryAfterMs : 0;
        s.until = now + Math.min(LIVENESS_HOST_PAUSE_MAX_MS, Math.max(LIVENESS_HOST_PAUSE_MS, asked));
        s.failures = 0;
      } else if (answer.kind === 'error' && isHostFailure(answer.reason)) {
        s.failures += 1;
        if (s.failures >= LIVENESS_HOST_FAILURES_TO_PAUSE) {
          s.until = now + LIVENESS_HOST_PAUSE_MS;
          s.failures = 0;
        }
      } else {
        s.failures = 0;
      }
      state.set(host, s);
    },
    clear() {
      state.clear();
      sent.clear();
    },
  };
}

const processCache = createLivenessCache();
const processHosts = createLivenessHosts();
const inFlight = new Map<string, Promise<CachedAnswer>>();

/** Test seam: forget every answer, every pause and every open request of this process. */
export function resetLivenessForTests(): void {
  processCache.clear();
  processHosts.clear();
  inFlight.clear();
}

export interface LivenessDeps {
  fetch?: FetchLike;
  env?: EnvSource;
  now?: () => Date;
  timeoutMs?: number;
  /** The answers to reuse (default: this process's). */
  cache?: LivenessCache;
  /** The hosts' back-off (default: this process's). */
  hosts?: LivenessHosts;
  /** Requests open at once (default LIVENESS_MAX_IN_FLIGHT). */
  maxInFlight?: number;
}

const unknown = (reason: string, requested = false): LiveResult => ({ state: 'unknown', checkedAt: null, via: null, reason, requested });

function fromAnswer(answer: CachedAnswer, requested: boolean): LiveResult {
  if (answer.state === 'unknown') return unknown(requested ? answer.reason : 'cached', requested);
  return { state: answer.state, checkedAt: new Date(answer.at), via: 'ats_api', reason: requested ? answer.reason : 'cached', requested };
}

function readAnswer(target: PostingTarget, answer: PostingAnswer, at: number): CachedAnswer {
  if (answer.kind === 'not_found') {
    // Where a wrong-case tenant answers the same 404 as a closed posting, only the board's own spelling makes it "closed".
    const sure = !POSTING_ENDPOINTS[target.ats].tenantCaseMatters || target.spelling === 'board';
    return sure ? { state: 'closed', reason: 'not_found', at } : { state: 'unknown', reason: 'not_found_unconfirmed', at };
  }
  if (answer.kind === 'error') return { state: 'unknown', reason: answer.reason, at };
  return POSTING_ENDPOINTS[target.ats].lists(answer.body, target.postingId) ? { state: 'open', reason: 'listed', at } : { state: 'unknown', reason: 'unexpected_shape', at };
}

/** May this row be asked about at all? (Public third-party rows only: never a user's import, never a bank's row.) */
export function livenessApplies(job: Pick<LivenessJob, 'visibility' | 'sourceBoard' | 'fromRecruiterBank'>): boolean {
  return job.visibility === 'public' && job.fromRecruiterBank !== true && job.sourceBoard !== 'user_import';
}

/**
 * Is this the ATS's own board row of the posting `key` names? (A row of our
 * board sync: its board is the ATS and its `externalId` is the key.) Only this
 * row's `lastSeenAt` is the ATS's own sighting, and only this row is reopened
 * by its source listing the posting again.
 */
export function isBoardRowOfKey(job: Pick<LivenessJob, 'sourceBoard' | 'externalId'>, key: string | null | undefined): boolean {
  const k = typeof key === 'string' ? key.trim().toLowerCase() : '';
  return !!k && typeof job.externalId === 'string' && atsPostingKeyFromBoardRow(job.sourceBoard, job.externalId) === k;
}

/**
 * Is the posting still listed? See the header. Never throws and never writes:
 * pass the result to `applyLiveness`.
 */
export async function checkPostingLive(job: LivenessJob, deps: LivenessDeps = {}): Promise<LiveResult> {
  const env = deps.env ?? process.env;
  if (!livenessEnabled(env)) return unknown('disabled');
  if (!livenessApplies(job)) return unknown('not_checked');
  const closedAt = job.closedAt ?? job.archivedAt ?? null;
  if (closedAt) return { state: 'closed', checkedAt: new Date(closedAt), via: 'sync', reason: 'row_closed', requested: false };

  const outcome = postingTargetOf(job);
  // Decided before any shortcut: a row with no usable key is never "confirmed" by this check.
  if (!outcome.ok && outcome.reason !== 'tenant_case_unknown') return unknown(outcome.reason);
  const key = (job.atsPostingKey ?? '').trim().toLowerCase();

  const clock = deps.now ?? (() => new Date());
  const nowMs = clock().getTime();
  const recheckMs = livenessRecheckHours(env) * HOUR_MS;
  const cache = deps.cache ?? processCache;
  const cached = cache.get(key, nowMs, recheckMs);
  // Only the ATS's own board row carries the ATS's sighting in `lastSeenAt`; any other source's sighting proves nothing here.
  const ownSighting = isBoardRowOfKey(job, key) && job.lastSeenAt ? new Date(job.lastSeenAt).getTime() : null;
  // The posting was found gone a moment ago: that stands unless the ATS's own board has listed it since.
  if (cached?.state === 'closed' && !(ownSighting !== null && ownSighting > cached.at)) return fromAnswer(cached, false);
  if (ownSighting !== null && nowMs - ownSighting < recheckMs && ownSighting <= nowMs) {
    return { state: 'open', checkedAt: new Date(ownSighting), via: 'sync', reason: 'seen_recently', requested: false };
  }
  if (cached) return fromAnswer(cached, false);
  if (!outcome.ok) return unknown(outcome.reason);
  const { target } = outcome;

  const open = inFlight.get(key);
  if (open) return fromAnswer(await open, false);
  const host = POSTING_ENDPOINTS[target.ats].host;
  const hosts = deps.hosts ?? processHosts;
  // The host said to slow down, or stopped answering: it is left alone, and this posting is asked about after the pause.
  if (hosts.pausedUntil(host, nowMs) > nowMs) return unknown('host_paused');
  if (inFlight.size >= (deps.maxInFlight ?? LIVENESS_MAX_IN_FLIGHT)) return unknown('busy');
  // One process sends a host a bounded number of new requests a minute, whoever asks. Not remembered: asked again once there is room.
  if (!hosts.admit(host, nowMs)) return unknown('host_budget');

  const market: Market = job.market === 'cn' ? 'cn' : 'intl';
  const pending = requestPosting(target.url, { fetch: deps.fetch, timeoutMs: deps.timeoutMs, market, env, now: clock })
    .catch((): PostingAnswer => ({ kind: 'error', reason: 'network' }))
    .then((answer) => {
      const at = clock().getTime();
      hosts.record(host, answer, at);
      const read = readAnswer(target, answer, at);
      cache.set(key, read);
      return read;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, pending);
  return fromAnswer(await pending, true);
}

// ── Writing the answer ────────────────────────────────────────────────────

export type LivenessDb = Pick<typeof prisma, 'rAJob'>;

export interface ApplyLivenessOptions {
  /**
   * The dedupe repair of the groups whose row was archived (ingest
   * `applyDedupe(db, market, keys)`). Absent → the daily maintenance repairs
   * them (the archive moves `updatedAt`, which is what it reads).
   */
  repairDedupe?: (market: Market, dedupeKeys: string[]) => Promise<unknown>;
  log?: (message: string, meta: Record<string, unknown>) => void;
}

export interface AppliedLiveness {
  /** Rows archived by this answer (this row and the other rows of the same posting). */
  archived: number;
  /** This row's `lastSeenAt` was moved to the moment of the check. */
  refreshed: boolean;
}

/** The one writer of a liveness answer (the header has the rule). Idempotent: an archived row is never written again. */
export async function applyLiveness(db: LivenessDb, job: LivenessJob, result: LiveResult, opts: ApplyLivenessOptions = {}): Promise<AppliedLiveness> {
  const none: AppliedLiveness = { archived: 0, refreshed: false };
  // Only what the ATS's API said is written; an answer from our own records changes nothing.
  if (result.via !== 'ats_api' || !result.checkedAt || !livenessApplies(job)) return none;
  const at = result.checkedAt;

  if (result.state === 'open') {
    // The row in hand already says so (an answer reused from this process's memory): nothing to write.
    if (job.lastSeenAt && new Date(job.lastSeenAt).getTime() >= at.getTime()) return none;
    const res = await db.rAJob.updateMany({
      where: { id: job.id, archivedAt: null, closedAt: null, lastSeenAt: { lt: at } },
      data: { lastSeenAt: at },
    });
    return { archived: 0, refreshed: res.count > 0 };
  }
  if (result.state !== 'closed') return none;

  const key = (job.atsPostingKey ?? '').trim().toLowerCase();
  const open = { visibility: 'public', archivedAt: null, closedAt: null, fromRecruiterBank: false, sourceBoard: { not: 'user_import' } } as const;
  // This row, and every other open public row that names the same posting.
  const rows = await db.rAJob.findMany({
    where: key ? { ...open, OR: [{ id: job.id }, { atsPostingKey: key }] } : { ...open, id: job.id },
    select: { id: true, market: true, dedupeKey: true, sourceBoard: true, externalId: true },
    take: TWIN_LIMIT,
  });
  if (!rows.length) return none;
  // Who may reopen each row: the board's own listing reopens the board's row; nothing reopens another source's copy.
  const boardIds = rows.filter((r) => isBoardRowOfKey(r, key)).map((r) => r.id);
  const otherIds = rows.filter((r) => !isBoardRowOfKey(r, key)).map((r) => r.id);
  let archived = 0;
  for (const [ids, closeReason] of [
    [boardIds, LIVENESS_BOARD_CLOSE_REASON],
    [otherIds, LIVENESS_CLOSE_REASON],
  ] as const) {
    if (!ids.length) continue;
    const res = await db.rAJob.updateMany({ where: { ...open, id: { in: ids } }, data: { archivedAt: at, closedAt: at, closeReason } });
    archived += res.count;
  }
  if (archived > 0 && opts.repairDedupe) {
    const byMarket = new Map<Market, Set<string>>();
    for (const r of rows) {
      if (!r.dedupeKey || (r.market !== 'intl' && r.market !== 'cn')) continue;
      byMarket.set(r.market, (byMarket.get(r.market) ?? new Set<string>()).add(r.dedupeKey));
    }
    for (const [market, keys] of byMarket) {
      try {
        await opts.repairDedupe(market, [...keys]);
      } catch (err) {
        // The rows are archived either way; the daily maintenance repairs the group.
        opts.log?.('liveness: dedupe repair failed after an archive', { market, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { archived, refreshed: false };
}
