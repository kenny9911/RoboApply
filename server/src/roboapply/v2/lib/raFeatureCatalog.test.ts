// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLONE_SKUS, FEATURE_OTHER, PLATFORM_SKUS, featureForSku } from './raFeatureCatalog.js';

describe('raFeatureCatalog clone SKUs (ARCHITECTURE.md §7.5)', () => {
  it('maps every new SKU (and the two cross-bank ones) to a real feature', () => {
    expect(CLONE_SKUS).toHaveLength(17);
    for (const sku of CLONE_SKUS) expect(featureForSku(sku), sku).not.toBe(FEATURE_OTHER);
    expect(featureForSku('ra_crossbank_score').key).toBe('crossbank');
    expect(featureForSku('ra_copilot_turn')).toMatchObject({ key: 'assistant', modality: 'llm' });
    expect(featureForSku('ra_resume_grade').key).toBe('resume_check');
  });

  it('keeps existing mappings and the Other fallback', () => {
    expect(featureForSku('mock_interview')).toMatchObject({ key: 'mock_interview', interview: true });
    expect(featureForSku('ra_cover_letter').key).toBe('cover_letter');
    expect(featureForSku('unknown_sku')).toBe(FEATURE_OTHER);
    expect([...PLATFORM_SKUS].every((s) => (CLONE_SKUS as readonly string[]).includes(s))).toBe(true);
  });
});
