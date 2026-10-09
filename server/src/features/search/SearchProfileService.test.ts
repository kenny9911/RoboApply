// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { createEntitlementService, DEFAULT_CREDIT_CATALOG, type AccountSnapshot } from '../../platform/credits/index.js';
import {
  AlertFrequencyNotAllowedError,
  InvalidFiltersError,
  LastProfileError,
  SavedSearchLimitError,
  SearchProfileNotFoundError,
  VersionConflictError,
  createSearchProfileService,
  searchErrorToHttp,
} from './SearchProfileService.js';

const PRO: AccountSnapshot = {
  brand: 'roboapply',
  timezone: null,
  subscription: { tier: 'pro', planKey: 'pro_monthly', status: 'active', interval: 'month', currentPeriodEnd: new Date('2099-01-01') },
};
const FREE: AccountSnapshot = { brand: 'roboapply', timezone: null, subscription: null };

function setup(options: { account?: AccountSnapshot; seed?: Record<string, Record<string, unknown>[]> } = {}) {
  const fake = createFakePrisma({ seed: options.seed });
  let account = options.account ?? FREE;
  const entitlements = createEntitlementService({
    source: { loadAccount: async () => account, loadOverrides: async () => [] },
    loadCatalog: async (b) => DEFAULT_CREDIT_CATALOG[b],
    proSellable: () => true,
    memoTtlMs: 0,
  });
  const svc = createSearchProfileService({ getDb: async () => fake as never, entitlements });
  return { fake, svc, setAccount: (a: AccountSnapshot) => (account = a), rows: () => fake.$rows('rASearchProfile') };
}

describe('first read: legacy migration', () => {
  it('creates the default profile from the goal and imports saved searches, once, under an advisory lock', async () => {
    const { svc, fake, rows } = setup({
      seed: {
        rACareerGoal: [{ id: 'g', userId: 'u1', targetTitle: 'Data Analyst', preferredWorkType: 'remote', preferencesBlob: { roleTitles: ['BI Analyst'] } }],
        rASavedSearch: [{ id: 's1', userId: 'u1', name: 'SQL jobs', query: { q: 'sql' }, createdAt: new Date('2026-01-01') }],
      },
    });
    const list = await svc.list('u1');
    expect(list.profiles.map((p) => [p.name, p.isDefault, p.isActive, p.version])).toEqual([
      ['Data Analyst', true, true, 1],
      ['SQL jobs', false, false, 1],
    ]);
    expect(list.profiles[0].filters).toEqual({ titles: ['Data Analyst', 'BI Analyst'], workModels: ['remote'] });
    expect(list.profiles[1].filters).toEqual({ q: 'sql' });
    expect(list).toMatchObject({ maxProfiles: 1, maxInstantAlerts: 1 });
    expect(fake.$sql.texts()).toEqual(['SELECT pg_advisory_xact_lock(hashtext($1))']);
    await svc.list('u1');
    expect(rows()).toHaveLength(2);
  });

  it('gives a user with no legacy data one empty default profile', async () => {
    const { svc } = setup();
    const active = await svc.getActive('u2');
    expect(active).toMatchObject({ name: '', isDefault: true, isActive: true, filters: {} });
  });
});

describe('create', () => {
  it('enforces the saved_searches entitlement (Free 1, Pro 10)', async () => {
    const { svc, setAccount } = setup();
    await svc.list('u1');
    const err = await svc.create('u1', { name: 'Second', filters: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(SavedSearchLimitError);
    expect(searchErrorToHttp(err)).toEqual({ status: 403, body: { error: 'saved_search_limit', max: 1, upgradable: true } });
    setAccount(PRO);
    const p = await svc.create('u1', { name: 'Second', filters: { titles: ['QA'] }, activate: true });
    expect(p).toMatchObject({ name: 'Second', isDefault: false, isActive: true, version: 1, filters: { titles: ['QA'] } });
    const list = await svc.list('u1');
    expect(list.profiles.filter((x) => x.isActive)).toHaveLength(1);
    expect(list.profiles.filter((x) => x.isDefault)).toHaveLength(1);
  });

  it('validates filters for the market and the alert frequency for the plan', async () => {
    const { svc, setAccount } = setup({ account: PRO });
    await expect(svc.create('u1', { name: 'x', filters: { jobTypes: ['gig'] } })).rejects.toBeInstanceOf(InvalidFiltersError);
    const cnOnly = await svc.create('u1', { name: 'x', filters: { classYear: 2027, titles: ['A'] } });
    expect(cnOnly.filters).toEqual({ titles: ['A'] });
    setAccount(FREE);
    await expect(svc.create('u9', { name: 'y', filters: {}, alertInstantMax: 5 })).rejects.toBeInstanceOf(AlertFrequencyNotAllowedError);
  });

  it('moves the default when a new default is created', async () => {
    const { svc } = setup({ account: PRO });
    await svc.list('u1');
    const p = await svc.create('u1', { name: 'New main', filters: {}, isDefault: true });
    const list = await svc.list('u1');
    expect(list.profiles[0].id).toBe(p.id);
    expect(list.profiles.filter((x) => x.isDefault).map((x) => x.id)).toEqual([p.id]);
  });
});

describe('update with optimistic version', () => {
  it('bumps the version and raises VersionConflictError on a stale version', async () => {
    const { svc } = setup();
    const [main] = (await svc.list('u1')).profiles;
    const updated = await svc.update('u1', main.id, { version: 1, filters: { titles: ['Nurse'] }, name: 'Nursing' });
    expect(updated).toMatchObject({ version: 2, name: 'Nursing', filters: { titles: ['Nurse'] } });
    const err = await svc.update('u1', main.id, { version: 1, name: 'Stale' }).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err).toMatchObject({ expectedVersion: 1, currentVersion: 2 });
    expect(searchErrorToHttp(err)).toMatchObject({ status: 409, body: { error: 'version_conflict', currentVersion: 2 } });
    expect((await svc.get('u1', main.id)).name).toBe('Nursing');
  });

  it('patches filters (null clears) at the expected version', async () => {
    const { svc } = setup();
    const [main] = (await svc.list('u1')).profiles;
    await svc.update('u1', main.id, { version: 1, filters: { titles: ['A'], workModels: ['remote'] } });
    const p = await svc.patchFilters('u1', main.id, 2, { workModels: null, skills: ['SQL'] });
    expect(p).toMatchObject({ version: 3, filters: { titles: ['A'], skills: ['SQL'] } });
    await expect(svc.patchFilters('u1', main.id, 2, { skills: ['x'] })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(svc.patchFilters('u1', main.id, 3, { nope: 1 })).rejects.toBeInstanceOf(InvalidFiltersError);
  });

  it('refuses another user’s profile and alert frequencies above the plan', async () => {
    const { svc } = setup();
    const [main] = (await svc.list('u1')).profiles;
    await expect(svc.update('u2', main.id, { version: 1, name: 'x' })).rejects.toBeInstanceOf(SearchProfileNotFoundError);
    await expect(svc.update('u1', main.id, { version: 1, alertInstantMax: 100 })).rejects.toBeInstanceOf(AlertFrequencyNotAllowedError);
    await expect(svc.update('u1', main.id, { version: 1, alertInstantMax: 3 })).rejects.toBeInstanceOf(InvalidFiltersError);
  });
});

describe('default and active invariants', () => {
  it('keeps exactly one default and one active through setDefault, activate and remove', async () => {
    const { svc } = setup({ account: PRO });
    const [main] = (await svc.list('u1')).profiles;
    const b = await svc.create('u1', { name: 'B', filters: {} });
    const c = await svc.create('u1', { name: 'C', filters: {} });

    await svc.setDefault('u1', b.id);
    await svc.activate('u1', c.id);
    let list = (await svc.list('u1')).profiles;
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.id]);
    expect(list.filter((p) => p.isActive).map((p) => p.id)).toEqual([c.id]);

    await svc.remove('u1', c.id); // active removed → default becomes active
    list = (await svc.list('u1')).profiles;
    expect(list.filter((p) => p.isActive).map((p) => p.id)).toEqual([b.id]);

    await svc.remove('u1', b.id); // default removed → oldest remaining becomes default and active
    list = (await svc.list('u1')).profiles;
    expect(list.map((p) => [p.id, p.isDefault, p.isActive])).toEqual([[main.id, true, true]]);

    await expect(svc.remove('u1', main.id)).rejects.toBeInstanceOf(LastProfileError);
    await expect(svc.activate('u1', 'missing')).rejects.toBeInstanceOf(SearchProfileNotFoundError);
  });
});
