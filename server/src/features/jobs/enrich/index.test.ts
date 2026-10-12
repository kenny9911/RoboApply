// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async (kind: string, _payload: unknown, options: { dedupeKey?: string }) => ({ id: 'w1', kind, status: 'pending', dedupeKey: options.dedupeKey ?? null, created: true }));
vi.mock('../../../platform/queue/index.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), enqueue: (...args: Parameters<typeof enqueue>) => enqueue(...args) }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ENRICH_VERSION, EnrichPayloadSchema, REMATCH_GENERATION, enqueueJobEnrich, enqueueJobRematch, enqueueJobSkillRemap, enrichDedupeKey, rematchDedupeKey, requirementsHashRow, skillRemapDedupeKey } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('enrichment work items', () => {
  beforeEach(() => {
    enqueue.mockClear();
  });

  it('a new job: one item per job per version, kept when it already exists', async () => {
    await enqueueJobEnrich('job_1', { market: 'cn' });
    expect(enqueue).toHaveBeenCalledWith('job.enrich', { jobId: 'job_1' }, { brand: 'goapply', dedupeKey: `job.enrich:job_1:v${ENRICH_VERSION}`, onConflict: 'keep' });
    await enqueueJobEnrich('job_1', { changed: true, market: 'intl' });
    expect(enqueue).toHaveBeenLastCalledWith('job.enrich', { jobId: 'job_1', force: true }, { brand: 'roboapply', dedupeKey: enrichDedupeKey('job_1'), onConflict: 'requeue' });
  });

  it('SM-2 backfill: one forced pass per job per rematch generation, never queued twice', async () => {
    const item = await enqueueJobRematch('job_1', { market: 'intl' });
    expect(enqueue).toHaveBeenCalledWith('job.enrich', { jobId: 'job_1', force: true }, { brand: 'roboapply', dedupeKey: `job.enrich:job_1:v${ENRICH_VERSION}:${REMATCH_GENERATION}`, onConflict: 'keep' });
    expect(item.dedupeKey).toBe(rematchDedupeKey('job_1'));
    // Its key differs from the version item's, so it is not swallowed by an item that already ran.
    expect(rematchDedupeKey('job_1')).not.toBe(enrichDedupeKey('job_1'));
    await enqueueJobRematch('job_2', { market: 'cn' });
    expect(enqueue).toHaveBeenLastCalledWith('job.enrich', { jobId: 'job_2', force: true }, expect.objectContaining({ brand: 'goapply', onConflict: 'keep' }));
  });
});

describe('skills-only work items', () => {
  beforeEach(() => {
    enqueue.mockClear();
  });

  it('one skills-only pass per job, version and generation of the vocabulary, never queued twice', async () => {
    const item = await enqueueJobSkillRemap('job_1', { market: 'intl', generation: 'openai/text-embedding-3-small@1024' });
    expect(enqueue).toHaveBeenCalledWith(
      'job.enrich',
      { jobId: 'job_1', skillsOnly: true },
      { brand: 'roboapply', dedupeKey: `job.enrich:job_1:v${ENRICH_VERSION}:skills:openai/text-embedding-3-small@1024`, onConflict: 'keep' },
    );
    expect(item.dedupeKey).toBe(skillRemapDedupeKey('job_1', 'openai/text-embedding-3-small@1024'));
    // Its key is neither the version item's nor the rematch's, and another generation is another item.
    expect(new Set([skillRemapDedupeKey('job_1', 'a'), skillRemapDedupeKey('job_1', 'b'), enrichDedupeKey('job_1'), rematchDedupeKey('job_1')]).size).toBe(4);
    await enqueueJobSkillRemap('job_2', { market: 'cn', generation: 'g1', priority: 200 });
    expect(enqueue).toHaveBeenLastCalledWith('job.enrich', { jobId: 'job_2', skillsOnly: true }, { brand: 'goapply', priority: 200, dedupeKey: skillRemapDedupeKey('job_2', 'g1'), onConflict: 'keep' });
  });

  it('the payload schema carries the flag, and an older payload still parses', () => {
    expect(EnrichPayloadSchema.parse({ jobId: 'j1', skillsOnly: true })).toEqual({ jobId: 'j1', skillsOnly: true });
    expect(EnrichPayloadSchema.parse({ jobId: 'j1' })).toEqual({ jobId: 'j1' });
    expect(EnrichPayloadSchema.safeParse({ jobId: 'j1', skillsOnly: 'yes' }).success).toBe(false);
  });
});

describe('the key of a stored requirement list', () => {
  it('is the posting\'s title and requirement text, with no skills, whatever the row lists', () => {
    expect(requirementsHashRow({ title: 'Backend Engineer', qualifications: 'SQL', descriptionPlain: 'text' })).toEqual({ title: 'Backend Engineer', qualifications: 'SQL', descriptionPlain: 'text', skills: [] });
    const row = { title: 'T', qualifications: null, descriptionPlain: 'D', skills: ['a', 'b'] };
    expect(requirementsHashRow(row).skills).toEqual([]);
  });
});

describe('load order of the enrichment area', () => {
  it('index.ts imports agent.js before service.js', () => {
    // service.js loads the market hooks, and cn/jobs/fraud/llm.ts reads CN_DOMESTIC_PROVIDERS (agent.js)
    // from this index while it is still loading. In the other order a process whose first import is this
    // file (a command-line script) stops with "Cannot access 'CN_DOMESTIC_PROVIDERS' before initialization".
    const source = readFileSync(path.join(here, 'index.ts'), 'utf8');
    const agent = source.indexOf("from './agent.js'");
    const service = source.indexOf("from './service.js'");
    expect(agent).toBeGreaterThan(-1);
    expect(service).toBeGreaterThan(agent);
  });
});
