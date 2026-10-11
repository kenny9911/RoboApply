// server/src/features/admin/limits.ts — the daily limits the System panel
// compares usage against, and the RARateCounter keys that count the usage.
//
// The System panel (system.ts) imports everything from here under the names
// the owning areas use: `scoreDailyBudget`, `scoreCounterKeys` (match),
// `copilotDailyBudgetUsd` (copilot), `dailyCallLimit` (jobs/ingest),
// `enrichDailyLimit` (jobs/enrich). `providerDailyLimit` (below) is what
// ingest may call one provider in one market today: `dailyCallLimit` under
// the cap the provider's own quota reading sets.
//
// ── Join J3 (applied at the INT gate) ────────────────────────────────────
// A feature area may import another area only through its index.ts
// (boundary.test.ts). features/match, features/copilot and
// features/jobs/ingest export these readers from their index.ts now, so
// they are re-exported here instead of copied: one definition per limit.

import type { EnvSource, Market } from '../../platform/brand/index.js';
import { enrichDailyLimit } from '../jobs/enrich/index.js';
import { dailyCallLimit, daysToReset, type IngestProvider, type ProviderQuotaSnapshot } from '../jobs/ingest/index.js';

export { enrichDailyLimit };

/**
 * RARateCounter key of the day's enrichment model calls for a market
 * (jobs/enrich/budget.ts `enrichBudgetKey`, which that area's index.ts does
 * not export; not part of J3 — the parity test "enrich counter key" stays).
 */
export const enrichCounterKey = (market: string): string => `budget:llm:enrich:${market}`;

export { scoreDailyBudget, scoreCounterKeys } from '../match/index.js';
export { copilotDailyBudgetUsd } from '../copilot/index.js';
export { dailyCallLimit } from '../jobs/ingest/index.js';

// ── Job providers (JI-1) ─────────────────────────────────────────────────

/**
 * Postings a month the licensed feed's plan must allow before the feed sync
 * turns itself on (MARKET_STRATEGY M-2). The System panel shows a feed source
 * on a smaller plan as 'gated'. The feed itself is built in a later phase
 * (JI-7); when its quota gate exports this number from the ingest area,
 * re-export it here instead (one definition per limit, as above).
 */
export const FEED_MIN_MONTHLY_JOBS = 20_000;

// The daily limit ingest enforces is not the configured bound alone: ingest
// spreads what is left of the plan's monthly quota over the days to its reset
// and keeps a reserve for people's own searches (MARKET_STRATEGY §1.2, JI-1;
// jobs/ingest/config.ts `effectiveDailyLimit`). The panel shows that limit,
// so "N of M calls today" and the `provider_budget` alert mean what ingest
// does. Ingest reads the quota from its in-memory copy; the admin process
// holds the stored reading instead, so the same rule is written here with the
// reading as an argument. The test "the daily limit is the one ingest
// enforces" compares the two as soon as the ingest area exports its own.

/** What the daily limit needs from a provider's quota reading. */
export type QuotaReading = Pick<ProviderQuotaSnapshot, 'requestsLimit' | 'requestsRemaining' | 'resetAt'>;

const DEFAULT_QUOTA_RESERVE_SHARE = 0.05;

/** A whole number of calls from env: null when the name is unset or not a number. */
function callsEnv(env: EnvSource, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/**
 * Requests of the plan's period ingest never spends, so people's own searches
 * still work: `max(1, ceil(limit × INGEST_QUOTA_RESERVE_SHARE))`, share 0.05
 * unless set; 1 when the plan's limit is not known.
 */
export function quotaReserve(requestsLimit: number | null | undefined, env: EnvSource = process.env): number {
  const limit = typeof requestsLimit === 'number' && Number.isFinite(requestsLimit) && requestsLimit > 0 ? requestsLimit : 0;
  const raw = env.INGEST_QUOTA_RESERVE_SHARE?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  const share = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_QUOTA_RESERVE_SHARE;
  return Math.max(1, Math.ceil(limit * share));
}

/**
 * What is left of the plan's period, spread over the days to its reset:
 * `floor((requestsRemaining − reserve) / max(1, daysToReset))`. Null when the
 * provider stated no remaining count or no reset time (never a guess).
 */
export function quotaDailyCap(reading: QuotaReading | null | undefined, now: Date, env: EnvSource = process.env): number | null {
  if (!reading || reading.requestsRemaining === null) return null;
  const days = daysToReset(reading, now);
  if (days === null) return null;
  return Math.max(0, Math.floor((reading.requestsRemaining - quotaReserve(reading.requestsLimit, env)) / Math.max(1, days)));
}

/**
 * The daily call bound the operator set for a provider, or null when the
 * ingest default applies: INGEST_<PROVIDER>_DAILY_CALLS set to a number, or
 * `dailyCallLimit` answering something other than its default (any other name
 * the ingest area reads the bound from).
 */
function operatorDailyBound(provider: IngestProvider, env: EnvSource): number | null {
  const bound = dailyCallLimit(provider, env);
  if (bound === null) return null;
  const named = callsEnv(env, `INGEST_${provider.toUpperCase()}_DAILY_CALLS`) !== null;
  return named || bound !== dailyCallLimit(provider, {}) ? bound : null;
}

/**
 * The mainland call budget the operator opened for a provider:
 * INGEST_<PROVIDER>_CN_DAILY_CALLS (JI-1, JC-6). Mainland calls are counted
 * under `<provider>:cn`; with no budget set a metered provider makes none: 0.
 */
export function mainlandCallBudget(provider: string, env: EnvSource = process.env): number {
  return callsEnv(env, `INGEST_${provider.toUpperCase()}_CN_DAILY_CALLS`) ?? 0;
}

/**
 * Calls ingest may make to one provider in one market today, for the "calls
 * today / daily limit" column and the `provider_budget` alert.
 *
 *   intl  the smaller of the bound the operator set and the quota's daily cap
 *         (`quotaDailyCap` of `reading`); with no bound set, the cap; with no
 *         cap either (the provider stated no quota), the ingest default. A
 *         stated quota replaces the default: 9,773 of 10,000 left with 17
 *         days to go is 545 a day, not 200. Null = not metered.
 *   cn    `mainlandCallBudget` under the same cap. A provider that is not
 *         metered at all (a bank, the employer boards) stays null.
 *
 * `reading` is the provider's own current quota reading (null when there is
 * none, or its period has ended: the caller decides that).
 */
export function providerDailyLimit(provider: string, market: Market, env: EnvSource = process.env, reading: QuotaReading | null = null, now: Date = new Date()): number | null {
  const id = provider as IngestProvider;
  const cap = quotaDailyCap(reading, now, env);
  if (market === 'cn') {
    if (cap === null && dailyCallLimit(id, env) === null && callsEnv(env, `INGEST_${provider.toUpperCase()}_CN_DAILY_CALLS`) === null) return null;
    const budget = mainlandCallBudget(provider, env);
    return cap === null ? budget : Math.min(budget, cap);
  }
  const bound = operatorDailyBound(id, env);
  if (bound !== null) return cap === null ? bound : Math.min(bound, cap);
  return cap ?? dailyCallLimit(id, env);
}
