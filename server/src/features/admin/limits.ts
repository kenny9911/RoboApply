// server/src/features/admin/limits.ts — the daily limits the System panel
// compares usage against, and the RARateCounter keys that count the usage.
//
// The System panel (system.ts) imports everything from here under the names
// the owning areas use: `scoreDailyBudget`, `scoreCounterKeys` (match),
// `copilotDailyBudgetUsd` (copilot), `dailyCallLimit` (jobs/ingest),
// `enrichDailyLimit` (jobs/enrich).
//
// ── Join J3 (applied at the INT gate) ────────────────────────────────────
// A feature area may import another area only through its index.ts
// (boundary.test.ts). features/match, features/copilot and
// features/jobs/ingest export these readers from their index.ts now, so
// they are re-exported here instead of copied: one definition per limit.

import { enrichDailyLimit } from '../jobs/enrich/index.js';

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
