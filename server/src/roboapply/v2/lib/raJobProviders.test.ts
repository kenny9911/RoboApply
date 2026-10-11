// backend/src/roboapply/v2/lib/raJobProviders.test.ts
//
// Unit tests for the provider seam + fan-out aggregator. Focus: searchAllProviders
// merges enabled providers in registry order (so direct-apply sources win the
// downstream dedup), tolerates null/throwing providers, and reports accurate
// per-provider telemetry; enabledExternalProviders() honors the kill switches.
// The LinkedIn feed is not a provider (MARKET_STRATEGY M-4, JI-2): it is in no
// list and the fan-out never calls a client with that id.
// Run: npx vitest run server/src/roboapply/v2/lib/raJobProviders.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  searchAllProviders,
  enabledExternalProviders,
  externalProviders,
  isDroppedProvider,
  type JobSearchProvider,
  type ExternalJobNormalized,
  type ExternalSourceBoard,
} from './raJobProviders.js';

function job(board: ExternalSourceBoard, id: string): ExternalJobNormalized {
  return {
    externalId: `${board}:${id}`,
    sourceBoard: board,
    title: `Job ${id}`,
    company: 'Co',
    companyLogoUrl: null,
    location: null,
    locationCity: null,
    locationCountry: null,
    workType: 'unknown',
    employmentType: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
    postedAt: '2026-07-13T00:00:00.000Z',
    applyUrl: `https://x/${id}`,
    applyIsDirect: board !== 'jsearch',
    description: '',
    sourcePublisher: null,
  };
}

function fakeProvider(
  id: ExternalSourceBoard,
  impl: () => Promise<ExternalJobNormalized[] | null>,
): JobSearchProvider {
  return { id, isEnabled: () => true, search: impl };
}

const PARAMS = { query: 'engineer', country: 'us' };

describe('searchAllProviders — merge + order + telemetry', () => {
  it('empty provider set → empty result', async () => {
    const r = await searchAllProviders(PARAMS, { providers: [] });
    expect(r.jobs).toEqual([]);
    expect(r.providersQueried).toEqual([]);
    expect(r.providersWithResults).toEqual([]);
  });

  it('merges in the given provider order (direct-ATS first)', async () => {
    const providers = [
      fakeProvider('activejobs', async () => [job('activejobs', 'a1'), job('activejobs', 'a2')]),
      fakeProvider('jsearch', async () => [job('jsearch', 'j1')]),
    ];
    const r = await searchAllProviders(PARAMS, { providers });
    expect(r.jobs.map((j) => j.externalId)).toEqual(['activejobs:a1', 'activejobs:a2', 'jsearch:j1']);
    expect(r.providersQueried).toEqual(['activejobs', 'jsearch']);
    expect(r.providersWithResults).toEqual(['activejobs', 'jsearch']);
    expect(r.countsByProvider).toEqual({ activejobs: 2, jsearch: 1 });
  });

  it('a provider returning null contributes nothing but is still queried', async () => {
    const providers = [
      fakeProvider('activejobs', async () => null),
      fakeProvider('jsearch', async () => [job('jsearch', 'j1')]),
    ];
    const r = await searchAllProviders(PARAMS, { providers });
    expect(r.jobs.map((j) => j.externalId)).toEqual(['jsearch:j1']);
    expect(r.providersQueried).toEqual(['activejobs', 'jsearch']);
    expect(r.providersWithResults).toEqual(['jsearch']);
    expect(r.countsByProvider).toEqual({ activejobs: 0, jsearch: 1 });
  });

  it('a throwing provider (contract violation) is swallowed, not rejected', async () => {
    const providers = [
      fakeProvider('activejobs', async () => {
        throw new Error('boom');
      }),
      fakeProvider('jsearch', async () => [job('jsearch', 'j1')]),
    ];
    const r = await searchAllProviders(PARAMS, { providers });
    expect(r.jobs.map((j) => j.externalId)).toEqual(['jsearch:j1']);
    expect(r.providersQueried).toEqual(['activejobs', 'jsearch']);
    expect(r.providersWithResults).toEqual(['jsearch']);
  });
});

describe('the LinkedIn feed is never called (MARKET_STRATEGY M-4, JI-2)', () => {
  it('a LinkedIn provider handed to the fan-out is not searched and not reported', async () => {
    const linkedinSearch = vi.fn(async () => [job('linkedin', 'l1')]);
    const linkedinEnabled = vi.fn(() => true);
    const providers: JobSearchProvider[] = [
      fakeProvider('activejobs', async () => [job('activejobs', 'a1')]),
      { id: 'linkedin', isEnabled: linkedinEnabled, search: linkedinSearch },
      fakeProvider('jsearch', async () => [job('jsearch', 'j1')]),
    ];
    const r = await searchAllProviders(PARAMS, { providers });
    expect(linkedinSearch).not.toHaveBeenCalled();
    expect(r.jobs.map((j) => j.externalId)).toEqual(['activejobs:a1', 'jsearch:j1']);
    expect(r.providersQueried).toEqual(['activejobs', 'jsearch']);
    expect(r.countsByProvider).toEqual({ activejobs: 1, jsearch: 1 });
  });

  it('a fan-out given only a LinkedIn provider queries nothing', async () => {
    const search = vi.fn(async () => [job('linkedin', 'l1')]);
    const r = await searchAllProviders(PARAMS, { providers: [{ id: 'linkedin', isEnabled: () => true, search }] });
    expect(search).not.toHaveBeenCalled();
    expect(r).toEqual({ jobs: [], providersQueried: [], providersWithResults: [], countsByProvider: {} });
  });

  it('names the dropped id and nothing the product runs', () => {
    expect(isDroppedProvider('linkedin')).toBe(true);
    for (const p of externalProviders) expect(isDroppedProvider(p.id), p.id).toBe(false);
  });
});

describe('externalProviders registry', () => {
  it('holds the two RapidAPI providers the product runs, direct-ATS before the aggregator, and no LinkedIn provider', () => {
    expect(externalProviders.map((p) => p.id)).toEqual(['activejobs', 'jsearch']);
  });
});

describe('enabledExternalProviders — kill switches', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of [
      'RA_ONBOARDING_EXTERNAL_JOBS_DISABLED',
      'RA_ONBOARDING_JSEARCH_DISABLED',
      'RA_ONBOARDING_ACTIVEJOBS_DISABLED',
      'RA_ONBOARDING_LINKEDIN_JOBS_DISABLED',
    ]) {
      delete process.env[k];
    }
    process.env.RAPID_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('none enabled without a key', () => {
    delete process.env.RAPID_API_KEY;
    expect(enabledExternalProviders()).toEqual([]);
  });

  it('both enabled with a key and switches off; a key never enables LinkedIn', () => {
    expect(enabledExternalProviders().map((p) => p.id)).toEqual(['activejobs', 'jsearch']);
  });

  it('global kill switch disables all', () => {
    process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED = 'true';
    expect(enabledExternalProviders()).toEqual([]);
  });

  it('per-provider kill switch removes exactly one, preserving order', () => {
    process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED = 'true';
    expect(enabledExternalProviders().map((p) => p.id)).toEqual(['jsearch']);
    process.env.RA_ONBOARDING_JSEARCH_DISABLED = 'true';
    expect(enabledExternalProviders()).toEqual([]);
  });
});
