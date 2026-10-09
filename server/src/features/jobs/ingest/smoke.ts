// server/src/features/jobs/ingest/smoke.ts — live smoke of the inventory pipeline (WP-16b).
//
//   npx tsx server/src/features/jobs/ingest/smoke.ts --brand roboapply --dry-run [--with-demand] [--limit 25]
//   npx tsx server/src/features/jobs/ingest/smoke.ts --brand roboapply [--budget-ms 120000]
//
// --dry-run prints the planned queries and the exact RapidAPI params each
// would send, WITHOUT calling any provider (and without touching the
// database unless --with-demand reads users' default profiles). When
// RAPID_API_KEY is absent the script always runs as --dry-run.
// Without --dry-run it runs the planner and one ingest tick against the
// database in DATABASE_URL — use the clone's Neon branch, never production.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../../../.env'), override: false });
dotenv.config({ path: path.resolve(here, '../../../../../.env.local'), override: false });

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const { getBrand, parseBrandId, runWithBrand } = await import('../../../platform/brand/index.js');
  const brand = getBrand(parseBrandId(arg('brand') ?? 'roboapply') ?? 'roboapply');
  const limit = Number(arg('limit') ?? 25);
  const keyMissing = !process.env.RAPID_API_KEY?.trim();
  const dryRun = flag('dry-run') || keyMissing;
  if (keyMissing && !flag('dry-run')) console.log('RAPID_API_KEY is not set: running as --dry-run (no provider is called).');

  const { adaptersForBrand } = await import('./providers.js');
  const { mergeTuples, planQueries, seedTuples, collectDemand, runPlanner } = await import('./planner.js');
  const { rapidApiSearchParams } = await import('./adapters/rapidApi.js');
  const adapters = adaptersForBrand(brand);
  console.log(`brand=${brand.id} market=${brand.market} adapters=${adapters.map((a) => `${a.provider}${a.isEnabled() ? '' : '(disabled)'}`).join(',')}`);

  if (dryRun) {
    let demand: Awaited<ReturnType<typeof collectDemand>> = [];
    if (flag('with-demand')) {
      const { default: prisma } = await import('../../../lib/prisma.js');
      demand = await collectDemand(prisma, brand, new Date());
    }
    const planned = planQueries(mergeTuples(demand, seedTuples(brand)), adapters);
    console.log(`planned ${planned.length} queries (${demand.length} demand tuples); first ${Math.min(limit, planned.length)}:`);
    for (const p of planned.slice(0, limit)) {
      const wire = p.provider === 'activejobs' || p.provider === 'linkedin' || p.provider === 'jsearch' ? rapidApiSearchParams(p.params, p.provider) : null;
      console.log(JSON.stringify({ provider: p.provider, origin: p.origin, priority: p.priority, params: p.params, wire }));
    }
    return;
  }

  const { default: prisma } = await import('../../../lib/prisma.js');
  const { runIngestTick } = await import('./run.js');
  await runWithBrand(brand.id, async () => {
    const plan = await runPlanner(prisma, brand, adapters);
    console.log('plan', JSON.stringify(plan));
    const tally = await runIngestTick({ db: prisma, brand, adapters, budgetMs: Number(arg('budget-ms') ?? 120_000) });
    console.log('ingest', JSON.stringify(tally));
  });
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
