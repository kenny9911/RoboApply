// server/src/features/jobs/ingest/config.ts — env knobs of the inventory pipeline (WP-16b).
//
// Every knob has a safe default; nothing here enables a paid provider (the
// RapidAPI clients still need RAPID_API_KEY and their own kill switches).
//
//   INGEST_<PROVIDER>_DAILY_CALLS   upper bound of a metered provider's daily calls in
//                                   RAProviderUsage. The effective budget is also capped by
//                                   what is left of the plan's monthly quota, spread over the
//                                   days to its reset and divided by the requests one call
//                                   takes (effectiveDailyLimit). Without the env and without
//                                   a quota reading: activejobs 300, jsearch 200.
//   RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET
//                                   deprecated alias of the line above, read only while the
//                                   INGEST_ name is unset (logged once). It used to be a second,
//                                   client-local counter; there is one budget per provider now.
//   INGEST_<PROVIDER>_CN_DAILY_CALLS  daily calls for GoApply, counted under `<provider>:cn`
//                                   (default 0: no metered provider is called for market cn;
//                                   Active Jobs DB: 20 while the licensed feed's plan gate is
//                                   open for the mainland, JC-6. Ingest calls only: a person's
//                                   own search is let through only when the operator set it)
//   FANTASTIC_MONTHLY_JOBS          postings a month of the Active Jobs DB plan the owner bought,
//                                   for a plan whose responses do not state it (unset). REQUIRED on
//                                   a deployment that serves only GoApply: nothing there calls the
//                                   provider before the gate is open, so no response ever states it
//   FANTASTIC_FEED_DISABLED         true stops the licensed feed sync (default false)
//   FANTASTIC_FEED_SLICE_CHECK_DISABLED
//                                   true lets the feed read a page whose postings were mostly
//                                   indexed outside the slice it asked for (default false: such
//                                   a page is an error and the cursor stays). Only for the case
//                                   that the provider's date bounds turn out to work on another
//                                   timestamp than the `date_created` it returns
//   INGEST_FEED_DAILY_JOBS          hard daily budget of postings for the feed sync, both markets
//                                   together (default: the plan's month / 31). What the search
//                                   adapter was billed for that day counts toward it: one plan.
//                                   Once the provider states what the plan has left and when it
//                                   resets, the day is also capped by that, less the reserve
//                                   (INGEST_QUOTA_RESERVE_SHARE of the plan's postings), spread over
//                                   the days to the reset: postings billed to people's own searches
//                                   are then never on top of the feed's month
//   INGEST_FEED_CN_DAILY_JOBS       the mainland sync's part of that day (default 20% of it; the
//                                   international sync has the rest)
//   INGEST_FEED_COUNTRIES           ISO codes the international feed sync asks for
//                                   (default US,CA,GB,IE,DE,FR,NL,ES,IT,SE,AU,SG,TW)
//   INGEST_FEED_TAXONOMIES          optional vendor taxonomy names the feed is narrowed to (unset)
//   CN_ACTIVEJOBS_ENABLED           false keeps Active Jobs DB off for GoApply even with a paid
//                                   plan (default on once the plan gate is open: D5)
// The transport of the Active Jobs DB client (FANTASTIC_TRANSPORT, FANTASTIC_API_KEY,
// FANTASTIC_API_KEY_HEADER, FANTASTIC_FEED_PATH, FANTASTIC_EXPIRED_PATH) is read by the client
// itself (roboapply/v2/lib/raFantasticJobs.ts).
//   INGEST_QUOTA_RESERVE_SHARE      share of a provider's monthly request limit that ingest
//                                   leaves for people's own searches (default 0.05); the licensed
//                                   feed leaves the same share of the plan's monthly postings
//   INGEST_QUOTA_RECHECK_HOURS      hours after which a used-up or refused quota reading stops
//                                   blocking calls before its reset time, so one call re-reads
//                                   the plan (default 0: never before the reset; set it after
//                                   changing a plan mid-period)
//   INGEST_CURSOR_TICK_SHARE        share of one ingest tick a single cursor source may use
//                                   while it keeps reporting more rows (default 0.4; 1 = the
//                                   whole tick, as before the market wave; never under 0.05)
//   PUBLIC_DISPLAY_PROVIDERS        providers whose licence allows public redisplay
//                                   (comma list; DEFAULT EMPTY — owner decision OPS-A4)
//   JOB_PROVIDERS_<BRAND>           narrows a brand's source list (comma list, subset only;
//                                   read in ../sources/registry.ts)
// CN_EXTERNAL_PROVIDERS is no longer read: GoApply has no search provider.
//   INGEST_LEASE_BATCH              queries leased per step (default 4)
//   INGEST_SEED_ROLES               SEO seed roles (taxonomy L3, table order; default 300)
//   INGEST_SEED_CITIES_PER_COUNTRY  SEO seed cities per country (default 3)
//   INGEST_SEED_COUNTRIES           SEO seed countries (default: the brand's default country)
//   INGEST_BANK_PAGE                bank rows read per sync step (default 200)
//   INGEST_SEED_BUDGET_SHARE        share of a provider's daily calls SEO seeds may use
//                                   (default 0.5; demand always keeps the rest)
//   INGEST_SCHEDULED_DEMAND_SHARE   share of a provider's daily calls the standing demand
//                                   queries of the ingest tick may use (default 0.8; 1 = the
//                                   whole day, as before). The rest is kept for a person's own
//                                   search of that day: onboarding's targeted ingest and its
//                                   queued remainder, which may use the day up to its limit.

import { logger } from '../../../services/LoggerService.js';
import { allowedBrands, getBrand, parseBoolEnv, type EnvSource, type Market } from '../../../platform/brand/index.js';
import type { IngestProvider } from '../sources/index.js';
import { daysToReset, type ProviderQuotaSnapshot } from './quotaContract.js';

export const DEFAULT_DAILY_CALLS: Readonly<Partial<Record<IngestProvider, number>>> = {
  activejobs: 300,
  jsearch: 200,
};

/** Upsert batch size (ARCH §4.4: one statement per 100 rows). */
export const UPSERT_BATCH = 100;
/** A leased query is invisible to other ticks for this long (ARCH §4.4). */
export const LEASE_MINUTES = 15;
/** Days of inactivity after which a user's profile stops creating demand (ARCH §4.3). */
export const ACTIVE_USER_DAYS = 14;
/** Days a demand query may go unused before the planner disables it (ARCH §4.3). */
export const DISABLE_UNUSED_DAYS = 30;
/** Postings older than this are archived when the provider gives no expiry (ARCH §4.4). */
export const MAX_AGE_DAYS = 45;
/** Locations per user profile that become demand tuples. */
export const MAX_LOCATIONS_PER_PROFILE = 3;

function intEnv(env: EnvSource, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function listEnv(env: EnvSource, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function shareEnv(env: EnvSource, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

const aliasWarned = new Set<string>();

/**
 * The daily call bound the operator set for a provider: `INGEST_<PROVIDER>_DAILY_CALLS`,
 * else the deprecated `RA_ONBOARDING_<PROVIDER>_DAILY_BUDGET` (logged once per name).
 * Null when neither is set to a number.
 */
function configuredDailyCalls(provider: IngestProvider, env: EnvSource): number | null {
  const name = `INGEST_${provider.toUpperCase()}_DAILY_CALLS`;
  const alias = `RA_ONBOARDING_${provider.toUpperCase()}_DAILY_BUDGET`;
  for (const key of [name, alias]) {
    const raw = env[key]?.trim();
    if (!raw || !Number.isFinite(Number(raw))) continue;
    if (key === alias && !aliasWarned.has(alias)) {
      aliasWarned.add(alias);
      logger.warn('JOBS_INGEST', 'deprecated env name read as the daily call bound; rename it', { deprecated: alias, use: name });
    }
    return Math.max(0, Math.floor(Number(raw)));
  }
  return null;
}

/**
 * The configured daily call bound of a provider: `INGEST_<PROVIDER>_DAILY_CALLS`
 * (or its deprecated alias), else the default; null = not metered. This is the
 * operator's upper bound (the admin "Limits" page shows it); what ingest may
 * actually call today is `effectiveDailyLimit`.
 */
export function dailyCallLimit(provider: IngestProvider, env: EnvSource = process.env): number | null {
  return configuredDailyCalls(provider, env) ?? DEFAULT_DAILY_CALLS[provider] ?? null;
}

/** Share (0–1) of a provider's monthly request limit ingest leaves for people's own searches. */
export function quotaReserveShare(env: EnvSource = process.env): number {
  return shareEnv(env, 'INGEST_QUOTA_RESERVE_SHARE', 0.05);
}

/** Requests ingest never spends: `max(1, ceil(limit × share))` (1 when the plan's limit is not known). */
export function quotaReserve(requestsLimit: number | null | undefined, env: EnvSource = process.env): number {
  const limit = typeof requestsLimit === 'number' && Number.isFinite(requestsLimit) && requestsLimit > 0 ? requestsLimit : 0;
  return Math.max(1, Math.ceil(limit * quotaReserveShare(env)));
}

/**
 * Milliseconds after which a used-up or refused quota reading stops blocking
 * calls although its reset time has not come, so one call re-reads the plan.
 * 0 (the default) = it blocks until the reset time the provider stated.
 */
export function quotaRecheckMs(env: EnvSource = process.env): number {
  const raw = Number(env.INGEST_QUOTA_RECHECK_HOURS?.trim() || '0');
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 3_600_000) : 0;
}

/** The smallest share a cursor source is ever given: a setting of 0 must not switch the banks and boards off. */
export const MIN_CURSOR_TICK_SHARE = 0.05;

/** Share (0.05–1) of one ingest tick a single cursor source may use while it keeps reporting more rows. */
export function cursorTickShare(env: EnvSource = process.env): number {
  return Math.max(MIN_CURSOR_TICK_SHARE, shareEnv(env, 'INGEST_CURSOR_TICK_SHARE', 0.4));
}

/**
 * What the daily budget needs from a quota reading. `lastCallCost` is the
 * requests the provider's own headers say the last call took (absent or null:
 * not known).
 */
export type QuotaReading = Pick<ProviderQuotaSnapshot, 'requestsLimit' | 'requestsRemaining' | 'resetAt'> & Partial<Pick<ProviderQuotaSnapshot, 'lastCallCost'>>;
type QuotaReader = (provider: string, now: Date, env?: EnvSource) => QuotaReading | null;

let quotaReader: QuotaReader | null = null;

/**
 * Where `effectiveDailyLimit` reads a provider's current quota reading.
 * quota.ts registers its in-memory snapshot when it loads (null while a
 * reading that stopped ingest has stopped blocking: the next call re-reads
 * the plan); this module holds env knobs only and imports nothing with a
 * side effect.
 */
export function setQuotaReader(reader: QuotaReader | null): void {
  quotaReader = reader;
}

/**
 * Calls a day that what is left of the plan's period allows, spread over the
 * days to its reset. The plan counts REQUESTS and the day's usage row counts
 * CALLS, so the day's share of requests,
 * `floor((requestsRemaining − reserve) / max(1, daysToReset))`, is divided by
 * what one call costs when the provider's headers have shown it
 * (`lastCallCost`: a JSearch call that reads two pages takes two requests).
 * A cost that is not known, or under 1, counts as 1. Null when the provider
 * stated no remaining count or no reset time (never a guess).
 */
export function quotaDailyCap(reading: QuotaReading | null | undefined, now: Date, env: EnvSource = process.env): number | null {
  if (!reading || reading.requestsRemaining === null) return null;
  const days = daysToReset(reading, now);
  if (days === null) return null;
  const requestsADay = Math.max(0, Math.floor((reading.requestsRemaining - quotaReserve(reading.requestsLimit, env)) / Math.max(1, days)));
  const cost = typeof reading.lastCallCost === 'number' && Number.isFinite(reading.lastCallCost) && reading.lastCallCost > 1 ? reading.lastCallCost : 1;
  return Math.floor(requestsADay / cost);
}

/**
 * Calls ingest may make to a metered provider today, for one market (the
 * limit of the day's RAProviderUsage row, key `usageKey(provider, market)`):
 *
 *   intl  the smaller of the configured bound (when the operator set one) and
 *         the quota's daily cap (when the provider stated its quota); with
 *         neither, the default. A stated quota replaces the default: 9,773 of
 *         10,000 left with 17 days to go is 545 a day, not 200 (272 once a
 *         call is known to take two requests).
 *   cn    `INGEST_<PROVIDER>_CN_DAILY_CALLS` (default 0; 20 for Active Jobs DB
 *         while the feed's plan gate is open for the mainland), under the same cap.
 *
 * Null = nothing is known about the provider (not metered by this module).
 *
 * The reading is the one quota.ts holds in memory. A caller that holds the
 * stored reading instead (the admin System panel) uses `effectiveDailyLimitFor`:
 * the same rule with the reading as an argument.
 */
export function effectiveDailyLimit(provider: IngestProvider, market: Market, env: EnvSource = process.env, now: Date = new Date()): number | null {
  let reading: QuotaReading | null = null;
  try {
    reading = quotaReader?.(provider, now, env) ?? null;
  } catch {
    reading = null;
  }
  return effectiveDailyLimitFor(provider, market, env, reading, now);
}

/**
 * The mainland call bound the operator set: INGEST_<PROVIDER>_CN_DAILY_CALLS.
 * Null when it is unset or not a number (the default then applies:
 * `mainlandDefaultCalls`). A person's own search for market cn is let through
 * only under a bound set here above 0 (quota.ts `providerCallGate`).
 */
export function mainlandOperatorCalls(provider: string, env: EnvSource = process.env): number | null {
  const raw = env[`INGEST_${provider.toUpperCase()}_CN_DAILY_CALLS`]?.trim();
  if (!raw || !Number.isFinite(Number(raw))) return null;
  return Math.max(0, Math.floor(Number(raw)));
}

/** Ingest calls a day Active Jobs DB gets for the mainland while the feed's plan gate is open and the operator set no bound (JC-6). */
export const MAINLAND_ACTIVEJOBS_DAILY_CALLS = 20;

type MainlandGate = (provider: string, env: EnvSource, now: Date) => boolean;
let mainlandGate: MainlandGate | null = null;

/**
 * Where `effectiveDailyLimitFor` asks whether a provider's plan is open for
 * the mainland (quota.ts registers `mainlandPlanOpen` when it loads; this
 * module holds env knobs only). With nothing registered no plan is open.
 */
export function setMainlandGate(gate: MainlandGate | null): void {
  mainlandGate = gate;
}

/** Mainland ingest calls a day when the operator set none: 20 for a provider whose plan gate is open for the mainland, else 0. */
function mainlandDefaultCalls(provider: string, env: EnvSource, now: Date): number {
  try {
    return mainlandGate?.(provider, env, now) === true ? MAINLAND_ACTIVEJOBS_DAILY_CALLS : 0;
  } catch {
    return 0;
  }
}

/** `effectiveDailyLimit` for a given quota reading (null: the provider stated no quota, or its period has ended). The one definition of the rule. */
export function effectiveDailyLimitFor(provider: IngestProvider, market: Market, env: EnvSource, reading: QuotaReading | null, now: Date): number | null {
  const cap = quotaDailyCap(reading, now, env);
  if (market === 'cn') {
    const cn = mainlandOperatorCalls(provider, env) ?? mainlandDefaultCalls(provider, env, now);
    return cap === null ? cn : Math.min(cn, cap);
  }
  const configured = configuredDailyCalls(provider, env);
  if (configured !== null) return cap === null ? configured : Math.min(configured, cap);
  return cap ?? DEFAULT_DAILY_CALLS[provider] ?? null;
}

/** Test seam: forget which deprecated names were already reported. */
export function resetConfigWarningsForTests(): void {
  aliasWarned.clear();
}

/** Providers whose licence allows public redisplay. Default empty (OPS-A4). */
export function publicDisplayProviders(env: EnvSource = process.env): string[] {
  return listEnv(env, 'PUBLIC_DISPLAY_PROVIDERS');
}

export function leaseBatch(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_LEASE_BATCH', 4, 1, 25);
}

export function seedRoleLimit(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_SEED_ROLES', 300, 0, 1000);
}

export function seedCitiesPerCountry(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_SEED_CITIES_PER_COUNTRY', 3, 0, 20);
}

export function seedCountries(defaultCountry: string, env: EnvSource = process.env): string[] {
  const list = listEnv(env, 'INGEST_SEED_COUNTRIES').map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return list.length ? [...new Set(list)] : [defaultCountry.toUpperCase()];
}

export function bankPageSize(env: EnvSource = process.env): number {
  return intEnv(env, 'INGEST_BANK_PAGE', 200, 10, 1000);
}

/**
 * Share (0–1) of a provider's daily calls the tick's standing demand queries
 * may use (see the header). With no SEO seeds on a per-request provider any
 * more, standing demand alone can fill the day shortly after midnight UTC; a
 * person who onboards later that day must still find calls left for their own
 * role and place. Calls the share leaves unused are not lost: they stay in the
 * plan's month and raise the following days' limit.
 */
export function scheduledDemandShare(env: EnvSource = process.env): number {
  return shareEnv(env, 'INGEST_SCHEDULED_DEMAND_SHARE', 0.8);
}

/**
 * The calls of a day's limit that standing demand may use: the share of it,
 * at least one call (a limit of 1 or 2 is not rounded down to nothing).
 */
export function scheduledDemandLimit(limit: number, env: EnvSource = process.env): number {
  const share = scheduledDemandShare(env);
  if (limit <= 1 || share >= 1) return limit;
  return Math.max(1, Math.floor(limit * share));
}

/** Share (0–1) of a provider's daily calls SEO seed queries may use. */
export function seedBudgetShare(env: EnvSource = process.env): number {
  const raw = Number(env.INGEST_SEED_BUDGET_SHARE?.trim() || '0.5');
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
}

// ── The licensed feed (Active Jobs DB window sync; MARKET_STRATEGY M-2, JI-7, JC-6) ──

/** Postings a month the plan must allow before the feed sync turns itself on (M-2). */
export const FEED_MIN_MONTHLY_JOBS = 20_000;
/** A month of the plan is spread over this many days (the longest month: the day's budget never outruns the plan). */
export const FEED_DAYS_PER_MONTH = 31;
/** Share of the day's posting budget the mainland sync gets when the operator set none. */
export const FEED_CN_BUDGET_SHARE = 0.2;
/** Enabled boards of one ATS in our own list from which the feed stops returning that ATS (critic C14). */
export const FEED_EXCLUDE_MIN_BOARDS = 200;
/**
 * Countries the international sync asks for when INGEST_FEED_COUNTRIES is
 * unset: the brand's markets (MARKET_STRATEGY §1.2, §1.3). A tunable default:
 * the owner trims it after measuring volume with the vendor's count endpoint.
 */
export const DEFAULT_FEED_COUNTRIES: readonly string[] = ['US', 'CA', 'GB', 'IE', 'DE', 'FR', 'NL', 'ES', 'IT', 'SE', 'AU', 'SG', 'TW'];

/** FANTASTIC_MONTHLY_JOBS: the plan size the owner bought; null when unset or not a positive number. */
export function feedMonthlyJobsEnv(env: EnvSource = process.env): number | null {
  const raw = env.FANTASTIC_MONTHLY_JOBS?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * The gate's reason as the short code the job-source registry and the admin
 * panels read (`JobSourceAdapter.disabledReason()`): one table for the feed
 * adapter and for Active Jobs DB's mainland search, which stand behind the
 * same gate.
 *
 * 'plan_unknown' and 'plan_too_small' are the two codes for "off until a plan
 * allows it". The admin System panel gives a row with either the state
 * 'gated' (admin/system.ts `PLAN_GATE_REASONS`): any other code on a row
 * whose quota reading is used up would read there as 'exhausted' and raise a
 * provider alert (and a line in the daily health e-mail) for a source that
 * never ran. A code added here for a plan gate must be added there too
 * (rapidApi.cn.test.ts "a used-up plan that never stated its postings").
 */
export const FEED_GATE_REASON_CODE: Readonly<Record<Exclude<FeedGateReason, 'ok'>, string>> = {
  plan_unknown: 'plan_unknown',
  plan_too_small: 'plan_too_small',
  no_key: 'no_api_key',
  disabled: 'kill_switch',
  exhausted: 'quota',
};

/**
 * Postings a month the feed's plan allows: the larger of what the provider's
 * own responses stated (`jobsLimit` of the quota reading) and
 * FANTASTIC_MONTHLY_JOBS. Null when neither says: never a guess.
 */
export function feedMonthlyJobs(env: EnvSource, statedJobsLimit: number | null | undefined): number | null {
  const stated = typeof statedJobsLimit === 'number' && Number.isFinite(statedJobsLimit) && statedJobsLimit > 0 ? Math.floor(statedJobsLimit) : null;
  const bought = feedMonthlyJobsEnv(env);
  if (stated === null) return bought;
  return bought === null ? stated : Math.max(stated, bought);
}

/** FANTASTIC_FEED_DISABLED: the feed's own kill switch. */
export function feedDisabled(env: EnvSource = process.env): boolean {
  return parseBoolEnv(env.FANTASTIC_FEED_DISABLED);
}

/** FANTASTIC_FEED_SLICE_CHECK_DISABLED: the operator's way out should the slice check misjudge real responses (none was ever seen). */
export function feedSliceCheckDisabled(env: EnvSource = process.env): boolean {
  return parseBoolEnv(env.FANTASTIC_FEED_SLICE_CHECK_DISABLED);
}

/** CN_ACTIVEJOBS_ENABLED: on unless it says no (D5: a paid plan is the only gate). */
export function mainlandActiveJobsEnabled(env: EnvSource = process.env): boolean {
  const raw = env.CN_ACTIVEJOBS_ENABLED?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

export type FeedGateReason = 'plan_unknown' | 'plan_too_small' | 'no_key' | 'disabled' | 'exhausted' | 'ok';

export interface FeedGate {
  open: boolean;
  reason: FeedGateReason;
  /** Postings a month the plan allows (`feedMonthlyJobs`); null = nothing states it. */
  monthlyJobs: number | null;
}

/**
 * The feed's quota gate as a pure rule (quota.ts `feedGate` supplies the
 * facts). The first that applies:
 *   disabled        FANTASTIC_FEED_DISABLED, or a kill switch of the provider;
 *   plan_unknown    nothing states what the plan allows: no response of the
 *                   provider was read yet (or the last one refused the key)
 *                   and FANTASTIC_MONTHLY_JOBS is unset. Not the same as a
 *                   small plan: on a deployment that serves only GoApply no
 *                   call is ever made before the gate is open, so the gate
 *                   stays here until the operator sets the variable;
 *   plan_too_small  the plan allows fewer than 20,000 postings a month
 *                   (today's BASIC plan: 250). The plan is THE gate (M-2), so
 *                   both plan reasons are named before the key: a deployment
 *                   with neither is waiting for a plan;
 *   no_key          a plan of that size is stated and the chosen transport
 *                   has no key;
 *   exhausted       the plan's quota stops ingest right now (used up, the key
 *                   refused, or down to the reserve kept for people's searches);
 *   ok              open.
 */
export function feedGateFor(facts: { env: EnvSource; statedJobsLimit: number | null; keyPresent: boolean; providerKilled: boolean; quotaStops: boolean }): FeedGate {
  const monthlyJobs = feedMonthlyJobs(facts.env, facts.statedJobsLimit);
  const closed = (reason: FeedGateReason): FeedGate => ({ open: false, reason, monthlyJobs });
  if (feedDisabled(facts.env) || facts.providerKilled) return closed('disabled');
  if (monthlyJobs === null) return closed('plan_unknown');
  if (monthlyJobs < FEED_MIN_MONTHLY_JOBS) return closed('plan_too_small');
  if (!facts.keyPresent) return closed('no_key');
  if (facts.quotaStops) return closed('exhausted');
  return { open: true, reason: 'ok', monthlyJobs };
}

/** The smallest reserve of postings: one page of a person's own search (the search client asks 20 rows a call). */
export const FEED_RESERVE_MIN_JOBS = 20;

/**
 * Postings of the plan's period the feed never spends: they are left for
 * people's own searches (onboarding, the Assistant, the job-search API), which
 * are billed per posting on the same plan and are not counted in the feed's
 * day. `max(20, ceil(jobsLimit × INGEST_QUOTA_RESERVE_SHARE))`: the same share
 * ingest leaves of the plan's requests (`quotaReserve`).
 */
export function feedJobsReserve(jobsLimit: number | null | undefined, env: EnvSource = process.env): number {
  const limit = typeof jobsLimit === 'number' && Number.isFinite(jobsLimit) && jobsLimit > 0 ? jobsLimit : 0;
  return Math.max(FEED_RESERVE_MIN_JOBS, Math.ceil(limit * quotaReserveShare(env)));
}

/** What the feed's budget needs from a quota reading (the provider's own numbers; null = not stated). */
export type FeedQuotaReading = Pick<ProviderQuotaSnapshot, 'jobsLimit' | 'jobsRemaining' | 'resetAt'>;

/**
 * Postings the feed may still be billed for in this period: what the provider
 * says the plan has left, less the reserve. Null when the provider stated no
 * remaining count (never a guess).
 */
export function feedJobsLeft(reading: FeedQuotaReading | null | undefined, env: EnvSource = process.env): number | null {
  if (!reading || reading.jobsRemaining === null) return null;
  return Math.max(0, Math.floor(reading.jobsRemaining - feedJobsReserve(reading.jobsLimit, env)));
}

/**
 * Postings a day that what is left of the plan's period allows the feed:
 * `floor((jobsRemaining − reserve) / max(1, daysToReset))`, the posting side
 * of `quotaDailyCap`. The provider's remaining count holds everything the
 * plan was billed for, a person's own search included, so a feed held to this
 * never uses the plan up before its reset. Null when the provider stated no
 * remaining count or no reset time: the month / 31 rule then stands alone.
 */
export function feedQuotaDailyJobs(reading: FeedQuotaReading | null | undefined, now: Date, env: EnvSource = process.env): number | null {
  const left = feedJobsLeft(reading, env);
  if (left === null) return null;
  const days = daysToReset(reading, now);
  if (days === null) return null;
  return Math.floor(left / Math.max(1, days));
}

/**
 * Postings a day the feed sync may be billed for, both markets together: the
 * smaller of
 *   - INGEST_FEED_DAILY_JOBS, else `floor(monthlyJobs / 31)` (0 when nothing
 *     states the plan's size and the operator set no budget), and
 *   - `quotaCap` (`feedQuotaDailyJobs`), when the provider stated what the
 *     plan has left and when it resets.
 * The day is counted in the plan's own usage rows (`activejobs`,
 * `activejobs:cn`), so what the ingest search adapter was billed for the same
 * day counts toward it.
 */
export function feedDailyJobs(env: EnvSource, monthlyJobs: number | null, quotaCap: number | null = null): number {
  const fallback = monthlyJobs !== null && monthlyJobs > 0 ? Math.floor(monthlyJobs / FEED_DAYS_PER_MONTH) : 0;
  const day = intEnv(env, 'INGEST_FEED_DAILY_JOBS', fallback, 0);
  return quotaCap === null ? day : Math.max(0, Math.min(day, Math.floor(quotaCap)));
}

/** Does this deployment serve a brand of the market (BRAND_LOCK / ALLOWED_BRANDS)? */
export function servesMarket(market: Market, env: EnvSource = process.env): boolean {
  try {
    return allowedBrands(env).some((id) => getBrand(id).market === market);
  } catch {
    return true;
  }
}

/**
 * One market's part of the day's posting budget (`feedDailyJobs`, the quota
 * cap included). The two parts never add up to more than the day:
 *   cn    INGEST_FEED_CN_DAILY_JOBS, else 20% of the day, never more than the
 *         day; 0 when the mainland sync is off (CN_ACTIVEJOBS_ENABLED=false) or
 *         the deployment serves no mainland brand;
 *   intl  the rest of the day; 0 when the deployment serves no international brand.
 */
export function feedDailyJobsFor(market: Market, env: EnvSource, monthlyJobs: number | null, quotaCap: number | null = null): number {
  const day = feedDailyJobs(env, monthlyJobs, quotaCap);
  const cnOn = mainlandActiveJobsEnabled(env) && servesMarket('cn', env);
  const cn = cnOn ? Math.min(day, intEnv(env, 'INGEST_FEED_CN_DAILY_JOBS', Math.floor(day * FEED_CN_BUDGET_SHARE), 0)) : 0;
  if (market === 'cn') return cn;
  return servesMarket('intl', env) ? day - cn : 0;
}

/** INGEST_FEED_COUNTRIES as upper-case ISO codes in the order given, without repeats (default `DEFAULT_FEED_COUNTRIES`). Anything that is not two letters is left out. */
export function feedCountries(env: EnvSource = process.env): string[] {
  const raw = env.INGEST_FEED_COUNTRIES?.trim();
  const list = raw ? raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)) : [...DEFAULT_FEED_COUNTRIES];
  return [...new Set(list)];
}

/** INGEST_FEED_TAXONOMIES: vendor taxonomy names as written (the feed adapter keeps the ones the vendor documents). */
export function feedTaxonomies(env: EnvSource = process.env): string[] {
  return [...new Set((env.INGEST_FEED_TAXONOMIES ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
}
