// WP-75: the frozen legacy V2 client keeps only its live slices; the dead
// ones (queue, activity, integrations, onboarding, discover, jobs, insights,
// saved searches, LinkedIn URL config) are gone from both implementations.
import { describe, expect, it } from 'vitest';
import { realApi } from '../../lib/api/v2/_real';
import { stubApi } from '../../lib/stub/raV2.stub';

const LIVE = ['goal', 'mock', 'preferences', 'resumes', 'search', 'tracker'];
const DEAD = ['queue', 'activity', 'integrations', 'onboarding', 'discover', 'jobs', 'insights'];

describe('legacy V2 client slices', () => {
  it.each([
    ['real', realApi],
    ['stub', stubApi],
  ] as const)('%s implementation exposes only the live slices', (_name, api) => {
    expect(Object.keys(api).sort()).toEqual(LIVE);
    for (const slice of DEAD) expect(api).not.toHaveProperty(slice);
    expect(Object.keys(api.search)).toEqual(['run']);
    expect(api.resumes).not.toHaveProperty('linkedinConfig');
  });

  it('the stub still runs a search against the fixtures', async () => {
    const res = await stubApi.search.run({ limit: 2 });
    expect(Array.isArray(res.jobs)).toBe(true);
    expect(res.jobs.length).toBeLessThanOrEqual(2);
  });
});
