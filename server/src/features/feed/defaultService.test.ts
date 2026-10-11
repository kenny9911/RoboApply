// @vitest-environment node
// WP-32: the personalisation switch the feed reads (GoApply: a live 个性化推荐 grant, fail closed; RoboApply: always).
// MKT-4F: the production wiring of hybrid retrieval and of the thin-search ingest request. Nothing here reaches a
// database, an embeddings endpoint or a job provider: the platform client is replaced by its own test seam and the
// ingest entry point is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hasLiveConsent = vi.fn();
vi.mock('../../platform/consent/index.js', () => ({ hasLiveConsent: (...a: unknown[]) => hasLiveConsent(...a) }));
const ingestForProfile = vi.fn();
vi.mock('../jobs/ingest/index.js', () => ({ ingestForProfile: (...a: unknown[]) => ingestForProfile(...a) }));

import { setEmbeddingsClientForTests } from '../../platform/embeddings/index.js';
import { defaultFeedDeps, defaultFeedEmbeddings, defaultFeedRetrieval, defaultRequestIngest } from './defaultService.js';
import { isFeedPersonalized } from './index.js';

beforeEach(() => {
  hasLiveConsent.mockReset();
  ingestForProfile.mockReset();
});
afterEach(() => {
  setEmbeddingsClientForTests(null);
  vi.unstubAllEnvs();
});

describe('isFeedPersonalized', () => {
  it('RoboApply is always personalised and reads no consent', async () => {
    expect(await isFeedPersonalized('u1', 'intl')).toBe(true);
    expect(hasLiveConsent).not.toHaveBeenCalled();
  });

  it('GoApply needs a live personalized_recommendation grant (unset or off → recency order)', async () => {
    hasLiveConsent.mockResolvedValueOnce(true);
    expect(await isFeedPersonalized('u1', 'cn')).toBe(true);
    expect(hasLiveConsent).toHaveBeenCalledWith('u1', 'personalized_recommendation');
    hasLiveConsent.mockResolvedValueOnce(false);
    expect(await isFeedPersonalized('u1', 'cn')).toBe(false);
  });

  it('fails closed when the consent lookup fails', async () => {
    hasLiveConsent.mockRejectedValueOnce(new Error('db down'));
    expect(await isFeedPersonalized('u1', 'cn')).toBe(false);
  });
});

describe('production wiring of hybrid retrieval (MKT-4F)', () => {
  it('the default dependencies carry the embeddings client, the stored vectors and the ingest request', () => {
    const deps = defaultFeedDeps();
    expect(deps.embeddings).toBe(defaultFeedEmbeddings);
    expect(deps.retrieval).toBe(defaultFeedRetrieval);
    expect(deps.requestIngest).toBe(defaultRequestIngest);
  });

  it('a query vector is asked of the one platform client, as a query, for the brand of the request', async () => {
    const calls: unknown[][] = [];
    setEmbeddingsClientForTests({
      embedTexts: async (...args: unknown[]) => {
        calls.push(args);
        return { unavailable: 'no_key' as const };
      },
    });
    const res = await defaultFeedEmbeddings.embedTexts('goapply', ['后端 kafka'], { purpose: 'query', carriesUserData: true, userId: 'u1' });
    expect(res).toEqual({ unavailable: 'no_key' });
    expect(calls).toEqual([['goapply', ['后端 kafka'], { purpose: 'query', carriesUserData: true, userId: 'u1' }]]);
  });

  it('the tag of a new query vector is the brand\'s embedding setting, and null when the brand has no key (then nothing is asked)', () => {
    for (const name of ['OPENAI_API_KEY', 'EMBED_API_KEY', 'EMBED_BASE_URL', 'EMBED_MODEL', 'CN_EMBED_API_KEY', 'CN_EMBED_BASE_URL', 'CN_EMBED_MODEL']) vi.stubEnv(name, '');
    expect(defaultFeedRetrieval.queryModelTag!('roboapply')).toBeNull();
    expect(defaultFeedRetrieval.queryModelTag!('goapply')).toBeNull();
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-a-secret');
    expect(defaultFeedRetrieval.queryModelTag!('roboapply')).toBe('openai/text-embedding-3-small@1024');
    // GoApply falls back to the shared settings (D5) and takes its own model when one is named.
    expect(defaultFeedRetrieval.queryModelTag!('goapply')).toBe('openai/text-embedding-3-small@1024');
    vi.stubEnv('CN_EMBED_MODEL', 'text-embedding-v4');
    expect(defaultFeedRetrieval.queryModelTag!('goapply')).toBe('text-embedding-v4@1024');
    expect(defaultFeedRetrieval.queryModelTag!('roboapply')).toBe('openai/text-embedding-3-small@1024');
  });

  it('the thin-search ingest request plans and queues the profile with no time budget: nothing runs inside the request', async () => {
    ingestForProfile.mockResolvedValue({ planned: 2, deferred: 2 });
    await defaultRequestIngest('sp9');
    expect(ingestForProfile).toHaveBeenCalledTimes(1);
    expect(ingestForProfile).toHaveBeenCalledWith('sp9', 0);
  });
});
