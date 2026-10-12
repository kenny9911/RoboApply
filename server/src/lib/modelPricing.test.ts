// @vitest-environment node
//
// Embedding prices (MKT-2H): a model is priced only by a row read on its
// vendor's pricing page; anything else has an unknown cost, never the default tier.

import { describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL_PRICING_PER_1M, calculateEmbeddingCost, lookupEmbeddingRate } from './modelPricing.js';

describe('embedding model pricing', () => {
  it('prices the default model by its bare id, its prefixed id and its stored tag', () => {
    expect(EMBEDDING_MODEL_PRICING_PER_1M['text-embedding-3-small']).toBe(0.02);
    for (const id of ['text-embedding-3-small', 'openai/text-embedding-3-small', 'openai/text-embedding-3-small@1024', 'OpenAI/Text-Embedding-3-Small@1024']) {
      expect(lookupEmbeddingRate(id)).toBe(0.02);
    }
    expect(calculateEmbeddingCost('openai/text-embedding-3-small@1024', 50_000_000)).toBeCloseTo(1, 10);
    expect(calculateEmbeddingCost('text-embedding-3-small', 0)).toBe(0);
  });

  it('answers null, not a default price, for a model with no row', () => {
    expect(lookupEmbeddingRate('text-embedding-v4')).toBeNull();
    expect(lookupEmbeddingRate('openai/text-embedding-3-large@1024')).toBeNull();
    expect(lookupEmbeddingRate('toString')).toBeNull();
    expect(calculateEmbeddingCost('text-embedding-v4@1024', 1_000_000)).toBeNull();
    expect(calculateEmbeddingCost('text-embedding-3-small', Number.NaN)).toBeNull();
    expect(calculateEmbeddingCost('text-embedding-3-small', -1)).toBeNull();
  });

  it('holds only the rows whose price was read from the vendor', () => {
    expect(Object.keys(EMBEDDING_MODEL_PRICING_PER_1M)).toEqual(['text-embedding-3-small']);
  });
});
