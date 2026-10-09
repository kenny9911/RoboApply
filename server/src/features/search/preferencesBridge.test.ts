// @vitest-environment node
//
// WP-20: the legacy preferences blob no longer stores job-targeting keys; they
// are projected from the active search profile and written through to it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { VersionConflictError, createSearchProfileService, type SearchProfileWire } from './index.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { createEntitlementService, DEFAULT_CREDIT_CATALOG } from '../../platform/credits/index.js';
import { DEAD_AGENT_KNOBS, RAPreferencesService } from '../../roboapply/v2/services/RAPreferencesService.js';

function profile(over: Partial<SearchProfileWire> = {}): SearchProfileWire {
  return {
    id: 'sp1',
    name: '',
    isDefault: true,
    isActive: true,
    version: 1,
    schemaVersion: 1,
    filters: {},
    alertInstantMax: 0,
    alertDigest: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

let blob: Record<string, unknown> | null;
let active: SearchProfileWire;
const upserts: Array<Record<string, unknown>> = [];
const db = {
  rACareerGoal: {
    findUnique: vi.fn(async () => (blob ? { preferencesBlob: blob } : null)),
    upsert: vi.fn(async (args: { update: { preferencesBlob: Record<string, unknown> } }) => {
      blob = args.update.preferencesBlob;
      upserts.push(blob);
      return {};
    }),
  },
};
const searchProfiles = {
  getActive: vi.fn(async () => active),
  update: vi.fn(async (_userId: string, _id: string, input: { version: number; filtersPatch?: unknown }) => {
    if (input.version !== active.version) throw new VersionConflictError(active.id, input.version, active.version, active);
    active = { ...active, version: active.version + 1, filters: { ...active.filters, ...(input.filtersPatch as object) } };
    for (const [k, v] of Object.entries(active.filters)) if (v === null) delete (active.filters as Record<string, unknown>)[k];
    return active;
  }),
};

const svc = new RAPreferencesService({ getDb: async () => db as never, searchProfiles: searchProfiles as never, currency: () => 'USD' });

beforeEach(() => {
  blob = null;
  active = profile({ filters: { titles: ['Data Analyst'], workModels: ['remote'] } });
  upserts.length = 0;
  vi.clearAllMocks();
});

describe('GET (projection)', () => {
  it('projects the job-targeting keys from the active search profile and drops the dead knobs', async () => {
    blob = { roleTitles: ['Stale title'], digest: 'weekly', aggressiveness: 'aggressive', dailyCap: 50 };
    const { preferences } = await svc.get('u1');
    expect(preferences.roleTitles).toEqual(['Data Analyst']);
    expect(preferences.workModes).toEqual({ remote: true, hybrid: false, onsite: false });
    expect(preferences.digest).toBe('weekly');
    for (const k of DEAD_AGENT_KNOBS) expect(preferences).not.toHaveProperty(k);
  });

  it('falls back to the stored values when the store cannot be read', async () => {
    blob = { roleTitles: ['Stored title'] };
    searchProfiles.getActive.mockRejectedValueOnce(new Error('db down'));
    const { preferences } = await svc.get('u1');
    expect(preferences.roleTitles).toEqual(['Stored title']);
  });
});

describe('PATCH (write-through)', () => {
  it('never writes job-targeting keys or dead knobs to the blob; changes them on the search profile', async () => {
    const { preferences } = await svc.update('u1', {
      roleTitles: ['BI Analyst'],
      cities: ['Denver'],
      digest: 'daily',
      dailyCap: 30,
    } as never);
    const stored = upserts.at(-1)!;
    for (const k of ['roleTitles', 'cities', 'workModes', 'salaryMinK', 'companyStages', ...DEAD_AGENT_KNOBS]) expect(stored, k).not.toHaveProperty(k);
    expect(stored.digest).toBe('daily');
    expect(searchProfiles.update).toHaveBeenCalledWith('u1', 'sp1', {
      version: 1,
      filtersPatch: { titles: ['BI Analyst'], locations: [{ label: 'Denver', city: 'Denver', radiusKm: 40 }] },
    });
    expect(preferences.roleTitles).toEqual(['BI Analyst']);
    expect(preferences.cities).toEqual(['Denver']);
  });

  it('sends nothing to the search profile when the whole projected draft comes back (Settings save)', async () => {
    const { preferences } = await svc.get('u1');
    await svc.update('u1', { ...preferences, notif: { response: { email: false, push: true, sms: false } } });
    expect(searchProfiles.update).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
  });

  it('retries once on a version conflict with the fresh profile', async () => {
    let first = true;
    searchProfiles.update.mockImplementationOnce(async () => {
      if (first) {
        first = false;
        active = { ...active, version: 2 };
        throw new VersionConflictError('sp1', 1, 2, active);
      }
      return active;
    });
    await svc.update('u1', { industriesTarget: ['Fintech'] });
    expect(searchProfiles.update).toHaveBeenCalledTimes(2);
    expect(searchProfiles.update).toHaveBeenLastCalledWith('u1', 'sp1', { version: 2, filtersPatch: { industries: ['Fintech'] } });
  });

  it('keeps blockedCompanies in the blob (privacy) and mirrors it into excludedCompanies', async () => {
    await svc.update('u1', { blockedCompanies: ['Initech'] });
    expect(upserts.at(-1)!.blockedCompanies).toEqual(['Initech']);
    expect(active.filters.excludedCompanies).toEqual(['Initech']);
  });

  it('writes the blob (e.g. the onboarding stamp) before a failing search write, then throws', async () => {
    searchProfiles.getActive.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.update('u1', { roleTitles: ['X'], onboarding: { completedAt: '2026-10-10' } })).rejects.toThrow('db down');
    expect(upserts.at(-1)!.onboarding).toEqual({ completedAt: '2026-10-10' });
    // The change did not reach a search profile, so it stays in the blob for the migration.
    expect(upserts.at(-1)!.roleTitles).toEqual(['X']);
  });

  it('asks for the active profile (running the legacy migration) before it rewrites the blob', async () => {
    await svc.update('u1', { onboarding: { completedAt: '2026-10-10' } });
    const firstGetActive = searchProfiles.getActive.mock.invocationCallOrder[0];
    const firstUpsert = db.rACareerGoal.upsert.mock.invocationCallOrder[0];
    expect(firstGetActive).toBeLessThan(firstUpsert);
  });

  it('keeps the legacy job-targeting keys in the blob when the search store is down, and does not throw for a non-search patch', async () => {
    blob = { roleTitles: ['Data Analyst'], cities: ['Denver'], salaryMinK: 90, dailyCap: 20 };
    searchProfiles.getActive.mockRejectedValue(new Error('db down'));
    const { preferences } = await svc.update('u1', { onboarding: { completedAt: '2026-10-10' } });
    const stored = upserts.at(-1)!;
    expect(stored).toMatchObject({ roleTitles: ['Data Analyst'], cities: ['Denver'], salaryMinK: 90, onboarding: { completedAt: '2026-10-10' } });
    expect(stored).not.toHaveProperty('dailyCap');
    expect(preferences.roleTitles).toEqual(['Data Analyst']);
    expect(searchProfiles.update).not.toHaveBeenCalled();
    searchProfiles.getActive.mockReset();
    searchProfiles.getActive.mockImplementation(async () => active);
  });
});

describe('legacy migration ordering (real search-profile service)', () => {
  it('migrates an existing user\'s targeting keys before a non-search write strips them from the blob', async () => {
    const fake = createFakePrisma({
      seed: {
        rACareerGoal: [
          {
            id: 'g1',
            userId: 'legacy',
            targetTitle: '',
            preferencesBlob: { roleTitles: ['Data Analyst'], cities: ['Denver'], salaryMinK: 90, digest: 'weekly' },
          },
        ],
      },
    });
    const entitlements = createEntitlementService({
      source: { loadAccount: async () => ({ brand: 'roboapply', timezone: null, subscription: null }), loadOverrides: async () => [] },
      loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b],
      proSellable: () => true,
      memoTtlMs: 0,
    });
    const realProfiles = createSearchProfileService({ getDb: async () => fake as never, entitlements, loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b] });
    const realSvc = new RAPreferencesService({ getDb: async () => fake as never, searchProfiles: realProfiles, currency: () => 'USD' });

    // What RAOnboardingService.markSeen / skip send.
    await realSvc.update('legacy', { onboarding: { autoOpens: 1, lastSeenStep: 'resume' } });

    const storedBlob = fake.$rows('rACareerGoal')[0].preferencesBlob as Record<string, unknown>;
    expect(storedBlob).not.toHaveProperty('roleTitles');
    expect(storedBlob).not.toHaveProperty('cities');
    expect(storedBlob).toMatchObject({ digest: 'weekly', onboarding: { autoOpens: 1, lastSeenStep: 'resume' } });

    const activeProfile = await realProfiles.getActive('legacy');
    expect(activeProfile.filters.titles).toEqual(['Data Analyst']);
    expect(activeProfile.filters.locations?.map((l) => l.city)).toEqual(['Denver']);
    expect(activeProfile.filters.salaryMin).toMatchObject({ amount: 90000 });

    const { preferences } = await realSvc.get('legacy');
    expect(preferences).toMatchObject({ roleTitles: ['Data Analyst'], cities: ['Denver'], salaryMinK: 90 });
  });
});
