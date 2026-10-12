// @vitest-environment node
// WP-77 — the real report inventory (createDefaultReportInventory) against
// mocked search and feed seams: the sample comes from the feed's
// `sampleForFilters` seam (the target search's own filters, newest first,
// PUBLIC rows only, at most 400, fit-tier view off) and the inventory returns
// exactly what the seam returns — nothing is dropped afterwards. Plus the
// count/limiting seams and the D3 aggregate scope end to end.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const seams = vi.hoisted(() => ({
  get: vi.fn(),
  getActive: vi.fn(),
  preview: vi.fn(),
  sampleForFilters: vi.fn(),
  countForFilters: vi.fn(),
  limitingFilters: vi.fn(),
}));

vi.mock('../search/index.js', async (orig) => ({
  ...(await orig<typeof import('../search/index.js')>()),
  searchProfileService: { get: seams.get, getActive: seams.getActive },
}));
vi.mock('../feed/index.js', () => ({
  feedService: { preview: seams.preview, sampleForFilters: seams.sampleForFilters, countForFilters: seams.countForFilters, limitingFilters: seams.limitingFilters },
}));

import { getBrand } from '../../platform/brand/registry.js';
import { createCompetitivenessService } from './CompetitivenessService.js';
import { COMPETITIVENESS_LIMITS } from './contract.js';
import { createMemoryFitReportStore } from './reportStore.js';
import { SAMPLE_SEAM_MAX, createDefaultReportInventory } from './reportInventory.js';
import { jobRecord, matchUser, reportJobs, searchProfileWire } from './testkit.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

beforeEach(() => {
  Object.values(seams).forEach((f) => f.mockReset());
  seams.countForFilters.mockResolvedValue({ count: 240, capped: false });
  seams.limitingFilters.mockResolvedValue([]);
});

describe('createDefaultReportInventory', () => {
  it("reads the target search's own filters through the feed sample seam: newest first, public only, fit-tier view off", async () => {
    const target = searchProfileWire({ id: 'sp2', filters: { seniority: ['senior'], workModels: ['onsite'], fitTier: 'great' } });
    seams.sampleForFilters.mockResolvedValue(['p01', 'p02']);
    const ids = await createDefaultReportInventory().sampleJobIds('u1', target, COMPETITIVENESS_LIMITS.sampleMax);
    expect(ids).toEqual(['p01', 'p02']);
    expect(seams.sampleForFilters).toHaveBeenCalledTimes(1);
    expect(seams.sampleForFilters).toHaveBeenCalledWith('u1', { seniority: ['senior'], workModels: ['onsite'] }, { order: 'newest', limit: 50, publicOnly: true });
    // The active search is not read and the ranked preview is not used: the sample is the target's filters only.
    expect(seams.getActive).not.toHaveBeenCalled();
    expect(seams.preview).not.toHaveBeenCalled();
  });

  it('caps the sample at 400 whatever the caller asks for, and never asks for fewer than one', async () => {
    seams.sampleForFilters.mockResolvedValue([]);
    const inv = createDefaultReportInventory();
    const profile = searchProfileWire({ id: 'sp1' });
    await inv.sampleJobIds('u1', profile, 5000);
    expect(SAMPLE_SEAM_MAX).toBe(400);
    expect(seams.sampleForFilters).toHaveBeenLastCalledWith('u1', profile.filters, { order: 'newest', limit: 400, publicOnly: true });
    await inv.sampleJobIds('u1', profile, 400);
    expect(seams.sampleForFilters).toHaveBeenLastCalledWith('u1', profile.filters, { order: 'newest', limit: 400, publicOnly: true });
    await inv.sampleJobIds('u1', profile, 0);
    expect(seams.sampleForFilters).toHaveBeenLastCalledWith('u1', profile.filters, { order: 'newest', limit: 1, publicOnly: true });
  });

  it('returns exactly what the seam returns, in its order: no row is dropped after the fact', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `job${String(i).padStart(3, '0')}`);
    seams.sampleForFilters.mockResolvedValue(ids);
    expect(await createDefaultReportInventory().sampleJobIds('u1', searchProfileWire({ id: 'sp1' }), 400)).toEqual(ids);
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
  it('asks the feed for public rows only, and the report counts every row the seam returned', async () => {
    const profile = searchProfileWire({ id: 'sp1' });
    seams.get.mockResolvedValue(profile);
    const jobs = reportJobs(20, () => ({ educationLevel: 'bachelor', minYears: 2, skillsDetail: [{ skill: 'TypeScript', required: true }] }));
    seams.sampleForFilters.mockResolvedValue(jobs.map((j) => j.id));

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

    expect(seams.sampleForFilters).toHaveBeenCalledWith('u1', profile.filters, { order: 'newest', limit: 50, publicOnly: true });
    expect(r.sample.size).toBe(20);
    expect(r.meetsRequirements).toMatchObject({ met: 20, sampleSize: 20, value: 1 });
    expect(r.requirements.find((q) => q.key === 'degree')!.typical).toMatchObject({ value: 'bachelor', count: 20, sampleSize: 20 });
    expect(r.requirements.find((q) => q.key === 'years')!.typical).toMatchObject({ value: 2, sampleSize: 20 });
  });

  it('second guard: were a private import, another market or an archived row ever returned, the report would still not count it', async () => {
    const profile = searchProfileWire({ id: 'sp1' });
    seams.get.mockResolvedValue(profile);
    const jobs = [
      ...reportJobs(20, () => ({ educationLevel: 'bachelor', minYears: 2, skillsDetail: [{ skill: 'TypeScript', required: true }] })),
      ...Array.from({ length: 5 }, (_, i) =>
        jobRecord({ id: `mine${i}`, visibility: 'private', ownerUserId: 'u1', educationLevel: 'phd', minYears: 15, skillsDetail: [{ skill: 'Cobol', required: true }] }),
      ),
      jobRecord({ id: 'cn1', market: 'cn' }),
      jobRecord({ id: 'old', archivedAt: new Date('2026-09-01') }),
    ];
    seams.sampleForFilters.mockResolvedValue(jobs.map((j) => j.id));
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
    const r = await service.create('u1', 'sp1', 'key-0002-abcd');
    expect(r.sample.size).toBe(20);
    expect(r.topSkills.map((s) => s.skill)).not.toContain('Cobol');
  });
});
