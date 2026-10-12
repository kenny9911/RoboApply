// @vitest-environment node
//
// The backfill command line (MKT-2H item 5): a dry run writes nothing; --apply only enqueues.

import { describe, expect, it, vi } from 'vitest';
import type { EnqueueOptions, EnqueuedItem } from '../../platform/queue/index.js';
import { BACKFILL_DEFAULT_LIMIT, formatBackfillReport, parseRetrievalCliArgs, runBackfill, type RetrievalCliDeps } from './cli.js';
import type { IndexStats } from './repo.js';
import { jobIndexBatchDedupeKey } from './sweep.js';

const TAG = 'openai/text-embedding-3-small@1024';
const STATS: IndexStats = { live: 1200, missingDoc: 300, withTag: 800, missingVector: 400, missingVectorChars: 600_000 };

/** The queue double keeps the real conflict rule: 'keep' by default; 'requeue' puts a finished or dead item back. */
function kit(needing: string[] = [], env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-test' }) {
  const enqueued: Array<{ kind: string; payload: unknown; options: EnqueueOptions; status: string; queuedTimes: number }> = [];
  const repo = {
    indexStats: vi.fn(async () => STATS),
    jobsNeedingIndex: vi.fn(async (_m: string, _t: string | null, limit: number) => needing.slice(0, limit)),
    liveJobIds: vi.fn(async (_m: string, limit: number) => ['all_1', 'all_2', 'all_3'].slice(0, limit)),
  };
  const deps: RetrievalCliDeps = {
    repo,
    enqueue: async (kind, payload, options): Promise<EnqueuedItem> => {
      const existing = enqueued.find((e) => e.options.dedupeKey === options.dedupeKey);
      if (!existing) {
        enqueued.push({ kind, payload, options, status: 'queued', queuedTimes: 1 });
        return { id: String(enqueued.length), kind, status: 'queued', dedupeKey: options.dedupeKey ?? null, created: true };
      }
      if (options.onConflict === 'requeue' && existing.status !== 'queued' && existing.status !== 'leased') {
        existing.status = 'queued';
        existing.queuedTimes += 1;
      }
      return { id: '0', kind, status: existing.status as EnqueuedItem['status'], dedupeKey: options.dedupeKey ?? null, created: false };
    },
    env,
    now: () => new Date('2026-10-11T08:30:00Z'),
  };
  return { deps, repo, enqueued };
}

describe('retrieval cli: arguments', () => {
  it('is a dry run unless --apply is given', () => {
    expect(parseRetrievalCliArgs(['backfill', '--market', 'intl'])).toEqual({ market: 'intl', apply: false, all: false, limit: BACKFILL_DEFAULT_LIMIT });
    expect(parseRetrievalCliArgs(['backfill', '--market', 'cn', '--apply', '--limit', '500', '--all'])).toEqual({ market: 'cn', apply: true, all: true, limit: 500 });
  });

  it('refuses a missing task, an unknown market, a bad limit and an unknown option', () => {
    expect(() => parseRetrievalCliArgs(['--market', 'intl'])).toThrow(/Name the task/);
    expect(() => parseRetrievalCliArgs(['reindex', '--market', 'intl'])).toThrow(/Unknown task/);
    expect(() => parseRetrievalCliArgs(['backfill'])).toThrow(/--market must be intl or cn/);
    expect(() => parseRetrievalCliArgs(['backfill', '--market', 'tw'])).toThrow(/--market must be intl or cn/);
    expect(() => parseRetrievalCliArgs(['backfill', '--market', 'intl', '--limit', '0'])).toThrow(/whole number/);
    expect(() => parseRetrievalCliArgs(['backfill', '--market', 'intl', '--force'])).toThrow(/Unknown option/);
  });
});

describe('retrieval cli: backfill', () => {
  it('a dry run prints the counts and the token estimate and writes nothing', async () => {
    const k = kit(['a', 'b']);
    const report = await runBackfill(parseRetrievalCliArgs(['backfill', '--market', 'intl']), k.deps);
    expect(report).toMatchObject({ apply: false, modelTag: TAG, stats: STATS, estimatedTokens: 150_000, selected: 0, itemsQueued: 0, jobsQueued: 0 });
    // Nothing is enqueued and the rows to index are not even listed.
    expect(k.enqueued).toHaveLength(0);
    expect(k.repo.jobsNeedingIndex).not.toHaveBeenCalled();
    expect(k.repo.liveJobIds).not.toHaveBeenCalled();
    const text = formatBackfillReport(report).join('\n');
    expect(text).toContain('DRY RUN (nothing written)');
    expect(text).toContain('Without a search document: 300');
    expect(text).toContain(`Without a vector of ${TAG}: 400`);
    expect(text).toContain('about 150000 (an estimate: characters / 4, not a count)');
    expect(text).toContain('Run again with --apply');
  });

  it('--apply only enqueues job.index items of 96 ids', async () => {
    const needing = Array.from({ length: 200 }, (_, i) => `job_${i}`);
    const k = kit(needing);
    const report = await runBackfill(parseRetrievalCliArgs(['backfill', '--market', 'cn', '--apply']), k.deps);
    expect(report).toMatchObject({ apply: true, selected: 200, itemsQueued: 3, jobsQueued: 200 });
    expect(k.enqueued.map((e) => e.kind)).toEqual(['job.index', 'job.index', 'job.index']);
    expect(k.enqueued.map((e) => (e.payload as { jobIds: string[] }).jobIds.length)).toEqual([96, 96, 8]);
    expect(k.enqueued[0]!.options).toMatchObject({ brand: 'goapply', dedupeKey: jobIndexBatchDedupeKey(needing.slice(0, 96), TAG) });
    expect(formatBackfillReport(report).join('\n')).toContain('Queued: 3 job.index item(s) carrying 200 posting(s)');
  });

  it('a second --apply queues the same rows again when their items finished without vectors or died, and leaves a waiting item alone', async () => {
    const needing = Array.from({ length: 200 }, (_, i) => `job_${i}`);
    const k = kit(needing);
    const args = parseRetrievalCliArgs(['backfill', '--market', 'intl', '--apply']);
    await runBackfill(args, k.deps);
    // The drain ran with the budget spent: two items are done without vectors, one died; the read still returns the rows.
    k.enqueued[0]!.status = 'done';
    k.enqueued[1]!.status = 'dead';
    const again = await runBackfill(args, k.deps);
    expect(again).toMatchObject({ selected: 200, itemsQueued: 3, jobsQueued: 200 });
    expect(k.enqueued.map((e) => [e.status, e.queuedTimes])).toEqual([['queued', 2], ['queued', 2], ['queued', 1]]);
    // An item that is running is never doubled.
    k.enqueued[2]!.status = 'leased';
    expect(await runBackfill(args, k.deps)).toMatchObject({ itemsQueued: 2, jobsQueued: 192 });
    expect(k.enqueued[2]).toMatchObject({ status: 'leased', queuedTimes: 1 });
  });

  it('--limit caps the rows queued and --all takes every live row with its own dedupe keys', async () => {
    const k = kit(Array.from({ length: 500 }, (_, i) => `job_${i}`));
    expect((await runBackfill(parseRetrievalCliArgs(['backfill', '--market', 'intl', '--apply', '--limit', '100']), k.deps)).selected).toBe(100);
    expect(k.repo.jobsNeedingIndex).toHaveBeenCalledWith('intl', TAG, 100);

    const all = kit();
    const report = await runBackfill(parseRetrievalCliArgs(['backfill', '--market', 'intl', '--apply', '--all']), all.deps);
    expect(report).toMatchObject({ all: true, selected: 3, itemsQueued: 1 });
    expect(all.repo.jobsNeedingIndex).not.toHaveBeenCalled();
    expect(all.enqueued[0]!.options.dedupeKey).toMatch(/^job\.index\.batch:[0-9a-f]{40}:all:[0-9a-f]{8}$/);
  });

  it('with no embedding key says so and estimates no tokens', async () => {
    const k = kit([], {});
    const report = await runBackfill(parseRetrievalCliArgs(['backfill', '--market', 'intl']), k.deps);
    expect(report).toMatchObject({ modelTag: null, estimatedTokens: 0 });
    expect(formatBackfillReport(report).join('\n')).toContain('No embedding key is set for this brand');
  });
});
