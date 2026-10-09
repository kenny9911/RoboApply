// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EnrichOutputError, EnrichPayloadSchema, MAX_ENRICH_SKILLS, parseEnrichOutput, parseEnrichText } from './schema.js';
import { intlModelReply } from './__tests__/fixtures.js';

describe('enrichment output schema', () => {
  it('accepts a well-formed reply', () => {
    const out = parseEnrichOutput(intlModelReply());
    expect(out.taxonomyId).toBe('backend_engineer');
    expect(out.seniority).toBe('mid');
    expect(out.skills).toHaveLength(4);
    expect(out.sponsorship).toEqual({ status: 'not_offered', quote: 'We are unable to sponsor work visas for this role.' });
    expect(out.citizenshipRequired).toEqual({ value: true, quote: 'Applicants must be US citizens due to a government contract.' });
    expect(out.clearanceRequired).toBeNull();
    expect(out.employerTags).toEqual([]);
  });

  it('rejects anything that is not a JSON object', () => {
    expect(() => parseEnrichOutput(null)).toThrow(EnrichOutputError);
    expect(() => parseEnrichOutput([intlModelReply()])).toThrow(EnrichOutputError);
    expect(() => parseEnrichOutput('{"a":1}')).toThrow(EnrichOutputError);
  });

  it('turns bad enums and missing fields into "not stated" instead of failing the whole reply', () => {
    const out = parseEnrichOutput({ seniority: 'wizard', educationLevel: 'kindergarten', sponsorship: { status: 'maybe', quote: 42 } });
    expect(out.taxonomyId).toBeNull();
    expect(out.seniority).toBeNull();
    expect(out.educationLevel).toBeNull();
    expect(out.skills).toEqual([]);
    expect(out.sponsorship).toEqual({ status: 'not_stated', quote: null });
    expect(out.citizenshipRequired).toBeNull();
    expect(out.summary).toBeNull();
  });

  it('drops malformed skills and keeps at most 15', () => {
    const skills = [
      { skill: '', kind: 'hard', required: true },
      { kind: 'hard' },
      'python',
      { skill: '  Data   modeling ', kind: 'weird', required: 'yes' },
      ...Array.from({ length: 20 }, (_, i) => ({ skill: `skill ${i}`, kind: 'soft', required: false })),
    ];
    const out = parseEnrichOutput({ skills });
    expect(out.skills).toHaveLength(MAX_ENRICH_SKILLS);
    expect(out.skills[0]).toEqual({ skill: 'Data modeling', kind: 'hard', required: false });
  });

  it('keeps one entry per employer tag and drops unknown tags', () => {
    const out = parseEnrichOutput({
      employerTags: [
        { tag: 'soe', quote: '中央企业' },
        { tag: 'soe', quote: '国企' },
        { tag: 'unicorn', quote: 'x' },
        { tag: 'hukou', quote: null },
      ],
    });
    expect(out.employerTags).toEqual([
      { tag: 'soe', quote: '中央企业' },
      { tag: 'hukou', quote: null },
    ]);
  });

  it('reads fenced, prefixed or bare JSON text', () => {
    const json = JSON.stringify(intlModelReply());
    expect(parseEnrichText('```json\n' + json + '\n```').taxonomyId).toBe('backend_engineer');
    expect(parseEnrichText('Here you go: ' + json).seniority).toBe('mid');
    expect(parseEnrichText(json).skills).toHaveLength(4);
    expect(() => parseEnrichText('I cannot help with that.')).toThrow(EnrichOutputError);
  });

  it('validates the work item payload', () => {
    expect(EnrichPayloadSchema.safeParse({ jobId: 'j1' }).success).toBe(true);
    expect(EnrichPayloadSchema.safeParse({ jobId: 'j1', force: true }).success).toBe(true);
    expect(EnrichPayloadSchema.safeParse({}).success).toBe(false);
    expect(EnrichPayloadSchema.safeParse({ jobId: '' }).success).toBe(false);
  });
});
