// @vitest-environment node
//
// `similarJobIds`: the feed seam Similar jobs reads (MKT-2H item 6). Fake retrieval reads only.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSimilarJobsDepsForTests, similarJobIds, type SimilarJobsDeps } from './index.js';

const TAG = 'openai/text-embedding-3-small@1024';

function fake(over: Partial<SimilarJobsDeps> = {}) {
  const deps = {
    currentModelTag: vi.fn(async () => TAG as string | null),
    nearestJobsByJob: vi.fn(async () => [{ jobId: 'job_9', distance: 0.1 }, { jobId: 'job_4', distance: 0.2 }, { jobId: 'job_7', distance: 0.3 }]),
    ...over,
  };
  setSimilarJobsDepsForTests(deps);
  return deps;
}

afterEach(() => setSimilarJobsDepsForTests(null));

describe('similarJobIds', () => {
  it('returns the ids of the nearest jobs in distance order, within the row market and country, under the current model tag', async () => {
    const deps = fake();
    expect(await similarJobIds({ id: 'job_1', market: 'intl', locationCountry: 'US' }, 50)).toEqual(['job_9', 'job_4', 'job_7']);
    expect(deps.currentModelTag).toHaveBeenCalledWith('intl');
    expect(deps.nearestJobsByJob).toHaveBeenCalledWith('job_1', { market: 'intl', country: 'US', modelTag: TAG, limit: 50 });
  });

  it('passes no country for a row without one, and never another market than the row has', async () => {
    const deps = fake();
    await similarJobIds({ id: 'job_cn', market: 'cn' }, 20);
    expect(deps.currentModelTag).toHaveBeenCalledWith('cn');
    expect(deps.nearestJobsByJob).toHaveBeenCalledWith('job_cn', { market: 'cn', country: null, modelTag: TAG, limit: 20 });
  });

  it('is null when the market has no model tag: no read is made', async () => {
    const deps = fake({ currentModelTag: vi.fn(async () => null) });
    expect(await similarJobIds({ id: 'job_1', market: 'intl' }, 50)).toBeNull();
    expect(deps.nearestJobsByJob).not.toHaveBeenCalled();
  });

  it('is null when the job has no vector', async () => {
    fake({ nearestJobsByJob: vi.fn(async () => []) });
    expect(await similarJobIds({ id: 'job_1', market: 'intl' }, 50)).toBeNull();
  });

  it('is null when a read fails: the caller falls back to its own list', async () => {
    fake({ nearestJobsByJob: vi.fn(async () => Promise.reject(new Error('relation "RAJobEmbedding" does not exist'))) });
    expect(await similarJobIds({ id: 'job_1', market: 'intl' }, 50)).toBeNull();
    fake({ currentModelTag: vi.fn(async () => Promise.reject(new Error('db down'))) });
    expect(await similarJobIds({ id: 'job_1', market: 'intl' }, 50)).toBeNull();
  });
});
