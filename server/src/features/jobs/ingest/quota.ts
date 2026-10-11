// server/src/features/jobs/ingest/quota.ts — one budget per metered provider (MKT-3A;
// MARKET_STRATEGY §1.1, §1.2 "Until the licensed feed is bought", JI-1, JC-6).
//
// A RapidAPI plan is a MONTHLY quota that ingest, the Assistant and the
// job-search API share. This module is the one place that knows it:
//
//   1. Reading. Both provider clients (raRapidApiJobs.ts, raFantasticJobs.ts)
//      report what every upstream response said: requests limit / remaining,
//      seconds to reset, jobs limit / remaining, the plan's name on a 429.
//      The latest reading per provider is kept in memory and stored in ONE
//      AppConfig row (quotaContract.ts: `jobs.providerQuota.v1`), at once when
//      the state changes and otherwise at most once a minute per provider.
//      The write is conditional on the row still being what was read, so two
//      processes never overwrite each other's reading. A reading that closes
//      or reopens a provider is waited for (briefly) by a person's own search,
//      so it is stored before a serverless function is frozen.
//      `hydrateProviderQuota` loads the stored row, so a process that made no
//      call itself answers the same way.
//   2. Deciding. `quotaAllows(provider, purpose)`: ingest stops while the plan
//      is used up, refused or down to its reserve; a person's own search stops
//      only at zero or a refused key. A used-up plan blocks until the reset the
//      provider stated; a refused key or a missing subscription blocks for an
//      hour at a time (the reset in its headers says when the quota refills,
//      not when the key is fixed). The clients ask through the call gate
//      registered here, so no client keeps a counter of its own.
//   3. Counting. A call is one row increment in RAProviderUsage under
//      `usageKey(provider, market)` (`activejobs` / `activejobs:cn`): ingest
//      reserves it before the call (`reserveProviderCall`); a call that ingest
//      did not make is counted by the gate. One row, so an onboarding search
//      and an ingest query of the same day add up.
//
// Honesty (D3): every number is one the provider stated. A value it did not
// state is null and decides nothing. The API key is never read, stored or
// logged here.
//
// Importing this module registers the listener and the gate with both clients
// (ingest/index.ts and ingest/cron.ts import it; cron/handlers.ts loads
// ingest/cron.js at process start), so callers outside ingest are covered
// without importing ingest themselves.

import prisma from '../../../lib/prisma.js';
import { logger } from '../../../services/LoggerService.js';
import { getCurrentBrandOrDefault, type EnvSource, type Market } from '../../../platform/brand/index.js';
import { setCallGate as setFantasticCallGate, setQuotaListener as setFantasticQuotaListener } from '../../../roboapply/v2/lib/raFantasticJobs.js';
import { setCallGate as setJSearchCallGate, setQuotaListener as setJSearchQuotaListener } from '../../../roboapply/v2/lib/raRapidApiJobs.js';
import type { ProviderCallGate, ProviderCallPurpose, ProviderQuotaListener, ProviderQuotaObservation } from '../../../roboapply/v2/lib/raExternalJobTypes.js';
import type { IngestProvider } from '../sources/index.js';
import { dailyCallLimit, effectiveDailyLimit, quotaRecheckMs, quotaReserve, setQuotaReader } from './config.js';
import { dayKey, type IngestDb } from './db.js';
import {
  PROVIDER_QUOTA_CONFIG_KEY,
  parseProviderQuota,
  serializeProviderQuota,
  usageKey,
  type ProviderQuotaSnapshot,
  type ProviderQuotaState,
} from './quotaContract.js';

const TAG = 'JOBS_QUOTA';

/** An unchanged state is stored at most this often per provider. */
export const QUOTA_PERSIST_INTERVAL_MS = 60_000;
/** `lastCallCost` is the header delta only when the previous reading is younger than this. */
export const QUOTA_COST_WINDOW_MS = 60_000;
/**
 * How long a refusal (the key refused, no subscription) and a reading without
 * a stated reset time keep blocking calls. The clients' circuit breakers use
 * the same hour: one call an hour re-reads the plan.
 */
export const QUOTA_RETRY_MS = 60 * 60 * 1000;
/**
 * The longest a quota stop parks a provider's due queries in one go
 * (`quotaParkUntil`). Parked queries come due once in this time, find the
 * quota still closed (one lease and one statement, no provider call) and are
 * parked again; when a reading has reopened the plan in the meantime (a new
 * period, a bigger plan, a key fixed, INGEST_QUOTA_RECHECK_HOURS) they run,
 * without anybody having to release them.
 */
export const QUOTA_PARK_MAX_MS = 24 * 60 * 60 * 1000;
/** How often a stored reading is re-read and written again when another process wrote in between. */
export const QUOTA_WRITE_ATTEMPTS = 3;

/** States in which the provider serves nothing. */
const CLOSED: ReadonlySet<ProviderQuotaState> = new Set(['exhausted', 'not_subscribed', 'unauthorized']);
/** Closed states that say the key or the subscription is wrong: nothing in them says when that ends. */
const REFUSED: ReadonlySet<ProviderQuotaState> = new Set(['not_subscribed', 'unauthorized']);

/**
 * Providers a metered call may ever be made to for market cn (JC-6). JSearch
 * is never one: its country=cn rows carry no apply link and misstate their
 * source (MARKET_STRATEGY M-6, §1.6).
 */
const MAINLAND_CALLABLE: ReadonlySet<string> = new Set(['activejobs']);

export type QuotaDb = Pick<IngestDb, 'appConfig' | '$queryRaw' | '$executeRaw'>;

interface QuotaDeps {
  db?: QuotaDb;
  now?: () => Date;
  env?: EnvSource;
  market?: () => Market;
}

let deps: QuotaDeps = {};
const snapshots = new Map<string, ProviderQuotaSnapshot>();
const lastPersistAt = new Map<string, number>();
let pending: Promise<void> = Promise.resolve();

const db = (): QuotaDb => deps.db ?? prisma;
const clock = (): Date => deps.now?.() ?? new Date();
const envSource = (): EnvSource => deps.env ?? process.env;

function ms(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : Number.NaN;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : 'error';
}

// ── Reading ──────────────────────────────────────────────────────────────

/**
 * A snapshot as it counts at `now`: once the reset time the provider stated
 * has passed, the old period's numbers say nothing about the new one, so the
 * state is 'unknown' and the remaining counts are null until a new response
 * arrives. Limits and the plan name are kept (they describe the plan).
 */
function liveView(snapshot: ProviderQuotaSnapshot, now: Date): ProviderQuotaSnapshot {
  const reset = ms(snapshot.resetAt);
  if (!Number.isFinite(reset) || reset > now.getTime()) return snapshot;
  return { ...snapshot, state: 'unknown', requestsRemaining: null, jobsRemaining: null, lastCallCost: null };
}

/** The state a response puts the provider in; a response that says nothing about the plan keeps the previous one. */
function stateFrom(o: ProviderQuotaObservation, previous: ProviderQuotaState): ProviderQuotaState {
  if (o.status === 401) return 'unauthorized';
  if (o.status === 403) return o.reason === 'not_subscribed' ? 'not_subscribed' : 'unauthorized';
  if (o.status === 429) {
    // A per-second burst limit is not a spent plan.
    return o.reason === 'monthly_quota' || o.requestsRemaining === 0 || o.jobsRemaining === 0 ? 'exhausted' : previous;
  }
  // A served call whose own headers say nothing is left has used the plan up (the contract's 'ok' means quota remains).
  if (o.status >= 200 && o.status < 300) return o.requestsRemaining === 0 || o.jobsRemaining === 0 ? 'exhausted' : 'ok';
  return previous;
}

/**
 * Takes one response's reading into the snapshot of its provider and stores
 * it when due (in the background). The clients' listener (`quotaListener`)
 * and a feed client that reports its own responses call it; it never throws.
 */
export function recordQuotaObservation(o: ProviderQuotaObservation): ProviderQuotaSnapshot | null {
  try {
    const at = o.at instanceof Date && Number.isFinite(o.at.getTime()) ? o.at : clock();
    const stored = snapshots.get(o.provider) ?? null;
    const prev = stored ? liveView(stored, at) : null;
    const state = stateFrom(o, prev?.state ?? 'unknown');
    // A key with no subscription has no plan numbers: what an earlier plan said is not carried over.
    const keep = state === 'not_subscribed' || state === 'unauthorized' ? null : prev;
    const resetAt =
      o.resetSeconds !== null ? new Date(at.getTime() + o.resetSeconds * 1000).toISOString() : keep && ms(keep.resetAt) > at.getTime() ? keep.resetAt : null;
    const previousAt = stored ? ms(stored.observedAt) : Number.NaN;
    const delta =
      prev && prev.requestsRemaining !== null && o.requestsRemaining !== null && at.getTime() - previousAt < QUOTA_COST_WINDOW_MS && at.getTime() >= previousAt
        ? prev.requestsRemaining - o.requestsRemaining
        : null;
    // A plan name is only what the provider itself said (a 429 body). It is carried to later readings of
    // the same plan; once the stated request limit differs, the plan changed and the old name is not kept.
    const samePlan = !!keep && (o.requestsLimit === null || keep.requestsLimit === null || o.requestsLimit === keep.requestsLimit);
    const next: ProviderQuotaSnapshot = {
      provider: o.provider,
      plan: o.plan ?? (samePlan ? (keep?.plan ?? null) : null),
      requestsLimit: o.requestsLimit ?? keep?.requestsLimit ?? null,
      requestsRemaining: o.requestsRemaining ?? keep?.requestsRemaining ?? null,
      jobsLimit: o.jobsLimit ?? keep?.jobsLimit ?? null,
      jobsRemaining: o.jobsRemaining ?? keep?.jobsRemaining ?? null,
      resetAt,
      observedAt: at.toISOString(),
      lastStatus: o.status,
      lastCallCost: delta !== null && delta >= 0 ? delta : null,
      state,
    };
    snapshots.set(o.provider, next);
    const last = lastPersistAt.get(o.provider);
    // A changed state (as it counts now: a reading whose period has ended is 'unknown') is stored at once.
    if (!prev || prev.state !== next.state || last === undefined || at.getTime() - last >= QUOTA_PERSIST_INTERVAL_MS) {
      lastPersistAt.set(o.provider, at.getTime());
      enqueue(() => persistProviderQuota());
    }
    return next;
  } catch (err) {
    logger.warn(TAG, 'quota reading not recorded', { provider: o?.provider, error: errorText(err) });
    return null;
  }
}

/** Runs writes one after another; a failed write never rejects the chain. */
function enqueue(task: () => Promise<void>): void {
  pending = pending.then(task).catch((err) => {
    logger.warn(TAG, 'quota write failed', { error: errorText(err) });
  });
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Stores the map in its AppConfig row. The stored row is read and merged
 * first, newest reading per provider winning, and the write happens only if
 * the row is still what was read (compared by its text; a new row only if
 * there is still none). When another process wrote in between, the row is
 * read, merged and written again, so a reading another process stored is
 * never replaced by an older copy of it.
 */
async function persistProviderQuota(): Promise<void> {
  const store = db();
  for (let attempt = 0; attempt < QUOTA_WRITE_ATTEMPTS; attempt += 1) {
    const row = await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY }, select: { value: true } });
    adopt(parseProviderQuota(row?.value ?? null));
    const value = serializeProviderQuota(snapshots);
    if (!row) {
      try {
        await store.appConfig.create({ data: { key: PROVIDER_QUOTA_CONFIG_KEY, value, updatedBy: 'jobs-quota' } });
        return;
      } catch (err) {
        // Another process created the row since the read: merge with it.
        if (!isUniqueViolation(err)) throw err;
        continue;
      }
    }
    // Nothing this process knows is newer than what is stored.
    if (row.value === value) return;
    const written = await store.appConfig.updateMany({ where: { key: PROVIDER_QUOTA_CONFIG_KEY, value: row.value }, data: { value, updatedBy: 'jobs-quota' } });
    if (written.count > 0) return;
  }
  logger.warn(TAG, 'quota reading not stored: the row kept changing', { attempts: QUOTA_WRITE_ATTEMPTS });
}

/** Takes stored snapshots into memory where memory holds none or an older one. */
function adopt(stored: ReadonlyMap<string, ProviderQuotaSnapshot>): void {
  for (const [provider, snapshot] of stored) {
    const mine = snapshots.get(provider);
    if (!mine || ms(snapshot.observedAt) > ms(mine.observedAt)) snapshots.set(provider, snapshot);
  }
}

/**
 * Loads the stored snapshots into memory (one AppConfig read; never throws).
 * Called at the start of jobs-plan, jobs-ingest, the `ingest.query` worker and
 * targeted ingest, so a process that has not called a provider itself knows
 * what the last response anywhere said.
 */
export async function hydrateProviderQuota(store: Pick<QuotaDb, 'appConfig'> = db()): Promise<void> {
  try {
    const row = await store.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY }, select: { value: true } });
    adopt(parseProviderQuota(row?.value ?? null));
  } catch (err) {
    logger.warn(TAG, 'stored quota not read', { error: errorText(err) });
  }
}

/** Waits for the writes started so far (readings and counted calls). Never throws. */
export async function flushProviderQuota(): Promise<void> {
  await pending;
}

// ── Deciding ─────────────────────────────────────────────────────────────

/** The provider's reading as it counts at `now` (see liveView), or null when there is none. */
export function quotaSnapshot(provider: string, now: Date = clock()): ProviderQuotaSnapshot | null {
  const snapshot = snapshots.get(provider);
  return snapshot ? liveView(snapshot, now) : null;
}

/** Every provider's reading as it counts at `now`. */
export function providerQuotaSnapshots(now: Date = clock()): Map<string, ProviderQuotaSnapshot> {
  return new Map([...snapshots.entries()].map(([provider, snapshot]) => [provider, liveView(snapshot, now)]));
}

/**
 * Until when a reading blocks calls. Null = it blocks nothing now.
 *
 *   - a used-up plan, or one down to its reserve: until the reset time the
 *     provider stated (QUOTA_RETRY_MS after the reading when it stated none);
 *   - a refused key or a missing subscription: QUOTA_RETRY_MS after the
 *     reading, whatever reset its headers carry. That reset says when the
 *     quota refills, not when the key or the subscription is put right, so
 *     one call an hour asks again (the snapshot keeps `resetAt` for display);
 *   - either is cut short by INGEST_QUOTA_RECHECK_HOURS when that is set.
 */
function blockedUntil(snapshot: ProviderQuotaSnapshot, now: Date, env: EnvSource): Date | null {
  const observed = ms(snapshot.observedAt);
  if (!Number.isFinite(observed)) return null;
  const reset = ms(snapshot.resetAt);
  let until = !REFUSED.has(snapshot.state) && Number.isFinite(reset) ? reset : observed + QUOTA_RETRY_MS;
  const recheck = quotaRecheckMs(env);
  if (recheck > 0) until = Math.min(until, observed + recheck);
  return until > now.getTime() ? new Date(until) : null;
}

/**
 * May a call be made to the provider right now?
 *
 *   ingest       refused while the plan is used up (until the reset the
 *                provider stated), while the key is refused or the API not
 *                subscribed (for an hour after each such answer), and while
 *                the remaining requests are at or under the reserve
 *                `max(1, ceil(requestsLimit × INGEST_QUOTA_RESERVE_SHARE))`;
 *   interactive  (a person's own search) refused only in those closed states
 *                or at zero remaining.
 *
 * With no reading, or one that has stopped blocking (`blockedUntil`), both
 * are allowed.
 */
export function quotaAllows(provider: string, purpose: ProviderCallPurpose, now: Date = clock(), env: EnvSource = envSource()): boolean {
  const snapshot = quotaSnapshot(provider, now);
  if (!snapshot || !blockedUntil(snapshot, now, env)) return true;
  return !stops(snapshot, purpose, env);
}

/** What a reading says by itself (whether it still blocks is `blockedUntil`): a closed state, or too few requests left for the purpose. */
function stops(snapshot: ProviderQuotaSnapshot, purpose: ProviderCallPurpose, env: EnvSource): boolean {
  if (CLOSED.has(snapshot.state)) return true;
  if (snapshot.requestsRemaining === null) return false;
  const floor = purpose === 'ingest' ? quotaReserve(snapshot.requestsLimit, env) : 0;
  return snapshot.requestsRemaining <= floor;
}

/**
 * The reading the day's budget is computed from (config.ts
 * `effectiveDailyLimit`). None while a reading that stopped ingest has
 * stopped blocking (its hour, or the INGEST_QUOTA_RECHECK_HOURS window, is
 * over): the next call is the one that re-reads the plan, and a day's cap of
 * zero computed from the old numbers must not refuse exactly that call.
 */
function budgetReading(provider: string, now: Date, env: EnvSource): ProviderQuotaSnapshot | null {
  const snapshot = quotaSnapshot(provider, now);
  if (!snapshot) return null;
  return stops(snapshot, 'ingest', env) && !blockedUntil(snapshot, now, env) ? null : snapshot;
}

/**
 * When ingest should look at the provider again after `quotaAllows(…,
 * 'ingest')` answered false: the time the reading stops blocking. Null when
 * nothing blocks.
 */
export function quotaRetryAt(provider: string, now: Date = clock(), env: EnvSource = envSource()): Date | null {
  const snapshot = quotaSnapshot(provider, now);
  return snapshot ? blockedUntil(snapshot, now, env) : null;
}

/**
 * Until when ingest parks the due queries of a provider whose quota stops it:
 * the time the reading stops blocking (`quotaRetryAt`; an hour ahead when
 * nothing says), but never more than QUOTA_PARK_MAX_MS ahead. A plan that is
 * used up for weeks is therefore looked at once a day, at the cost of one
 * lease and one statement, and its queries run within a day of the plan
 * reopening instead of staying parked at a reset time that no longer counts.
 */
export function quotaParkUntil(provider: string, now: Date = clock(), env: EnvSource = envSource()): Date {
  const retryAt = quotaRetryAt(provider, now, env)?.getTime() ?? now.getTime() + QUOTA_RETRY_MS;
  return new Date(Math.min(retryAt, now.getTime() + QUOTA_PARK_MAX_MS));
}

// ── Counting (RAProviderUsage: one row per usage key and UTC day) ─────────

/** Atomically reserves one call against the day's limit of a usage key. False = the day is spent. */
export async function reserveProviderCall(store: Pick<IngestDb, '$queryRaw'>, provider: string, day: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false;
  const rows = await store.$queryRaw<Array<{ calls: number }>>`
    INSERT INTO "RAProviderUsage" ("provider", "dayKey", "calls") VALUES (${provider}, ${day}, 1)
    ON CONFLICT ("provider", "dayKey") DO UPDATE SET "calls" = "RAProviderUsage"."calls" + 1
    WHERE "RAProviderUsage"."calls" < ${limit}::int
    RETURNING "calls"`;
  return rows.length > 0;
}

/** Adds calls and yield counters to the day's usage row of a usage key. */
export async function recordProviderUsage(
  store: Pick<IngestDb, '$executeRaw'>,
  provider: string,
  day: string,
  counts: { calls?: number; returned?: number; inserted?: number; errors?: number },
): Promise<void> {
  const calls = counts.calls ?? 0;
  const returned = counts.returned ?? 0;
  const inserted = counts.inserted ?? 0;
  const errors = counts.errors ?? 0;
  await store.$executeRaw`
    INSERT INTO "RAProviderUsage" ("provider", "dayKey", "calls", "jobsReturned", "jobsNew", "errors")
    VALUES (${provider}, ${day}, ${calls}::int, ${returned}::int, ${inserted}::int, ${errors}::int)
    ON CONFLICT ("provider", "dayKey") DO UPDATE SET
      "calls" = "RAProviderUsage"."calls" + EXCLUDED."calls",
      "jobsReturned" = "RAProviderUsage"."jobsReturned" + EXCLUDED."jobsReturned",
      "jobsNew" = "RAProviderUsage"."jobsNew" + EXCLUDED."jobsNew",
      "errors" = "RAProviderUsage"."errors" + EXCLUDED."errors"`;
}

let askedForMarket: Market | null = null;

/**
 * Runs a synchronous question (an adapter's `isEnabled()`, which asks the gate
 * with `probe`) as a call for `market` would be answered, whatever brand the
 * current request belongs to. A source's health is a fact about the source in
 * its own market: an admin on the GoApply host who lists RoboApply's sources
 * must not read them as off because mainland requests may not call them.
 * `ask` must not await: the market is set for the duration of the call only.
 */
export function answerForMarket<T>(market: Market, ask: () => T): T {
  const previous = askedForMarket;
  askedForMarket = market;
  try {
    return ask();
  } finally {
    askedForMarket = previous;
  }
}

function currentMarket(): Market {
  if (askedForMarket) return askedForMarket;
  try {
    return deps.market?.() ?? getCurrentBrandOrDefault().market;
  } catch {
    return 'intl';
  }
}

/**
 * The gate both clients ask before an upstream call (and, with `probe`, from
 * `isEnabled()`).
 *
 *   - An ingest call was already counted by `reserveProviderCall`: the gate
 *     only answers the quota question.
 *   - Any other call is a person's own search in the brand of the request (a
 *     source's own `isEnabled()` asks for its own market: `answerForMarket`). For
 *     market cn it is refused unless the provider may serve the mainland and
 *     its mainland budget is open (default: closed). A daily bound the
 *     operator set to 0 refuses it too (the bound is the provider's one
 *     budget; 0 has always meant "no calls"). An allowed call is counted once
 *     in today's usage row, the same row ingest reserves in.
 */
export const providerCallGate: ProviderCallGate = (provider, purpose, opts) => {
  const now = clock();
  const env = envSource();
  if (purpose === 'ingest') return quotaAllows(provider, 'ingest', now, env);
  const market = currentMarket();
  if (market === 'cn' && !(MAINLAND_CALLABLE.has(provider) && (effectiveDailyLimit(provider as IngestProvider, 'cn', env, now) ?? 0) > 0)) return false;
  if (dailyCallLimit(provider as IngestProvider, env) === 0) return false;
  if (!quotaAllows(provider, 'interactive', now, env)) return false;
  if (opts?.probe !== true) {
    const key = usageKey(provider, market);
    const day = dayKey(now);
    enqueue(() => recordProviderUsage(db(), key, day, { calls: 1 }));
  }
  return true;
};

/**
 * The listener both clients call with every upstream response. A reading that
 * closes a provider, or reopens one, changes what every other process may do:
 * for such a reading the listener answers with the write of it, and a client
 * serving a person's own search waits for that (briefly) before it returns.
 * Without the wait a serverless function frozen after its response could keep
 * the reading to itself, and the next cold process would spend a call to
 * learn the same thing. Any other reading answers nothing (stored in the
 * background; an ingest tick awaits its writes itself). Never throws.
 */
export const quotaListener: ProviderQuotaListener = (o) => {
  let closedBefore = false;
  try {
    const stored = snapshots.get(o.provider);
    closedBefore = !!stored && CLOSED.has(liveView(stored, o.at instanceof Date && Number.isFinite(o.at.getTime()) ? o.at : clock()).state);
  } catch {
    closedBefore = false;
  }
  const next = recordQuotaObservation(o);
  if (!next || CLOSED.has(next.state) === closedBefore) return undefined;
  return flushProviderQuota();
};

/** Wires the listener and the gate into both clients (idempotent). */
export function registerQuotaListeners(): void {
  setJSearchQuotaListener(quotaListener);
  setFantasticQuotaListener(quotaListener);
  setJSearchCallGate(providerCallGate);
  setFantasticCallGate(providerCallGate);
  setQuotaReader((provider, now, env) => budgetReading(provider, now, env ?? envSource()));
}

registerQuotaListeners();

// ── Test seams ───────────────────────────────────────────────────────────

/** Injects the store, the clock, the env and the market of a call (tests). */
export function setQuotaDepsForTests(next: QuotaDeps): void {
  deps = next;
}

/** Forgets every reading and pending debounce (tests). */
export function resetProviderQuotaForTests(): void {
  snapshots.clear();
  lastPersistAt.clear();
  pending = Promise.resolve();
  deps = {};
  askedForMarket = null;
}
