// backend/src/roboapply/v2/lib/raJobProviders.test.ts
//
// Unit tests for the provider seam + fan-out aggregator. Focus: searchAllProviders
// merges enabled providers in registry order (so direct-apply sources win the
// downstream dedup), tolerates null/throwing providers, and reports accurate
// per-provider telemetry; enabledExternalProviders() honors the kill switches.
// Run: npx vitest run server/src/roboapply/v2/lib/raJobProviders.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  searchAllProviders,
  enabledExternalProviders,
  externalProviders,
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
      fakeProvider('linkedin', async () => [job('linkedin', 'l1')]),
      fakeProvider('jsearch', async () => [job('jsearch', 'j1')]),
    ];
    const r = await searchAllProviders(PARAMS, { providers });
    expect(r.jobs.map((j) => j.externalId)).toEqual([
      'activejobs:a1',
      'activejobs:a2',
      'linkedin:l1',
      'jsearch:j1',
    ]);
    expect(r.providersQueried).toEqual(['activejobs', 'linkedin', 'jsearch']);
    expect(r.providersWithResults).toEqual(['activejobs', 'linkedin', 'jsearch']);
    expect(r.countsByProvider).toEqual({ activejobs: 2, linkedin: 1, jsearch: 1 });
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
      fakeProvider('linkedin', async () => [job('linkedin', 'l1')]),
    ];
    const r = await searchAllProviders(PARAMS, { providers });
    expect(r.jobs.map((j) => j.externalId)).toEqual(['linkedin:l1']);
    expect(r.providersWithResults).toEqual(['linkedin']);
  });
});

describe('externalProviders registry', () => {
  it('is ordered direct-ATS → LinkedIn → aggregator', () => {
    expect(externalProviders.map((p) => p.id)).toEqual(['activejobs', 'linkedin', 'jsearch']);
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

  it('all three enabled with a key and switches off', () => {
    expect(enabledExternalProviders().map((p) => p.id)).toEqual(['activejobs', 'linkedin', 'jsearch']);
  });

  it('global kill switch disables all', () => {
    process.env.RA_ONBOARDING_EXTERNAL_JOBS_DISABLED = 'true';
    expect(enabledExternalProviders()).toEqual([]);
  });

  it('per-provider kill switch removes exactly one, preserving order', () => {
    process.env.RA_ONBOARDING_ACTIVEJOBS_DISABLED = 'true';
    expect(enabledExternalProviders().map((p) => p.id)).toEqual(['linkedin', 'jsearch']);
    process.env.RA_ONBOARDING_JSEARCH_DISABLED = 'true';
    expect(enabledExternalProviders().map((p) => p.id)).toEqual(['linkedin']);
  });
});
