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
import { dailyCallLimit, effectiveDailyLimitFor, quotaDailyCap, quotaReserve, type IngestProvider, type QuotaReading } from '../jobs/ingest/index.js';

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
// spreads what is left of the plan's monthly quota over the days to its reset,
// keeps a reserve for people's own searches and divides by what one call
// costs in requests (MARKET_STRATEGY §1.2, JI-1). The panel shows that limit,
// so "N of M calls today" and the `provider_budget` alert mean what ingest
// does. The rule has ONE definition, in the ingest area (jobs/ingest/config.ts
// `effectiveDailyLimitFor`, `quotaDailyCap`, `quotaReserve`; exported from its
// index since the M3 gate). Ingest reads the quota from its in-memory copy;
// the admin process holds the stored reading and passes it as the argument.

export { quotaDailyCap, quotaReserve };
/** What the daily limit needs from a provider's quota reading (the ingest area's type). */
export type { QuotaReading };

/** A whole number of calls from env: null when the name is unset or not a number. */
function callsEnv(env: EnvSource, name: string): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
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
 *         days to go is 545 a day, not 200 (272 once the reading shows that
 *         one call takes two requests). Null = not metered.
 *   cn    `mainlandCallBudget` under the same cap. A provider that is not
 *         metered at all (a bank, the employer boards) stays null.
 *
 * `reading` is the provider's own current quota reading (null when there is
 * none, or its period has ended: the caller decides that).
 */
export function providerDailyLimit(provider: string, market: Market, env: EnvSource = process.env, reading: QuotaReading | null = null, now: Date = new Date()): number | null {
  const id = provider as IngestProvider;
  // A provider nothing meters (a bank, the employer boards) has no mainland limit to show either.
  if (market === 'cn' && quotaDailyCap(reading, now, env) === null && dailyCallLimit(id, env) === null && callsEnv(env, `INGEST_${provider.toUpperCase()}_CN_DAILY_CALLS`) === null) return null;
  return effectiveDailyLimitFor(id, market, env, reading, now);
}
