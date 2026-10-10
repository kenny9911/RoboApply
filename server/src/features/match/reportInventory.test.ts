// @vitest-environment node
// WP-77 — the real report inventory (createDefaultReportInventory) against
// mocked search and feed seams: the exact feed.preview arguments (newest
// first, the sample ceiling, fit-tier view off, the target search's filters
// whether or not it is the active search), the count/limiting seams, and the
// D3 aggregate scope end to end — a private import, another market or an
// archived row that preview returns never reaches the report's numbers.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const seams = vi.hoisted(() => ({
  get: vi.fn(),
  getActive: vi.fn(),
  preview: vi.fn(),
  countForFilters: vi.fn(),
  limitingFilters: vi.fn(),
}));

vi.mock('../search/index.js', async (orig) => ({
  ...(await orig<typeof import('../search/index.js')>()),
  searchProfileService: { get: seams.get, getActive: seams.getActive },
}));
vi.mock('../feed/index.js', () => ({
  feedService: { preview: seams.preview, countForFilters: seams.countForFilters, limitingFilters: seams.limitingFilters },
}));

import { getBrand } from '../../platform/brand/registry.js';
import { createCompetitivenessService } from './CompetitivenessService.js';
import { COMPETITIVENESS_LIMITS } from './contract.js';
import { createMemoryFitReportStore } from './reportStore.js';
import { createDefaultReportInventory } from './reportInventory.js';
import { jobRecord, matchUser, reportJobs, searchProfileWire } from './testkit.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

beforeEach(() => {
  Object.values(seams).forEach((f) => f.mockReset());
  seams.countForFilters.mockResolvedValue({ count: 240, capped: false });
  seams.limitingFilters.mockResolvedValue([]);
});

describe('createDefaultReportInventory', () => {
  it('target is the active search: preview reads it newest-first, limit 50, fit-tier view off', async () => {
    const active = searchProfileWire({ id: 'sp1', filters: { workModels: ['onsite'], fitTier: 'great' } });
    seams.getActive.mockResolvedValue(active);
    seams.preview.mockResolvedValue([{ jobId: 'p01' }, { jobId: 'p02' }]);
    const ids = await createDefaultReportInventory().sampleJobIds('u1', active, COMPETITIVENESS_LIMITS.sampleMax);
    expect(ids).toEqual(['p01', 'p02']);
    expect(seams.preview).toHaveBeenCalledTimes(1);
    expect(seams.preview).toHaveBeenCalledWith('u1', { filters: { fitTier: 'all' }, sort: 'newest', limit: 50 });
  });

  it('target is another saved search: every active filter is cleared, then the target\'s filters are set', async () => {
    const active = searchProfileWire({ id: 'sp1', filters: { workModels: ['onsite'], q: 'go', fitTier: 'good' } });
    const target = searchProfileWire({ id: 'sp2', filters: { seniority: ['senior'], fitTier: 'great' } });
    seams.getActive.mockResolvedValue(active);
    seams.preview.mockResolvedValue([]);
    await createDefaultReportInventory().sampleJobIds('u1', target, 50);
    expect(seams.preview).toHaveBeenCalledWith('u1', {
      filters: { workModels: undefined, q: undefined, seniority: ['senior'], fitTier: 'all' },
      sort: 'newest',
      limit: 50,
    });
  });

  it('count drops the fit-tier view; limiting asks the feed for the saved search by id', async () => {
    const inv = createDefaultReportInventory();
    await inv.count('u1', { workModels: ['remote'], fitTier: 'great' });
    expect(seams.countForFilters).toHaveBeenCalledWith('u1', { workModels: ['remote'] });
    await inv.limiting('u1', 'sp1');
    expect(seams.limitingFilters).toHaveBeenCalledWith('u1', 'sp1');
  });
});

describe('the D3 aggregate scope through the real inventory', () => {
  it('a private import, another market or an archived row from preview never reaches the report', async () => {
    const profile = searchProfileWire({ id: 'sp1' });
    seams.get.mockResolvedValue(profile);
    seams.getActive.mockResolvedValue(profile);
    const jobs = [
      ...reportJobs(20, () => ({ educationLevel: 'bachelor', minYears: 2, skillsDetail: [{ skill: 'TypeScript', required: true }] })),
      // The user's own imports: preview lists them (the feed shows them), the report must not count them.
      ...Array.from({ length: 5 }, (_, i) =>
        jobRecord({ id: `mine${i}`, visibility: 'private', ownerUserId: 'u1', educationLevel: 'phd', minYears: 15, skillsDetail: [{ skill: 'Cobol', required: true }] }),
      ),
      jobRecord({ id: 'cn1', market: 'cn' }),
      jobRecord({ id: 'old', archivedAt: new Date('2026-09-01') }),
    ];
    seams.preview.mockResolvedValue(jobs.map((j) => ({ jobId: j.id })));

    const service = createCompetitivenessService({
      inventory: createDefaultReportInventory(),
      store: createMemoryFitReportStore(() => NOW),
      userContext: async () => matchUser({ highestDegree: 'bachelor', yearsExperience: 5, skills: ['TypeScript'], resumeTextNorm: null }),
      getJobs: async (ids) => jobs.filter((j) => ids.includes(j.id)),
      withCredit: (async (_o: unknown, fn: (r: { id: string }) => Promise<unknown>) => fn({ id: 'ledger_1' })) as never,
      entitlements: async () => ({ full: true, upgradable: false }),
      brand: () => getBrand('roboapply'),
      now: () => NOW,
    });
    const r = await service.create('u1', 'sp1', 'key-0001-abcd');

    expect(seams.preview).toHaveBeenCalledWith('u1', { filters: { fitTier: 'all' }, sort: 'newest', limit: 50 });
    expect(r.sample.size).toBe(20);
    expect(r.meetsRequirements).toMatchObject({ met: 20, sampleSize: 20, value: 1 });
    expect(r.topSkills.map((s) => s.skill)).not.toContain('Cobol');
    expect(r.requirements.find((q) => q.key === 'degree')!.typical).toMatchObject({ value: 'bachelor', count: 20, sampleSize: 20 });
    expect(r.requirements.find((q) => q.key === 'years')!.typical).toMatchObject({ value: 2, sampleSize: 20 });
  });
});
