// server/src/features/network/cron.ts — area cron tasks (WP-54).
//
// Called by server/src/cron/handlers.ts (Vercel Cron) and RoboApplyCronService
// inside `runWithBrand(brand, …)` with a 240 s budget.

import { brandEnv } from '../../platform/brand/brandEnv.js';
import type { CronTask } from '../../platform/queue/index.js';

/**
 * contacts-sync (04:45 UTC daily): syncs recruiters who opted in to being
 * contactable (OPS-A10). Returns at once with `skipped: 'optin_api_not_configured'`
 * until the brand's opt-in API is configured; never writes without it.
 */
export const runContactsSync: CronTask = async (ctx) => {
  if (!brandEnv(ctx.brand, 'CONTACT_OPTIN_API_URL') || !brandEnv(ctx.brand, 'CONTACT_OPTIN_API_KEY')) {
    return { skipped: 'optin_api_not_configured', processed: 0 };
  }
  const [{ bankClients }, { normalizeCompanyName }, sync] = await Promise.all([
    import('../jobs/ingest/index.js'),
    import('../jobs/normalize/index.js'),
    import('./contactsSync.js'),
  ]);
  const market = ctx.brand.market === 'cn' ? 'cn' : 'intl';
  const bank = bankClients.bankForMarket(market);
  return sync.syncContacts(
    {
      fetchOptInRecords: sync.optInApiReader(ctx.brand),
      bankReader: sync.bankRecruiterReader(bankClients, bank),
      ...sync.prismaSyncedContacts(),
      normalizeCompany: normalizeCompanyName,
      bank,
    },
    market,
    ctx.now,
  );
};
