// server/src/features/tools/cron.ts — the 24 h purge of free-tool results (WP-57).
//
// Run inside `jobs-maintain` (server/src/cron/handlers.ts) per brand, inside
// `runWithBrand(brand, …)`. Deletes the brand's `tool_result` rows whose
// 24 h window has passed (claimed or not): the cached report and the text
// read from the visitor's file. Every tool request also purges expired rows,
// so a row never outlives its window by more than the gap between visits
// and this daily run. Returns at once when nothing is due.

import type { CronTask } from '../../platform/queue/index.js';
import { createPrismaToolsStore, type ToolsStore } from './store.js';

/** The purge task over a given store (tests pass the in-memory twin). */
export function createToolsPurge(store: () => ToolsStore = createPrismaToolsStore): CronTask {
  return async (ctx) => {
    const deleted = await store().purgeExpired(ctx.brand.id, ctx.now);
    return deleted ? { processed: deleted } : { skipped: 'no_work', processed: 0 };
  };
}

/** tools purge (run inside jobs-maintain): deletes public-tool results older than 24 h. */
export const runToolsPurge: CronTask = createToolsPurge();
