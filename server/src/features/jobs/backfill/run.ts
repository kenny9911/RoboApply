// server/src/features/jobs/backfill/run.ts — command line for the M1 data backfills (SM-2, SM-10).
//
//   npx tsx server/src/features/jobs/backfill/run.ts <task> --market intl|cn [--apply] [--limit n]
//
// Tasks:
//   rematch-roles          re-match stored roles with today's title matcher (rematchRoles.ts)
//   clear-implausible-pay  clear stored pay figures that cannot be pay (clearImplausiblePay.ts)
//
// WITHOUT --apply THIS IS A DRY RUN: it reads the database in DATABASE_URL,
// prints how many rows would change and 20 sample changes, and writes nothing
// (no row update, no work item). Read the dry run first. --apply writes to
// that database: an owner or orchestrator step, never run by accident against
// production. --limit stops after n rows. One market per run, so the two
// brands are never mixed.
//
// `rematch-roles --apply` makes no model call itself. Jobs whose title does
// not decide their role are queued as `job.enrich` items; the queue drains
// them inside the market's daily enrichment budget (ENRICH_DAILY_JOBS), one
// model call per job at most.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearImplausiblePay, type ClearPayReport, type PayDb } from './clearImplausiblePay.js';
import { rematchRoles, type BackfillMarket, type RematchDb, type RematchReport } from './rematchRoles.js';

export const BACKFILL_TASKS = ['rematch-roles', 'clear-implausible-pay'] as const;
export type BackfillTask = (typeof BACKFILL_TASKS)[number];

/** Sample changes printed by the command line. */
export const BACKFILL_SAMPLE_SIZE = 20;

export const BACKFILL_USAGE = `Usage: tsx server/src/features/jobs/backfill/run.ts <${BACKFILL_TASKS.join('|')}> --market intl|cn [--apply] [--limit n]
Without --apply nothing is written (dry run).`;

export interface BackfillArgs {
  task: BackfillTask;
  market: BackfillMarket;
  apply: boolean;
  limit: number | null;
}

/** Command line → options. Throws with the usage text on bad input. A dry run unless --apply is given. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const fail = (message: string): never => {
    throw new Error(`${message}\n${BACKFILL_USAGE}`);
  };
  const known = new Set(['--market', '--apply', '--limit']);
  let task: string | null = null;
  let market: string | null = null;
  let limit: number | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') apply = true;
    else if (a === '--market') market = argv[++i] ?? null;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) fail('--limit needs a whole number above 0.');
      limit = n;
    } else if (a.startsWith('--') || known.has(a)) fail(`Unknown option ${a}.`);
    else if (task === null) task = a;
    else fail(`Unexpected argument ${a}.`);
  }
  if (!task || !(BACKFILL_TASKS as readonly string[]).includes(task)) fail(task ? `Unknown task ${task}.` : 'Name a task.');
  if (market !== 'intl' && market !== 'cn') fail('--market must be intl or cn.');
  return { task: task as BackfillTask, market: market as BackfillMarket, apply, limit };
}

export interface BackfillDeps {
  db: RematchDb & PayDb;
  /** Queue one enrichment for a job; resolves to false when the item already existed. */
  enqueue: (job: { jobId: string; market: BackfillMarket; stale: boolean }) => Promise<boolean>;
  enrichVersion: number;
}

/** Run one task with the given dependencies (the command line passes the real database and queue). */
export async function runBackfill(args: BackfillArgs, deps: BackfillDeps): Promise<RematchReport | ClearPayReport> {
  if (args.task === 'rematch-roles') {
    return rematchRoles({ market: args.market, apply: args.apply, limit: args.limit, db: deps.db, enqueue: deps.enqueue, enrichVersion: deps.enrichVersion });
  }
  return clearImplausiblePay({ market: args.market, apply: args.apply, limit: args.limit, db: deps.db });
}

/** The lines the command line prints for a report: the counts, then up to 20 sample changes. */
export function formatBackfillReport(report: RematchReport | ClearPayReport): string[] {
  const mode = report.apply ? 'APPLIED' : 'DRY RUN: nothing was written';
  const lines = [`${report.task} · market ${report.market} · ${mode}`];
  const would = report.apply ? '' : 'would be ';
  if (report.task === 'rematch-roles') {
    lines.push(
      `Rows read: ${report.scanned}`,
      `Title scores ${would}written: ${report.scores}`,
      `Roles ${would}moved to the role the title names: ${report.moved}`,
      `Roles ${would}removed (set by a one-word match that no longer exists; the title names no role): ${report.cleared}`,
      `Rows ${would}queued for enrichment because the title does not decide (the model does): ${report.queued}${report.apply ? ` (${report.queuedNew} new work items)` : ''}`,
      `Rows left alone because a model already decided their role at the current version: ${report.decidedByModel}`,
    );
    // Rows whose role changes first, then rows that are only queued.
    const changed = report.changes.filter((c) => c.action !== 'kept');
    const samples = [...changed, ...report.changes.filter((c) => c.action === 'kept')].slice(0, BACKFILL_SAMPLE_SIZE);
    if (samples.length) lines.push(`Sample changes (${samples.length} of ${report.changes.length}):`);
    for (const c of samples) lines.push(`  ${JSON.stringify({ jobId: c.jobId, from: c.from, to: c.to, score: c.score })} ${c.action}${c.queued ? ', queued' : ''} · ${c.title}`);
  } else {
    lines.push(`Rows with a pay figure read: ${report.scanned}`, `Rows whose figures ${would}cleared (the posting's words are kept): ${report.cleared}`);
    const samples = report.changes.slice(0, BACKFILL_SAMPLE_SIZE);
    if (samples.length) lines.push(`Sample changes (${samples.length} of ${report.changes.length}):`);
    for (const c of samples) lines.push(`  ${JSON.stringify(c)}`);
  }
  if (!report.apply) lines.push('Run again with --apply to write these changes.');
  return lines;
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(here, '../../../../../.env'), override: false });
  dotenv.config({ path: path.resolve(here, '../../../../../.env.local'), override: false });
  // Loaded only now: importing this file (tests) never opens a database connection.
  const prisma = (await import('../../../lib/prisma.js')).default;
  const enrich = await import('../enrich/index.js');
  const report = await runBackfill(args, {
    db: prisma as unknown as RematchDb & PayDb,
    enrichVersion: enrich.ENRICH_VERSION,
    enqueue: async ({ jobId, market, stale }) => {
      // A row still at an older version gets the item jobs-maintain would queue for it (one model pass, not two).
      const item = stale ? await enrich.enqueueJobEnrich(jobId, { market }) : await enrich.enqueueJobRematch(jobId, { market });
      return item.created;
    },
  });
  // eslint-disable-next-line no-console
  console.log(formatBackfillReport(report).join('\n'));
}

// Run only as a script (`npx tsx …/run.ts`), never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
