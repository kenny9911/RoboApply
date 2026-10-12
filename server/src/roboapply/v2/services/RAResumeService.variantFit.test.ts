// @vitest-environment node
//
// M2 gate (match-retrieval): `/v2/resumes` never sends the stored copy of a
// variant's fit (`RAResumeVariant.matchScoreCached`). A variant's fit is the
// "With this version" number: shown only in tailoring and read live there
// (`getVariantFit`; MARKET_STRATEGY §2.2, MKT-2F item 3). The Resumes hub and
// Settings printed the stored copy, with no label, kind or date.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('../../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../../test/fakePrisma.js');
  fake.db = createFakePrisma();
  return { default: fake.db };
});
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { RAResumeService } from './RAResumeService.js';

const AT = new Date('2026-10-01T00:00:00.000Z');

beforeEach(async () => {
  await fake.db.rAResumeVariant.deleteMany({});
  await fake.db.rAResumeVariant.create({
    data: {
      id: 'rv_t',
      userId: 'u_1',
      name: 'For Acme',
      kind: 'tailored_for_jd',
      targetJobId: null,
      resumeMarkdown: '# Ada',
      resumeContentHash: 'h',
      // What MatchService wrote at the last model call for this version and its target job.
      matchScoreCached: 91,
      isPrimary: false,
      lastEditedAt: AT,
      createdAt: AT,
      deletedAt: null,
    },
  });
});

describe('RAResumeService never sends a stored variant fit', () => {
  it('the list (Resumes hub, Settings) and the single view (editor) both answer matchScoreCached null', async () => {
    const service = new RAResumeService();
    const list = await service.list('u_1');
    expect(list.map((r) => [r.id, r.matchScoreCached])).toEqual([['rv_t', null]]);
    const view = await service.getById('u_1', 'rv_t');
    expect(view.matchScoreCached).toBeNull();
    expect(JSON.stringify([list, view])).not.toContain('91');
  });
});
