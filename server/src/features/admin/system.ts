// server/src/features/admin/system.ts — the System panel (ARCHITECTURE.md §10.4
// "Pipeline health"): ingest, queue, provider calls, enrichment, AI scores,
// alert and email sends, Assistant turns/guard hits/cost and credit
// exhaustion, read live per brand, plus the alert-level check the daily
// health email uses.
//
// Data access sits behind `SystemStore` (Prisma implementation below) so the
// assembly and the alert rules are tested without a database.
//
// Job sources (GOAPPLY_PARITY_PLAN.md §3.9): each brand's panel lists ITS
// sources from the job source registry (the same list ingest runs), with
// whether each is on, how it is reached, what its last run did and why rows
// were skipped. A recruiter bank with no candidate-facing posting page shows
// that its synced rows are not listed, and which setting names the page.
//
// Two day windows (finding: a partial UTC day must not be compared with
// full-day averages and budgets):
//   - 'live' (the System panel): today so far. The ingest rule is prorated by
//     the share of the UTC day that has passed; budget rules compare today's
//     usage with the whole daily budget ("close to the limit already").
//   - 'last_complete_day' (the daily health email, run at 03:30 UTC by
//     jobs-maintain): the whole previous UTC day against the 7 days before it,
//     so a budget used up at 20:00 is still reported the next morning.
// Queue depth, due/overdue queries and open jobs are read as they are now in
// both modes.
//
// Job providers (MARKET_STRATEGY §1.2, JI-1): one row per source of every
// brand the deployment serves (the registry again, so a provider that made no
// call is still listed), merged with the day's `RAProviderUsage` counters and
// with the provider's own quota reading (AppConfig `jobs.providerQuota.v1`,
// written by ingest, only read here). A dead source is therefore visible the
// day it dies: plan, quota left, days to reset and a state. Every quota value
// is the provider's own statement; what it did not state is null.
//
// A brand's sources are always read in that brand's own context
// (`readBrandSources`), whichever host the admin is on and whichever brand a
// cron runs as: an adapter may answer "on or off" for the brand of the unit
// of work (a provider that is never called for the mainland is off there).

import prisma from '../../lib/prisma.js';
import { getBrand, runWithBrand, type BrandId, type EnvSource, type Market, type ProductBrand } from '../../platform/brand/index.js';
import { DAY, windowStartFor } from '../../platform/ratelimit/index.js';
import { NOTIFY_TEMPLATES } from '../alerts/index.js';
import {
  ALERT_LEVELS,
  type AlertHit,
  type BrandHealth,
  type JobSourceRunView,
  type JobSourceView,
  type ProviderAlertState,
  type ProviderCostModel,
  type ProviderState,
  type ProviderUsageRow,
  type QueueKindRow,
  type SystemStatusResponse,
} from './contract.js';
import {
  PROVIDER_QUOTA_CONFIG_KEY,
  bankPublicPageState,
  MAINLAND_CALLABLE,
  daysToReset,
  hydrateProviderQuota,
  parseProviderQuota,
  readSourceStatuses,
  sourcesForBrand,
  usageKey,
  type IngestProvider,
  type JobSourceDescription,
  type ProviderQuotaSnapshot,
  type SourceRunStatus,
  type SourceStatusDoc,
} from '../jobs/ingest/index.js';
import { adapterCostModel, adapterEnabledFor } from '../jobs/sources/index.js';
import { FEED_MIN_MONTHLY_JOBS, copilotDailyBudgetUsd, enrichCounterKey, enrichDailyLimit, mainlandCallBudget, providerDailyLimit, quotaReserve, scoreCounterKeys, scoreDailyBudget } from './limits.js';

const DAY_MS = DAY * 1000;
/** Board rows read to count the boards that feed a site (the board list's own scan bound). */
const CAREER_SOURCE_SCAN = 20_000;
const COPILOT_SKU = 'ra_copilot_turn';
export const JOB_ALERT_TEMPLATES: readonly string[] = [NOTIFY_TEMPLATES.jobAlertInstant, NOTIFY_TEMPLATES.jobAlertDigest];

/** A [since, until) time range. */
export interface TimeRange {
  since: Date;
  until: Date;
}

export interface SystemStore {
  ingestCounts(market: string, now: Date, overdueBefore: Date): Promise<{ due: number; overdue: number; failing: number }>;
  /** Public canonical jobs first seen per UTC day since `since` (missing days = 0). */
  newJobsByDay(market: string, since: Date): Promise<Array<{ day: string; count: number }>>;
  openJobCounts(market: string): Promise<{ open: number; enriched: number }>;
  rateCounter(key: string, windowStart: Date): Promise<number>;
  queueByKind(): Promise<QueueKindRow[]>;
  /** The day's `RAProviderUsage` rows; `provider` is the usage key ('<provider>' or '<provider>:cn'). */
  providerUsage(dayKey: string): Promise<ProviderUsageCounters[]>;
  /**
   * The providers' quota readings by snapshot key (AppConfig
   * `jobs.providerQuota.v1`, parsed with `parseProviderQuota`). Read-only:
   * ingest writes the row. Empty when nothing was recorded.
   */
  providerQuota(): Promise<Map<string, ProviderQuotaSnapshot>>;
  /** Email sends per status in `range`, optionally only these templates. */
  emailStatus(brand: string, range: TimeRange, templates?: readonly string[]): Promise<{ sent: number; failed: number }>;
  emailFailuresByTemplate(brand: string, range: TimeRange, limit: number): Promise<Array<{ template: string; count: number }>>;
  copilotStats(brand: string, range: TimeRange): Promise<{ turns: number; guardHits: number; costUsd: number }>;
  /** Distinct people per bucket in `range`; null when no out-of-credits event was ever recorded for the brand. */
  creditExhaustion(brand: string, range: TimeRange): Promise<Array<{ bucket: string; count: number }> | null>;
  /**
   * Loads the stored quota readings into this process (ingest's
   * `hydrateProviderQuota`: one AppConfig read, never throws), so a source's
   * own "on / off / why" is answered from what the last response anywhere
   * said, not only from what this process happened to see. Optional: a store
   * without it (tests) leaves the process memory as it is.
   */
  hydrateQuota?(): Promise<void>;
  /** The stored run status of each provider in a market (absent = it never ran). */
  sourceStatuses(market: string, providers: readonly string[]): Promise<Map<string, SourceStatusDoc>>;
  /** Public rows of these source boards in a market: open, and archived as 'no_apply_target'. */
  sourceJobCounts(market: string, sourceBoards: readonly string[]): Promise<{ open: number; held: number }>;
  /** The market's career sources (employer boards). */
  careerSourceCounts(market: string): Promise<{ total: number; enabled: number; failing: number }>;
}

/** Lists a brand's sources (default: the registry, with the built-in adapters registered). */
export type SourceLister = (brand: ReturnType<typeof getBrand>, env: EnvSource) => JobSourceDescription[];

/**
 * Reads every source of one brand inside that brand's context, so what an
 * adapter answers (on or off, why, how it is reached) is its answer for THIS
 * brand and not for the brand of the request or cron that asked. `read` runs
 * synchronously per source; it must not defer a question to later.
 */
function readBrandSources<T>(brandId: BrandId, env: EnvSource, list: SourceLister, read: (source: JobSourceDescription, brand: ProductBrand) => T): T[] {
  const brand = getBrand(brandId);
  return runWithBrand(brandId, () => list(brand, env).map((source) => read(source, brand)));
}

function runView(run: SourceRunStatus | null | undefined): JobSourceRunView | null {
  if (!run) return null;
  return { at: run.at, ok: run.ok, error: run.error, received: run.received, written: run.written, inserted: run.inserted, closed: run.closed, skipped: run.skipped, notes: { ...run.notes } };
}

/** One `RAProviderUsage` row of a day. */
export interface ProviderUsageCounters {
  provider: string;
  calls: number;
  jobsReturned: number;
  jobsNew: number;
  errors: number;
}

/** A brand's job sources with their state (the admin sources panel). */
export async function jobSourcesHealth(store: SystemStore, brandId: BrandId, env: EnvSource = process.env, list: SourceLister = sourcesForBrand): Promise<JobSourceView[]> {
  const brand = getBrand(brandId);
  // A metered adapter answers "on / off / why" from the quota readings in process memory. A function
  // instance that has made no provider call and run no cron since it started holds none, and would
  // read a used-up provider as on while the provider table of the same response (built from the
  // stored row) says exhausted: load the stored readings first.
  await store.hydrateQuota?.();
  const sources = readBrandSources(brandId, env, list, (source) => ({ source, status: source.status(), publicPage: bankPublicPageState(source.provider, env) }));
  const statuses = await store.sourceStatuses(brand.market, sources.map((s) => s.source.provider));
  return Promise.all(
    sources.map(async ({ source, status, publicPage }): Promise<JobSourceView> => {
      const doc = statuses.get(source.provider) ?? null;
      const [counts, boards] = await Promise.all([
        source.sourceBoards.length ? store.sourceJobCounts(brand.market, source.sourceBoards) : Promise.resolve({ open: 0, held: 0 }),
        source.kind === 'ats' ? store.careerSourceCounts(brand.market) : Promise.resolve(null),
      ]);
      return {
        provider: source.provider,
        kind: source.kind,
        enabled: status.enabled,
        transport: status.transport,
        reason: status.reason,
        lastRun: runView(doc?.last),
        lastCounted: runView(doc?.counted),
        openJobs: counts.open,
        heldJobs: counts.held,
        publicPage,
        boards,
      };
    }),
  );
}

export type HealthMode = 'live' | 'last_complete_day';

export interface HealthWindow {
  mode: HealthMode;
  /** Start of the UTC day covered. */
  start: Date;
  /** End of the range read: now (live) or the end of that day. */
  end: Date;
  dayKey: string;
  /** Share of the UTC day the range covers (0–1); 1 for a complete day. */
  elapsedShare: number;
}

export function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const n = (v: unknown): number => {
  const x = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** The UTC day a health read covers. */
export function healthWindow(now: Date, mode: HealthMode = 'live'): HealthWindow {
  const todayStart = windowStartFor(now, DAY);
  if (mode === 'last_complete_day') {
    const start = new Date(todayStart.getTime() - DAY_MS);
    return { mode, start, end: todayStart, dayKey: dayKeyOf(start), elapsedShare: 1 };
  }
  const elapsedShare = Math.min(1, Math.max(0, (now.getTime() - todayStart.getTime()) / DAY_MS));
  return { mode, start: todayStart, end: now, dayKey: dayKeyOf(todayStart), elapsedShare: Math.round(elapsedShare * 1e4) / 1e4 };
}

/** Brand health for one brand over `window` (default: live, today so far). */
export async function brandHealth(
  store: SystemStore,
  brandId: BrandId,
  now: Date,
  env: EnvSource = process.env,
  window: HealthWindow = healthWindow(now),
  listSources: SourceLister = sourcesForBrand,
): Promise<BrandHealth> {
  const brand = getBrand(brandId);
  const market = brand.market;
  const dayStart = window.start;
  const day: TimeRange = { since: window.start, until: window.end };
  const weekStart = new Date(dayStart.getTime() - 7 * DAY_MS);
  // Email failures: the 24 hours ending at the end of the range (live: the last 24 h; email: the whole day).
  const emailRange: TimeRange = { since: new Date(window.end.getTime() - DAY_MS), until: window.end };
  const overdueBefore = new Date(now.getTime() - ALERT_LEVELS.overdueMinutes * 60_000);

  const [ingest, byDay, open, enrichUsed, scoreUsed, alerts, email, failedByTemplate, copilot, exhaustion, sources] = await Promise.all([
    store.ingestCounts(market, now, overdueBefore),
    store.newJobsByDay(market, weekStart),
    store.openJobCounts(market),
    store.rateCounter(enrichCounterKey(market), dayStart),
    store.rateCounter(scoreCounterKeys.budget(brandId), dayStart),
    store.emailStatus(brandId, day, JOB_ALERT_TEMPLATES),
    store.emailStatus(brandId, emailRange),
    store.emailFailuresByTemplate(brandId, emailRange, 10),
    store.copilotStats(brandId, day),
    store.creditExhaustion(brandId, day),
    jobSourcesHealth(store, brandId, env, listSources),
  ]);

  const today = window.dayKey;
  const counts = new Map(byDay.map((r) => [r.day, r.count]));
  let prior = 0;
  for (let i = 1; i <= 7; i += 1) prior += counts.get(dayKeyOf(new Date(dayStart.getTime() - i * DAY_MS))) ?? 0;

  return {
    brand: brandId,
    market,
    sources,
    ingest: {
      due: ingest.due,
      overdue: ingest.overdue,
      failing: ingest.failing,
      newJobsToday: counts.get(today) ?? 0,
      newJobs7dAvg: Math.round((prior / 7) * 10) / 10,
      openJobs: open.open,
      enrichBacklog: Math.max(0, open.open - open.enriched),
      enrichedShare: open.open > 0 ? Math.round((open.enriched / open.open) * 1000) / 1000 : null,
      enrichBudget: { used: enrichUsed, limit: enrichDailyLimit(env) },
    },
    precompute: { used: scoreUsed, limit: scoreDailyBudget(brandId, env) },
    alerts,
    email: { ...email, failedByTemplate },
    copilot: { ...copilot, costUsd: Math.round(copilot.costUsd * 1e4) / 1e4, budgetUsd: copilotDailyBudgetUsd(brandId, env) },
    creditExhaustion: exhaustion,
  };
}

// ── Job providers: usage, quota and state (JI-1) ─────────────────────────

/** The source the licensed window feed registers as (JI-7); the M-2 plan gate applies to it. */
const LICENSED_FEED_PROVIDER = 'activejobs_feed';
/**
 * A provider that is billed on another provider's plan reads that provider's
 * quota: the licensed feed and the Active Jobs DB search are one subscription.
 */
const QUOTA_ACCOUNT: Readonly<Record<string, string>> = { [LICENSED_FEED_PROVIDER]: 'activejobs' };
/**
 * The reason codes an adapter gives when it is off until a plan allows it: the plan is too small, or
 * nothing states its size yet (ingest/config.ts FEED_GATE_REASON_CODE). Both read as 'gated', never as
 * 'exhausted': a source that never ran raises no quota alert.
 */
const PLAN_GATE_REASONS: ReadonlySet<string> = new Set(['plan_too_small', 'plan_unknown']);
/** The reason code an adapter gives when it is off because the plan's quota does not allow an ingest call now. */
const QUOTA_REASON = 'quota';
/** The registry's code for an adapter that is off and gave no reason of its own. */
const UNSTATED_REASON = 'disabled';
const CN_SUFFIX = ':cn';

/** A source of a served brand, reduced to what a provider row needs. */
export interface ProviderSource {
  provider: string;
  market: Market;
  /** On for this market right now (key present, switches off, guards closed, quota gate open). */
  enabled: boolean;
  /** Why it is off, as the adapter's short code ('disabled' = it gave none); null when on or not stated. */
  reason: string | null;
  costModel: ProviderCostModel;
}

/** A usage key back into its provider and market: a ':cn' suffix is the mainland counter. */
export function parseUsageKey(key: string): { provider: string; market: Market } {
  return key.endsWith(CN_SUFFIX) && key.length > CN_SUFFIX.length ? { provider: key.slice(0, -CN_SUFFIX.length), market: 'cn' } : { provider: key, market: 'intl' };
}

/** The adapter's own short code for why it is off; null when it gives none (or throws). */
function adapterReason(adapter: JobSourceDescription['adapter']): string | null {
  try {
    return adapter?.disabledReason?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * The ingest sources of the served brands, one per (provider, market).
 * `user_import` is not an ingest source and has no usage counter.
 *
 * On or off is the adapter's answer for the market (`adapterEnabledFor`: its
 * `isEnabledFor(market)` when it has one, else `isEnabled()`), the same
 * question ingest asks before it plans or runs a query. A source the registry
 * has no adapter for in this market (not registered, another market's) is off
 * with the registry's reason.
 */
export function providerSources(brands: readonly BrandId[], env: EnvSource = process.env, list: SourceLister = sourcesForBrand): ProviderSource[] {
  const out = new Map<string, ProviderSource>();
  for (const brandId of brands) {
    // Each brand's sources answer inside that brand's context: the rows do not depend on the host the admin is on.
    const sources = readBrandSources(brandId, env, list, (source, brand): ProviderSource | null => {
      if (source.kind === 'import') return null;
      const adapter = source.adapter;
      const status = source.status();
      const enabled = adapter ? adapterEnabledFor(adapter, brand.market) : status.enabled;
      return {
        provider: source.provider,
        market: brand.market,
        enabled,
        // Off for this market only (the registry's status is the adapter's general answer): ask the adapter why.
        reason: enabled ? null : (status.enabled ? adapterReason(adapter) : status.reason),
        costModel: adapterCostModel(adapter ?? { provider: source.provider as IngestProvider }),
      };
    });
    for (const source of sources) {
      if (!source) continue;
      const key = usageKey(source.provider, source.market);
      // Two brands of one market share the counter: the provider is on when either runs it.
      if (!out.get(key)?.enabled) out.set(key, source);
    }
  }
  return [...out.values()];
}

/**
 * The mainland counters the operator opened that no served brand's registry
 * lists. A mainland brand's own searches may call a metered provider once its
 * mainland budget is above 0 (`mainlandCallBudget`), counted under
 * `<provider>:cn`, although the provider is not one of the brand's ingest
 * sources. Such a counter would otherwise show only on a day with calls, and
 * vanish on the day the plan dies (no call is made, so no usage row exists).
 *
 * One source per provider the quota snapshot knows, when a served brand is a
 * mainland brand, the provider may be called for the mainland at all
 * (ingest's `MAINLAND_CALLABLE`: JSearch never is) and its mainland budget is
 * above 0. The operator's own setting decides: a snapshot entry alone never
 * creates a row, and a budget set for a provider that is never called for the
 * mainland creates none either (its counter would never move).
 */
export function mainlandCounterSources(input: {
  brands: readonly BrandId[];
  quota: ReadonlyMap<string, ProviderQuotaSnapshot>;
  listed: readonly ProviderSource[];
  env?: EnvSource;
}): ProviderSource[] {
  if (!input.brands.some((b) => getBrand(b).market === 'cn')) return [];
  const env = input.env ?? process.env;
  const seen = new Set(input.listed.filter((s) => s.market === 'cn').map((s) => s.provider));
  const out: ProviderSource[] = [];
  for (const key of input.quota.keys()) {
    const { provider } = parseUsageKey(key);
    if (seen.has(provider)) continue;
    seen.add(provider);
    const costModel = adapterCostModel({ provider: provider as IngestProvider });
    if (costModel === 'free' || !MAINLAND_CALLABLE.has(provider) || mainlandCallBudget(provider, env) <= 0) continue;
    out.push({ provider, market: 'cn', enabled: true, reason: null, costModel });
  }
  return out;
}

/**
 * The quota reading that applies to a provider in a market: its own entry for
 * the market, else the provider's (one plan serves both markets), else the
 * entry of the provider whose plan it is billed on.
 */
function quotaFor(quota: ReadonlyMap<string, ProviderQuotaSnapshot>, provider: string, market: Market): { snapshot: ProviderQuotaSnapshot; own: boolean } | null {
  const own = quota.get(usageKey(provider, market)) ?? quota.get(provider);
  if (own) return { snapshot: own, own: true };
  const account = QUOTA_ACCOUNT[provider];
  const billed = account ? (quota.get(usageKey(account, market)) ?? quota.get(account)) : undefined;
  return billed ? { snapshot: billed, own: false } : null;
}

const CLOSED_BY_KEY: ReadonlySet<string> = new Set(['not_subscribed', 'unauthorized']);

/** Left is under `quotaLowShare` of the limit, both stated. */
function isLow(remaining: number | null, limit: number | null): boolean {
  return remaining !== null && limit !== null && limit > 0 && remaining < limit * ALERT_LEVELS.quotaLowShare;
}

/**
 * The provider says the period's quota is used up: its reading is 'exhausted'
 * (a 429), or it stated that 0 requests or 0 postings are left. The second
 * form is the call that used the last of the quota: it was served (state
 * 'ok') and nothing can follow it until the reset.
 */
function isUsedUp(reading: Pick<ProviderQuotaSnapshot, 'state' | 'requestsRemaining' | 'jobsRemaining'>): boolean {
  return reading.state === 'exhausted' || reading.requestsRemaining === 0 || reading.jobsRemaining === 0;
}

/**
 * The provider stated a request limit and what is left of it is at or under
 * the share ingest keeps for people's own searches (`quotaReserve`). Ingest
 * makes no call from there on, so its adapter answers "off" although the
 * provider still serves.
 */
function isAtReserve(reading: Pick<ProviderQuotaSnapshot, 'requestsLimit' | 'requestsRemaining'> | null, env: EnvSource): boolean {
  if (!reading || reading.requestsRemaining === null || reading.requestsLimit === null || reading.requestsLimit <= 0) return false;
  return reading.requestsRemaining <= quotaReserve(reading.requestsLimit, env);
}

/**
 * The state of one provider row (contract.ts `ProviderState`). Pure.
 *
 * `reading` is the provider's quota reading, or null when there is none or
 * its period has ended (a reading from before the reset says nothing about
 * this period). `source` is null for a usage row no served brand lists.
 * An unmetered source (bank, employer boards, open data) is only on or off.
 *
 * "Off" has two meanings and only one of them is the state 'disabled'. An
 * adapter that is off for a reason of its own (no key, a kill switch, a
 * missing certificate) is 'disabled'. An adapter that is off because the
 * plan's quota stops ingest is not: the provider still answers, and what the
 * row must show is how much is left ('low', 'exhausted'), the same in a
 * process that holds the reading in memory and in one that does not. The
 * quota is the cause when the adapter says so (reason 'quota'), or when it
 * states no reason while the reading is at or under ingest's reserve
 * (`atReserve`).
 */
export function providerState(input: {
  provider: string;
  costModel: ProviderCostModel;
  source: Pick<ProviderSource, 'enabled' | 'reason'> | null;
  reading: Pick<ProviderQuotaSnapshot, 'state' | 'requestsLimit' | 'requestsRemaining' | 'jobsLimit' | 'jobsRemaining'> | null;
  /** The plan's monthly postings as last stated (kept across a reset: a plan fact, not a period fact). */
  planJobsLimit: number | null;
  /** The reading is at or under the share of the plan ingest never spends (`isAtReserve`). Default false. */
  atReserve?: boolean;
}): ProviderState {
  const { source, reading } = input;
  const off = source !== null && !source.enabled;
  if (input.costModel === 'free') return off ? 'disabled' : 'ok';
  // The key itself is refused: nothing else about the plan matters until that is fixed.
  if (reading && CLOSED_BY_KEY.has(reading.state)) return reading.state as ProviderState;
  // Off until a larger plan exists (M-2): the adapter says so, or the licensed feed's stated plan is under the gate.
  if (off && (PLAN_GATE_REASONS.has(source.reason ?? '') || (input.provider === LICENSED_FEED_PROVIDER && input.planJobsLimit !== null && input.planJobsLimit < FEED_MIN_MONTHLY_JOBS))) {
    return 'gated';
  }
  if (reading && isUsedUp(reading)) return 'exhausted';
  const unstated = off && (source.reason === null || source.reason === UNSTATED_REASON);
  const offForQuota = off && (source.reason === QUOTA_REASON || (unstated && input.atReserve === true));
  if (off && !offForQuota) return 'disabled';
  if (!reading || reading.state === 'unknown') return 'unknown';
  if (isLow(reading.requestsRemaining, reading.requestsLimit) || isLow(reading.jobsRemaining, reading.jobsLimit)) return 'low';
  return 'ok';
}

/**
 * The provider rows of the System status: every source of the served brands
 * (zero counters when it made no call), plus any other usage row of the day
 * (calls that were really made are never hidden), each with its quota
 * reading and state. Sorted by usage key. Pure.
 */
export function buildProviderRows(input: {
  sources: readonly ProviderSource[];
  usage: readonly ProviderUsageCounters[];
  quota: ReadonlyMap<string, ProviderQuotaSnapshot>;
  now: Date;
  env?: EnvSource;
}): ProviderUsageRow[] {
  const env = input.env ?? process.env;
  const sources = new Map(input.sources.map((s) => [usageKey(s.provider, s.market), s]));
  const usage = new Map(input.usage.map((u) => [u.provider, u]));
  const keys = [...new Set([...sources.keys(), ...usage.keys()])].sort((a, b) => a.localeCompare(b));
  return keys.map((key): ProviderUsageRow => {
    const source = sources.get(key) ?? null;
    const { provider, market } = source ?? parseUsageKey(key);
    const counters = usage.get(key);
    const costModel = source?.costModel ?? adapterCostModel({ provider: provider as IngestProvider });
    const found = costModel === 'free' ? null : quotaFor(input.quota, provider, market);
    const snapshot = found?.snapshot ?? null;
    // A reading whose reset time has passed describes the previous period: its plan and limits
    // still stand, what was left then (and the state that followed from it) does not.
    const days = daysToReset(snapshot, input.now);
    const current = snapshot !== null && days !== 0;
    // What ingest decides from is the provider's own reading: its daily budget and its reserve
    // are not those of another source billed on the same plan.
    const own = current && found?.own ? snapshot : null;
    return {
      provider: key,
      market,
      calls: counters?.calls ?? 0,
      limit: providerDailyLimit(provider, market, env, own, input.now),
      jobsReturned: counters?.jobsReturned ?? 0,
      jobsNew: counters?.jobsNew ?? 0,
      errors: counters?.errors ?? 0,
      plan: snapshot?.plan ?? null,
      requestsLimit: snapshot?.requestsLimit ?? null,
      requestsRemaining: current ? snapshot.requestsRemaining : null,
      jobsLimit: snapshot?.jobsLimit ?? null,
      jobsRemaining: current ? snapshot.jobsRemaining : null,
      resetAt: current ? snapshot.resetAt : null,
      daysToReset: current ? days : null,
      observedAt: snapshot?.observedAt ?? null,
      costModel,
      state: providerState({ provider, costModel, source, reading: current ? snapshot : null, planJobsLimit: snapshot?.jobsLimit ?? null, atReserve: isAtReserve(own, env) }),
    };
  });
}

const QUOTA_ALERT_STATES: ReadonlySet<ProviderState> = new Set<ProviderAlertState>(['exhausted', 'not_subscribed', 'unauthorized', 'low']);

/** The `provider_quota` hit of a row, or null (unmetered, or a state that needs no look). */
function quotaAlert(p: ProviderUsageRow): AlertHit | null {
  if (p.costModel === 'free' || !QUOTA_ALERT_STATES.has(p.state)) return null;
  let value = 0;
  let level = 0;
  if (p.state === 'low') {
    const requestsLow = isLow(p.requestsRemaining, p.requestsLimit);
    value = (requestsLow ? p.requestsRemaining : p.jobsRemaining) ?? 0;
    level = Math.ceil(((requestsLow ? p.requestsLimit : p.jobsLimit) ?? 0) * ALERT_LEVELS.quotaLowShare);
  }
  return { key: 'provider_quota', brand: null, subject: p.provider, value, level, state: p.state as ProviderAlertState, daysToReset: p.daysToReset };
}

const overShare = (used: number, limit: number | null) => limit !== null && limit > 0 && used >= limit * ALERT_LEVELS.budgetShare;

/**
 * Metrics past their alert level (ARCH §10.4 "Alerting"). Pure.
 *
 * The ingest rule compares the new jobs in the day so far with the 7-day
 * average prorated by `dayElapsedShare` (1 for a complete day), and stays
 * quiet early in the UTC day (`ingestMinDayShare`) and while the prorated
 * level is under one job.
 *
 * Providers: `provider_budget` compares the day's calls with the row's daily
 * limit, which is the one ingest enforces that day (`providerDailyLimit`);
 * `provider_quota` reports the provider's own monthly quota, one hit per
 * metered provider row that is exhausted, not subscribed, refused or low.
 */
export function evaluateAlerts(status: Pick<SystemStatusResponse, 'brands' | 'queue' | 'providers' | 'dayElapsedShare'>): AlertHit[] {
  const hits: AlertHit[] = [];
  const dayShare = status.dayElapsedShare;
  if (status.queue.deadTotal > ALERT_LEVELS.deadItems) {
    hits.push({ key: 'dead_items', brand: null, subject: null, value: status.queue.deadTotal, level: ALERT_LEVELS.deadItems });
  }
  for (const p of status.providers) {
    if (overShare(p.calls, p.limit)) {
      hits.push({ key: 'provider_budget', brand: null, subject: p.provider, value: p.calls, level: Math.ceil(p.limit! * ALERT_LEVELS.budgetShare) });
    }
    // The provider's own monthly quota (JI-1): used up, refused or nearly gone.
    const quota = quotaAlert(p);
    if (quota) hits.push(quota);
  }
  for (const b of status.brands) {
    const avg = b.ingest.newJobs7dAvg;
    const ingestLevel = avg * dayShare * ALERT_LEVELS.ingestNewShare;
    if (avg >= ALERT_LEVELS.ingestMinAverage && dayShare >= ALERT_LEVELS.ingestMinDayShare && ingestLevel >= 1 && b.ingest.newJobsToday < ingestLevel) {
      hits.push({ key: 'ingest_new_low', brand: b.brand, subject: null, value: b.ingest.newJobsToday, level: Math.ceil(ingestLevel) });
    }
    if (overShare(b.ingest.enrichBudget.used, b.ingest.enrichBudget.limit)) {
      hits.push({ key: 'enrich_budget', brand: b.brand, subject: null, value: b.ingest.enrichBudget.used, level: Math.ceil(b.ingest.enrichBudget.limit! * ALERT_LEVELS.budgetShare) });
    }
    if (overShare(b.precompute.used, b.precompute.limit)) {
      hits.push({ key: 'score_budget', brand: b.brand, subject: null, value: b.precompute.used, level: Math.ceil(b.precompute.limit! * ALERT_LEVELS.budgetShare) });
    }
    if (overShare(b.copilot.costUsd, b.copilot.budgetUsd)) {
      hits.push({ key: 'assistant_budget', brand: b.brand, subject: null, value: b.copilot.costUsd, level: Math.round(b.copilot.budgetUsd * ALERT_LEVELS.budgetShare * 100) / 100 });
    }
    if (b.email.failed > ALERT_LEVELS.emailFailures) {
      hits.push({ key: 'email_failures', brand: b.brand, subject: null, value: b.email.failed, level: ALERT_LEVELS.emailFailures });
    }
  }
  return hits;
}

/** GET /admin/system for the given brands ('live'), or the last complete UTC day for the health email. */
export async function buildSystemStatus(
  store: SystemStore,
  options: { brands: BrandId[]; brandsServed: BrandId[]; now?: Date; env?: EnvSource; mode?: HealthMode; listSources?: SourceLister },
): Promise<SystemStatusResponse> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const window = healthWindow(now, options.mode ?? 'live');
  const dayKey = window.dayKey;
  const [brands, kinds, usage, quota] = await Promise.all([
    Promise.all(options.brands.map((b) => brandHealth(store, b, now, env, window, options.listSources))),
    store.queueByKind(),
    store.providerUsage(dayKey),
    store.providerQuota(),
  ]);
  // Providers are platform-wide: the sources of every brand this deployment serves, whichever brand is shown,
  // plus the mainland counters the operator opened for a provider no mainland brand lists as a source.
  const listed = providerSources(options.brandsServed, env, options.listSources);
  const sources = [...listed, ...mainlandCounterSources({ brands: options.brandsServed, quota, listed, env })];
  const providers = buildProviderRows({ sources, usage, quota, now, env });
  const queue = { kinds: [...kinds].sort((a, b) => b.dead - a.dead || b.queued - a.queued || a.kind.localeCompare(b.kind)), deadTotal: kinds.reduce((s, k) => s + k.dead, 0) };
  const partial = { brands, queue, providers, dayElapsedShare: window.elapsedShare };
  return {
    asOf: now.toISOString(),
    dayKey,
    dayComplete: window.mode === 'last_complete_day',
    ...partial,
    alerts: evaluateAlerts(partial),
    brandsServed: options.brandsServed,
  };
}

// ── Prisma implementation ────────────────────────────────────────────────

type Db = Pick<
  typeof prisma,
  'rAIngestQuery' | 'rAJob' | 'rARateCounter' | 'rAWorkItem' | 'rAProviderUsage' | 'rAEmailLog' | 'rACareerSiteSource' | 'appConfig' | '$queryRaw'
>;

export function createPrismaSystemStore(db: Db = prisma): SystemStore {
  return {
    async ingestCounts(market, now, overdueBefore) {
      const base = { market, enabled: true };
      const [due, overdue, failing] = await Promise.all([
        db.rAIngestQuery.count({ where: { ...base, nextRunAt: { lte: now } } }),
        db.rAIngestQuery.count({ where: { ...base, nextRunAt: { lte: overdueBefore } } }),
        db.rAIngestQuery.count({ where: { ...base, lastError: { not: null } } }),
      ]);
      return { due, overdue, failing };
    },
    async newJobsByDay(market, since) {
      const rows = await db.$queryRaw<Array<{ day: string; n: number | bigint }>>`
        SELECT to_char("firstSeenAt", 'YYYY-MM-DD') AS day, COUNT(*) AS n
        FROM "RAJob"
        WHERE "market" = ${market} AND "visibility" = 'public' AND "isCanonical" = true AND "firstSeenAt" >= ${since}
        GROUP BY 1`;
      return rows.map((r) => ({ day: r.day, count: n(r.n) }));
    },
    async openJobCounts(market) {
      const where = { market, visibility: 'public', isCanonical: true, archivedAt: null, closedAt: null };
      const [open, enriched] = await Promise.all([
        db.rAJob.count({ where }),
        db.rAJob.count({ where: { ...where, enrichedAt: { not: null } } }),
      ]);
      return { open, enriched };
    },
    async rateCounter(key, windowStart) {
      const row = await db.rARateCounter.findUnique({ where: { key_windowStart: { key, windowStart } }, select: { count: true } });
      return row?.count ?? 0;
    },
    async queueByKind() {
      const rows = await db.rAWorkItem.groupBy({
        by: ['kind', 'status'],
        where: { status: { in: ['queued', 'leased', 'failed', 'dead'] } },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      const out = new Map<string, QueueKindRow>();
      for (const r of rows) {
        const row = out.get(r.kind) ?? { kind: r.kind, queued: 0, leased: 0, failed: 0, dead: 0, oldestQueuedAt: null };
        const count = r._count._all;
        if (r.status === 'queued') {
          row.queued = count;
          row.oldestQueuedAt = r._min.createdAt ? r._min.createdAt.toISOString() : null;
        } else if (r.status === 'leased') row.leased = count;
        else if (r.status === 'failed') row.failed = count;
        else if (r.status === 'dead') row.dead = count;
        out.set(r.kind, row);
      }
      return [...out.values()];
    },
    async providerUsage(dayKey) {
      const rows = await db.rAProviderUsage.findMany({ where: { dayKey } });
      return rows.map((r) => ({ provider: r.provider, calls: r.calls, jobsReturned: r.jobsReturned, jobsNew: r.jobsNew, errors: r.errors }));
    },
    async providerQuota() {
      const row = await db.appConfig.findUnique({ where: { key: PROVIDER_QUOTA_CONFIG_KEY }, select: { value: true } });
      return parseProviderQuota(row?.value);
    },
    hydrateQuota: () => hydrateProviderQuota(db),
    async emailStatus(brand, range, templates) {
      const rows = await db.rAEmailLog.groupBy({
        by: ['status'],
        where: { brand, createdAt: { gte: range.since, lt: range.until }, ...(templates ? { template: { in: [...templates] } } : {}) },
        _count: { _all: true },
      });
      const of = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
      return { sent: of('sent'), failed: of('failed') };
    },
    async emailFailuresByTemplate(brand, range, limit) {
      const rows = await db.rAEmailLog.groupBy({
        by: ['template'],
        where: { brand, status: 'failed', createdAt: { gte: range.since, lt: range.until } },
        _count: { _all: true },
      });
      return rows
        .map((r) => ({ template: r.template, count: r._count._all }))
        .sort((a, b) => b.count - a.count || a.template.localeCompare(b.template))
        .slice(0, limit);
    },
    async copilotStats(brand, range) {
      const rows = await db.$queryRaw<Array<{ turns: number | bigint; guard: number | bigint | null; cost: number | null }>>`
        SELECT COUNT(*) AS turns,
          COALESCE(SUM(CASE WHEN jsonb_typeof(d."metadata"->'guardHits') = 'number' THEN (d."metadata"->>'guardHits')::numeric ELSE 0 END), 0) AS guard,
          COALESCE(SUM(d."platformCostUsd"), 0)::float8 AS cost
        FROM "UsageDeductionLog" d
        JOIN "User" u ON u."id" = d."userId"
        WHERE d."sku" = ${COPILOT_SKU} AND d."metadata"->>'kind' = 'cost' AND d."createdAt" >= ${range.since} AND d."createdAt" < ${range.until} AND u."brand" = ${brand}`;
      const r = rows[0];
      return { turns: n(r?.turns), guardHits: n(r?.guard), costUsd: n(r?.cost) };
    },
    async sourceStatuses(market, providers) {
      return readSourceStatuses(db, market === 'cn' ? 'cn' : 'intl', providers);
    },
    async sourceJobCounts(market, sourceBoards) {
      const where = { market, visibility: 'public', sourceBoard: { in: [...sourceBoards] } };
      const [open, held] = await Promise.all([
        db.rAJob.count({ where: { ...where, archivedAt: null } }),
        db.rAJob.count({ where: { ...where, closeReason: 'no_apply_target' } }),
      ]);
      return { open, held };
    },
    async careerSourceCounts(market) {
      // A board is one row for both sites since MKT-3D (JC-4): the countries it is read for decide which site
      // it feeds (`sourceFeedsMarket`), and the `market` column only keeps the console that added it. Counting
      // by that column gave both brands wrong numbers for every shared board.
      // `ats` too: a board of a mainland-only system (北森) feeds the mainland site alone (MKT-5B O-11).
      const { SKIPPED_BOARD_ERRORS, sourceFeedsMarket } = await import('../jobs/sources/atsPublic/index.js');
      const rows = await db.rACareerSiteSource.findMany({ select: { ats: true, countries: true, enabled: true, lastError: true }, take: CAREER_SOURCE_SCAN });
      const feeds = rows.filter((r) => sourceFeedsMarket(r, market === 'cn' ? 'cn' : 'intl'));
      const enabled = feeds.filter((r) => r.enabled);
      // A board that was passed over (its system is switched off here, or it is on the do-not-read list) did not fail.
      return { total: feeds.length, enabled: enabled.length, failing: enabled.filter((r) => r.lastError !== null && !SKIPPED_BOARD_ERRORS.includes(r.lastError)).length };
    },
    async creditExhaustion(brand, range) {
      const ever = await db.$queryRaw<Array<{ one: number }>>`
        SELECT 1 AS one FROM "RAProductEvent"
        WHERE "brand" = ${brand} AND "name" = 'upgrade_viewed' AND "props"->>'from' = 'out_of_credits'
        LIMIT 1`;
      if (ever.length === 0) return null;
      // People, not sheet openings: one person who opens the sheet three times counts once.
      // Signed-out viewers have no userId and are not counted.
      const rows = await db.$queryRaw<Array<{ bucket: string; n: number | bigint }>>`
        SELECT COALESCE("props"->>'bucket', 'unknown') AS bucket, COUNT(DISTINCT "userId") AS n
        FROM "RAProductEvent"
        WHERE "brand" = ${brand} AND "name" = 'upgrade_viewed' AND "props"->>'from' = 'out_of_credits'
          AND "userId" IS NOT NULL AND "createdAt" >= ${range.since} AND "createdAt" < ${range.until}
        GROUP BY 1`;
      return rows.map((r) => ({ bucket: r.bucket, count: n(r.n) })).sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
    },
  };
}
