// server/src/features/retrieval/cli.ts — command line for the first fill of the search index (MKT-2H).
//
//   npx tsx server/src/features/retrieval/cli.ts backfill --market intl|cn [--apply] [--limit n] [--all]
//
// WITHOUT --apply THIS IS A DRY RUN: it reads the database in DATABASE_URL,
// prints how many live postings of the market lack a search document or a
// vector of the configured model, and an ESTIMATE of the tokens the vectors
// would cost (characters / 4), and writes nothing (no row, no work item).
//
// --apply only ENQUEUES `job.index` items of 96 postings each. It embeds
// nothing itself: the queue drains them (`queue-drain`), inside the brand's
// daily token budget (EMBED_DAILY_TOKENS). --limit caps the postings queued in
// this run (default 9,600). One market per run, so the two brands never mix.
//
// --all queues every live posting, not only those that lack something: use it
// after the tokenizer or the Traditional → Simplified table changed
// (buildHantHans.ts), because stored documents then hold other tokens than a
// query. A posting whose card text is unchanged is not embedded again.
//
// An owner or orchestrator step: never run by a work-package engineer and
// never by accident against production.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import { brandOfMarket, writeModelTag } from './modelTag.js';
import type { IndexStats, RetrievalRepo } from './repo.js';
import { jobIndexBatchDedupeKey } from './sweep.js';
import { JOB_INDEX_MAX_IDS, RETRIEVAL_WORK_KINDS, type JobIndexPayload } from './workers.js';

export const RETRIEVAL_CLI_USAGE = `Usage: tsx server/src/features/retrieval/cli.ts backfill --market intl|cn [--apply] [--limit n] [--all]
Without --apply nothing is written (dry run).`;

export const BACKFILL_DEFAULT_LIMIT = 9600;

export interface RetrievalCliArgs {
  market: 'intl' | 'cn';
  apply: boolean;
  all: boolean;
  limit: number;
}

/** Command line → options. Throws with the usage text on bad input. A dry run unless --apply is given. */
export function parseRetrievalCliArgs(argv: readonly string[]): RetrievalCliArgs {
  const fail = (message: string): never => {
    throw new Error(`${message}\n${RETRIEVAL_CLI_USAGE}`);
  };
  let task: string | null = null;
  let market: string | null = null;
  let limit = BACKFILL_DEFAULT_LIMIT;
  let apply = false;
  let all = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--apply') apply = true;
    else if (a === '--all') all = true;
    else if (a === '--market') market = argv[++i] ?? null;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) fail('--limit needs a whole number above 0.');
      limit = n;
    } else if (a.startsWith('--')) fail(`Unknown option ${a}.`);
    else if (task === null) task = a;
    else fail(`Unexpected argument ${a}.`);
  }
  if (task !== 'backfill') fail(task ? `Unknown task ${task}.` : 'Name the task: backfill.');
  if (market !== 'intl' && market !== 'cn') fail('--market must be intl or cn.');
  return { market: market as 'intl' | 'cn', apply, all, limit };
}

export interface RetrievalCliDeps {
  repo: Pick<RetrievalRepo, 'indexStats' | 'jobsNeedingIndex' | 'liveJobIds'>;
  enqueue: (kind: string, payload: JobIndexPayload, options: EnqueueOptions) => Promise<EnqueuedItem>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface BackfillReport {
  market: 'intl' | 'cn';
  apply: boolean;
  all: boolean;
  /** `<model>@1024`, or null when no embedding key is set for the brand (search documents only). */
  modelTag: string | null;
  stats: IndexStats;
  /** characters / 4 of the card texts still to embed. An estimate, not a count. */
  estimatedTokens: number;
  /** Postings this run looked at for queueing (0 in a dry run). */
  selected: number;
  /** Items waiting to run after this command: new ones and finished or dead ones set to run again. */
  itemsQueued: number;
  jobsQueued: number;
}

export async function runBackfill(args: RetrievalCliArgs, deps: RetrievalCliDeps): Promise<BackfillReport> {
  const modelTag = writeModelTag(args.market, deps.env);
  const stats = await deps.repo.indexStats(args.market, modelTag);
  const report: BackfillReport = {
    market: args.market,
    apply: args.apply,
    all: args.all,
    modelTag,
    stats,
    estimatedTokens: modelTag ? Math.ceil(stats.missingVectorChars / 4) : 0,
    selected: 0,
    itemsQueued: 0,
    jobsQueued: 0,
  };
  // A dry run reads the two counts above and nothing else: no row and no work item is written.
  if (!args.apply) return report;

  const ids = args.all ? await deps.repo.liveJobIds(args.market, args.limit) : await deps.repo.jobsNeedingIndex(args.market, modelTag, args.limit);
  report.selected = ids.length;
  // A re-index of everything must run even where an earlier item for the same ids is still on record: its key carries the
  // hour of the run. Without --all the read returned rows that still lack something, so a finished or dead item for the
  // same rows runs again ('requeue'); one that is queued or running is left alone.
  const runTag = args.all ? `:all:${crypto.createHash('sha1').update((deps.now ?? (() => new Date()))().toISOString().slice(0, 13)).digest('hex').slice(0, 8)}` : '';
  for (let i = 0; i < ids.length; i += JOB_INDEX_MAX_IDS) {
    const batch = ids.slice(i, i + JOB_INDEX_MAX_IDS);
    const item = await deps.enqueue(RETRIEVAL_WORK_KINDS.jobIndex, { jobIds: batch }, { dedupeKey: `${jobIndexBatchDedupeKey(batch, modelTag)}${runTag}`, onConflict: 'requeue', brand: brandOfMarket(args.market), priority: 300 });
    if (item.created || item.status === 'queued') {
      report.itemsQueued += 1;
      report.jobsQueued += batch.length;
    }
  }
  return report;
}

export function formatBackfillReport(r: BackfillReport): string[] {
  const lines = [
    `${r.apply ? 'APPLY' : 'DRY RUN (nothing written)'}: retrieval backfill, market ${r.market}`,
    `Live public postings (enriched): ${r.stats.live}`,
    `Without a search document: ${r.stats.missingDoc}`,
    r.modelTag
      ? `Without a vector of ${r.modelTag}: ${r.stats.missingVector} (with one: ${r.stats.withTag})`
      : 'No embedding key is set for this brand: only search documents are written; no vector is made.',
  ];
  if (r.modelTag) lines.push(`Tokens to embed them: about ${r.estimatedTokens} (an estimate: characters / 4, not a count).`);
  if (r.apply) {
    lines.push(`Postings selected${r.all ? ' (--all)' : ''}: ${r.selected}`);
    lines.push(`Queued: ${r.itemsQueued} job.index item(s) carrying ${r.jobsQueued} posting(s). The queue embeds them inside the daily token budget.`);
  } else lines.push('Run again with --apply to queue the work.');
  return lines;
}

async function main(): Promise<void> {
  const args = parseRetrievalCliArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: path.resolve(here, '../../../../.env'), override: false });
  dotenv.config({ path: path.resolve(here, '../../../../.env.local'), override: false });
  // Loaded only now: importing this file (tests) never opens a database connection.
  const [{ defaultRetrievalRepo }, queue] = await Promise.all([import('./repo.js'), import('../../platform/queue/index.js')]);
  const report = await runBackfill(args, { repo: defaultRetrievalRepo, enqueue: (kind, payload, options) => queue.enqueue(kind, payload, options) });
  // eslint-disable-next-line no-console
  console.log(formatBackfillReport(report).join('\n'));
}

// Run only as a script (`npx tsx …/cli.ts`), never when imported.
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
