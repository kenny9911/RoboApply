// @vitest-environment node
//
// Which model a market's vectors belong to, and when queries switch to a new one (MKT-2H item 5).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_SWITCH_SHARE, brandOfMarket, currentModelTag, modelTagConfigKey, reconcileModelTag, resetModelTagCacheForTests, writeModelTag } from './modelTag.js';
import type { IndexStats } from './repo.js';

const ENV = { OPENAI_API_KEY: 'sk-test' };
const OLD = 'openai/text-embedding-3-small@1024';
const NEW = 'openai/text-embedding-3-large@1024';

function repo(stored: string | null, stats: Partial<IndexStats> = {}) {
  const config = new Map<string, string>(stored ? [[modelTagConfigKey('intl'), stored]] : []);
  return {
    config,
    getConfig: async (key: string) => config.get(key) ?? null,
    setConfig: async (key: string, value: string) => void config.set(key, value),
    indexStats: async (_market?: string, _tag?: string | null): Promise<IndexStats> => ({ live: 100, missingDoc: 0, withTag: 0, missingVector: 100, missingVectorChars: 0, ...stats }),
  };
}

afterEach(() => resetModelTagCacheForTests());

describe('write tag', () => {
  it('is <model>@1024 of the brand of the market, and null without a key', () => {
    expect(writeModelTag('intl', ENV)).toBe(OLD);
    expect(writeModelTag('cn', { ...ENV, CN_EMBED_MODEL: 'text-embedding-v4' })).toBe('text-embedding-v4@1024');
    expect(writeModelTag('intl', { ...ENV, CN_EMBED_MODEL: 'text-embedding-v4' })).toBe(OLD);
    expect(writeModelTag('intl', {})).toBeNull();
    expect(brandOfMarket('cn')).toBe('goapply');
    expect(brandOfMarket('intl')).toBe('roboapply');
  });
});

describe('currentModelTag', () => {
  it('answers the stored query tag, else the write tag, else null', async () => {
    expect(await currentModelTag('intl', { repo: repo(OLD), env: { ...ENV, EMBED_MODEL: 'openai/text-embedding-3-large' } })).toBe(OLD);
    expect(await currentModelTag('intl', { repo: repo(null), env: ENV })).toBe(OLD);
    expect(await currentModelTag('intl', { repo: repo(null), env: {} })).toBeNull();
    // Stored vectors stay comparable with each other when the key is taken away.
    expect(await currentModelTag('intl', { repo: repo(OLD), env: {} })).toBe(OLD);
  });

  it('falls back to the write tag when the stored value cannot be read', async () => {
    const broken = { getConfig: async () => Promise.reject(new Error('db down')) };
    expect(await currentModelTag('intl', { repo: broken, env: ENV })).toBe(OLD);
  });
});

describe('reconcileModelTag (the switch at the crossover)', () => {
  const env = { ...ENV, EMBED_MODEL: 'openai/text-embedding-3-large' };
  /** One row per job: a job that carries the new tag no longer carries the old one. */
  const during = (live: number, withNew: number, withOld = live - withNew) => {
    const r = repo(OLD);
    const counted: Array<string | null> = [];
    r.indexStats = async (_market?: string, tag?: string | null): Promise<IndexStats> => {
      counted.push(tag ?? null);
      return { live, missingDoc: 0, withTag: tag === NEW ? withNew : tag === OLD ? withOld : 0, missingVector: 0, missingVectorChars: 0 };
    };
    return { r, counted };
  };

  it('makes the first model the query tag at once: there is no older one to keep serving', async () => {
    const r = repo(null, { withTag: 0 });
    expect(await reconcileModelTag('intl', { repo: r, env: ENV })).toEqual({ writeTag: OLD, queryTag: OLD, coverage: null, previousCoverage: null, switched: true });
    expect(r.config.get(modelTagConfigKey('intl'))).toBe(OLD);
  });

  it('keeps the previous model as the query tag while it still covers more live rows than the new one', async () => {
    const { r, counted } = during(100, 49);
    expect(await reconcileModelTag('intl', { repo: r, env })).toEqual({ writeTag: NEW, queryTag: OLD, coverage: 0.49, previousCoverage: 0.51, switched: false });
    expect(r.config.get(modelTagConfigKey('intl'))).toBe(OLD);
    expect(counted).toEqual([NEW, OLD]);
  });

  it('switches at the crossover, so queries always filter on the tag that covers at least half of the vectors', async () => {
    const { r } = during(100, 50);
    expect(await reconcileModelTag('intl', { repo: r, env })).toEqual({ writeTag: NEW, queryTag: NEW, coverage: 0.5, previousCoverage: 0.5, switched: true });
    expect(r.config.get(modelTagConfigKey('intl'))).toBe(NEW);
    expect(MODEL_SWITCH_SHARE).toBe(0.5);
    // Only part of the market ever had a vector: the rule counts vectors, not live rows.
    expect(await reconcileModelTag('intl', { repo: during(1000, 30, 30).r, env })).toMatchObject({ queryTag: NEW, switched: true, coverage: 0.03 });
    expect(await reconcileModelTag('intl', { repo: during(1000, 29, 31).r, env })).toMatchObject({ queryTag: OLD, switched: false });
    // At no point of a re-embedding does the query tag cover less than half of the rows that have a vector.
    for (let withNew = 0; withNew <= 100; withNew += 1) {
      const step = during(100, withNew);
      const state = await reconcileModelTag('intl', { repo: step.r, env });
      const served = state.queryTag === NEW ? withNew : 100 - withNew;
      expect(served, `new=${withNew}`).toBeGreaterThanOrEqual(50);
    }
  });

  it('switches at once when the previous model has no vector left (or never had one)', async () => {
    const { r } = during(100, 0, 0);
    expect(await reconcileModelTag('intl', { repo: r, env })).toMatchObject({ queryTag: NEW, switched: true });
  });

  it('does nothing when the two tags agree or when no key is set', async () => {
    const same = repo(OLD, { live: 100, withTag: 40 });
    const counted = vi.spyOn(same, 'indexStats');
    expect(await reconcileModelTag('intl', { repo: same, env: ENV })).toEqual({ writeTag: OLD, queryTag: OLD, coverage: null, previousCoverage: null, switched: false });
    // The usual run counts nothing: coverage is measured only while the two tags differ.
    expect(counted).not.toHaveBeenCalled();
    const noKey = repo(OLD);
    expect(await reconcileModelTag('intl', { repo: noKey, env: {} })).toEqual({ writeTag: null, queryTag: OLD, coverage: null, previousCoverage: null, switched: false });
    expect(noKey.config.get(modelTagConfigKey('intl'))).toBe(OLD);
  });

  it('keeps the two markets apart', async () => {
    expect(modelTagConfigKey('intl')).toBe('retrieval.modelTag.intl');
    expect(modelTagConfigKey('cn')).toBe('retrieval.modelTag.cn');
  });
});
