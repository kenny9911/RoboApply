// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLONE_SKUS, FEATURE_OTHER, PLATFORM_SKUS, featureForSku } from './raFeatureCatalog.js';

describe('raFeatureCatalog clone SKUs (ARCHITECTURE.md §7.5)', () => {
  it('maps every new SKU (and the two cross-bank ones) to a real feature', () => {
    expect(CLONE_SKUS).toHaveLength(19);
    for (const sku of CLONE_SKUS) expect(featureForSku(sku), sku).not.toBe(FEATURE_OTHER);
    expect(featureForSku('ra_crossbank_score').key).toBe('crossbank');
    expect(featureForSku('ra_copilot_turn')).toMatchObject({ key: 'assistant', modality: 'llm' });
    expect(featureForSku('ra_resume_grade').key).toBe('resume_check');
  });

  it('the GoApply fraud check has its own SKU: a platform cost, not folded into job enrichment (WP-41)', () => {
    expect(CLONE_SKUS).toContain('ra_cn_fraud_check');
    expect(featureForSku('ra_cn_fraud_check')).toEqual({ key: 'job_fraud_check', label: 'Job Fraud Check', modality: 'llm' });
    expect(featureForSku('ra_cn_fraud_check').key).not.toBe(featureForSku('ra_job_enrich').key);
    expect(PLATFORM_SKUS.has('ra_cn_fraud_check')).toBe(true);
    expect(PLATFORM_SKUS.has('ra_job_enrich')).toBe(true);
    // M2 gate (MKT-2H request 3): the embeddings client logs under 'ra_embed' (platform/embeddings/usage.ts
    // EMBED_COST_SKU; client.test.ts pins the value); it is a platform cost with its own feature, not "Other".
    expect(featureForSku('ra_embed')).toEqual({ key: 'embedding', label: 'Embeddings', modality: 'llm' });
    expect(CLONE_SKUS).toContain('ra_embed');
    expect(PLATFORM_SKUS.has('ra_embed')).toBe(true);
  });

  it('keeps existing mappings and the Other fallback', () => {
    expect(featureForSku('mock_interview')).toMatchObject({ key: 'mock_interview', interview: true });
    expect(featureForSku('ra_cover_letter').key).toBe('cover_letter');
    expect(featureForSku('unknown_sku')).toBe(FEATURE_OTHER);
    expect([...PLATFORM_SKUS].every((s) => (CLONE_SKUS as readonly string[]).includes(s))).toBe(true);
  });
});
