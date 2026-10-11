// @vitest-environment node
//
// The skill vocabulary is loaded before the first estimate (SM-6; MARKET_TASK_PLAN 3.3, "Preparer hook"):
// defaultService.ts registers the loader, `MatchService.userContext` awaits it, and the synchronous estimate then
// compares against the table, not only the committed seed. The table is a fake behind the Prisma module; nothing
// reaches a database.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const table = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reads: 0,
  fail: false,
}));

vi.mock('../../lib/prisma.js', () => ({
  default: {
    rASkill: {
      findMany: vi.fn(async () => {
        table.reads += 1;
        if (table.fail) throw new Error('RASkill is not reachable');
        return table.rows;
      }),
    },
  },
}));

import { getBrand } from '../../platform/brand/registry.js';
import { logger } from '../../services/LoggerService.js';
import { current, resetVocabularyForTests } from '../skills/index.js';
import { defaultMatchService, loadSkillVocabulary } from './defaultService.js';
import { vocabularyAsOf } from './keywordRows.js';
import { createMatchService } from './MatchService.js';
import { registerMatchPreparer, resetMatchPreparersForTests, runMatchPreparers } from './prepare.js';
import { createMemoryRepo, jobRecord } from './testkit.js';

/** A reviewed skill the committed seed does not hold, as a row of RASkill. */
const ZIG = { id: 'zig', kind: 'hard', labelEn: 'Zig', labelZh: null, labelZhHant: null, aliases: ['zig', 'ziglang'], parentId: null, esco: null, onet: null, status: 'reviewed', mentionCount: 3 };

function service(jobs = [jobRecord()]) {
  return createMatchService({
    repo: createMemoryRepo({ jobs }),
    resolveModel: () => null,
    aiAllowed: async () => true,
    brand: () => getBrand('roboapply'),
    env: {},
    now: () => new Date('2026-10-11T08:00:00Z'),
  });
}

beforeEach(() => {
  table.rows = [];
  table.reads = 0;
  table.fail = false;
  resetVocabularyForTests();
  // A fresh process: the loader is registered and has not run yet.
  resetMatchPreparersForTests();
  registerMatchPreparer(loadSkillVocabulary);
  vi.mocked(logger.warn).mockClear();
});

describe('the vocabulary loader is a match preparer', () => {
  it('importing the default service registers it once: registering the same function again adds nothing', async () => {
    table.rows = [ZIG];
    registerMatchPreparer(loadSkillVocabulary);
    await runMatchPreparers();
    await runMatchPreparers();
    expect(table.reads).toBe(1);
  });

  it('ACCEPT: the first estimate after a cold start sees the loaded vocabulary (the preparer was awaited)', async () => {
    table.rows = [ZIG];
    // Before any estimate: the committed seed, which does not know the skill. Nothing has been read.
    expect(current().idOf('Ziglang')).toBeNull();
    expect(current().source).toBe('seed');
    expect(table.reads).toBe(0);

    const job = jobRecord({
      id: 'zig-job',
      skills: ['ziglang', 'typescript'],
      skillsDetail: [
        { skill: 'Ziglang', kind: 'hard', required: true, skillId: 'zig' },
        { skill: 'TypeScript', kind: 'hard', required: true, skillId: 'typescript' },
      ],
      skillIds: ['zig', 'typescript'],
    });
    const svc = service([job]);
    const fits = await svc.fits.getFits('u1', ['zig-job']);

    expect(table.reads).toBe(1);
    expect(current().source).toBe('database');
    expect(current().reviewed('zig')).toBe(true);
    // The person lists TypeScript and Go: of the two required skills one is shown. With only the seed loaded,
    // "zig" would be a skill nobody has reviewed and the part would read 100.
    const fit = fits.get('zig-job')!;
    expect(fit.dimensions.find((d) => d.key === 'skills')).toMatchObject({ status: 'scored', score: 50 });
    expect(fit.skills.missing).toEqual(['Zig']);
    expect(fit.topGap).toBe('Zig');
  });

  it('a table that cannot be read does not take the estimate down: it runs on the committed seed and says so in the log', async () => {
    table.fail = true;
    const fits = await service().fits.getFits('u1', ['job1']);
    expect(fits.get('job1')!.score).not.toBeNull();
    expect(current().source).toBe('seed');
    expect(vi.mocked(logger.warn).mock.calls.some(([area]) => area === 'SKILL_VOCABULARY')).toBe(true);
  });
});

describe('the keyword check of the default service says which vocabulary answered', () => {
  it('vocabularyAsOf is null on the committed seed and the read time once the table is loaded', async () => {
    expect(vocabularyAsOf()).toBeNull();
    table.rows = [ZIG];
    await runMatchPreparers();
    expect(vocabularyAsOf()).toBe(current().asOf!.toISOString());
    expect(typeof defaultMatchService.keywordCheck).toBe('function');
    // The default service is the production service with that one field added to the keyword check: nothing else differs.
    expect(Object.keys(defaultMatchService).sort()).toEqual(Object.keys(service()).sort());
  });
});
