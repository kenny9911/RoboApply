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
//                                   (default 0: no metered provider is called for market cn)
//   INGEST_QUOTA_RESERVE_SHARE      share of a provider's monthly request limit that ingest
//                                   leaves for people's own searches (default 0.05)
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
import type { EnvSource, Market } from '../../../platform/brand/index.js';
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
 *   cn    `INGEST_<PROVIDER>_CN_DAILY_CALLS` (default 0), under the same cap.
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

/** `effectiveDailyLimit` for a given quota reading (null: the provider stated no quota, or its period has ended). The one definition of the rule. */
export function effectiveDailyLimitFor(provider: IngestProvider, market: Market, env: EnvSource, reading: QuotaReading | null, now: Date): number | null {
  const cap = quotaDailyCap(reading, now, env);
  if (market === 'cn') {
    const cn = intEnv(env, `INGEST_${provider.toUpperCase()}_CN_DAILY_CALLS`, 0, 0);
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
