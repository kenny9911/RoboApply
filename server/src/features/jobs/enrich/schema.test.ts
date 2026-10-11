// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENRICH_REQUIREMENTS_MAX,
  ENRICH_INDUSTRY_IDS,
  ENRICH_REQUIREMENTS_CEILING,
  ENRICH_VERSION,
  EnrichOutputError,
  EnrichPayloadSchema,
  MAX_ENRICH_SKILLS,
  MAX_REQUIREMENT_CHARS,
  REQUIREMENT_KINDS,
  enrichRequirementsMax,
  parseEnrichOutput,
  parseEnrichText,
} from './schema.js';
import { JobRequirementSchema } from '../../match/contract.js';
import { ONBOARDING_INDUSTRIES } from '../../onboarding/contract.js';
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
    expect(out.industry).toBeNull();
  });

  it('SM-6 / SM-8 / JI-11: the version is 3, so rows enriched before canonical skill ids, stored requirements and the sponsorship source are enriched again', () => {
    expect(ENRICH_VERSION).toBe(3);
  });

  it('SM-10: reads the employer industry only as a value of the closed list with a quote', () => {
    expect([...ENRICH_INDUSTRY_IDS]).toEqual(ONBOARDING_INDUSTRIES.map((i) => i.id));
    const quote = 'We build accounting software for small businesses.';
    expect(parseEnrichOutput({ industry: { value: 'B2B SaaS', quote } }).industry).toEqual({ value: 'B2B SaaS', quote });
    // The id in another case, or its slug, is the same value.
    expect(parseEnrichOutput({ industry: { value: 'b2b saas', quote } }).industry).toEqual({ value: 'B2B SaaS', quote });
    expect(parseEnrichOutput({ industry: { value: 'ai_ml', quote: `  ${quote}  ` } }).industry).toEqual({ value: 'AI / ML', quote });
    // Anything else is "not stated": a value outside the list, no quote, a wrong shape, nothing.
    for (const industry of [{ value: 'Space mining', quote }, { value: 'Fintech' }, { value: 'Fintech', quote: '' }, { value: 'Fintech', quote: 7 }, { quote }, 'Fintech', ['Fintech'], null, undefined]) {
      expect(parseEnrichOutput({ industry }).industry, JSON.stringify(industry)).toBeNull();
    }
    // A sloppy industry never costs the rest of the reply.
    expect(parseEnrichOutput({ ...intlModelReply(), industry: 42 }).taxonomyId).toBe('backend_engineer');
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

  describe('SM-8: requirement lines', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('reads well-formed lines, in the model\'s order', () => {
      const out = parseEnrichOutput({
        requirements: [
          { kind: 'experience', text: '5+ years building backend services', importance: 'must' },
          { kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
        ],
      });
      expect(out.requirements).toEqual([
        { kind: 'experience', text: '5+ years building backend services', importance: 'must' },
        { kind: 'skill', text: 'Nice to have: Kubernetes', importance: 'preferred' },
      ]);
      // A reply without the field, or with something that is not a list, has none.
      expect(parseEnrichOutput({}).requirements).toEqual([]);
      for (const requirements of [null, 'none', 7, { kind: 'skill' }]) expect(parseEnrichOutput({ requirements }).requirements, JSON.stringify(requirements)).toEqual([]);
    });

    it('is lenient per item: a bad item is dropped, never the list and never the reply', () => {
      const out = parseEnrichOutput({
        ...intlModelReply(),
        requirements: [
          'Python',
          null,
          { kind: 'logistics', text: 'Based in Austin', importance: 'must' },
          { kind: 'skill', importance: 'must' },
          { kind: 'skill', text: '', importance: 'must' },
          { kind: 'skill', text: 'x'.repeat(MAX_REQUIREMENT_CHARS + 1), importance: 'must' },
          { kind: 'education', text: '  Bachelor\u2019s   degree\n in CS ', importance: 'essential' },
          { kind: 'domain', text: '熟悉支付行业', importance: 'must' },
          { kind: 'scope', text: 'y'.repeat(MAX_REQUIREMENT_CHARS), importance: 'preferred' },
        ],
      });
      expect(out.requirements).toEqual([
        // Whitespace is collapsed; an importance the model did not state clearly is "preferred", never "must".
        { kind: 'education', text: 'Bachelor\u2019s degree in CS', importance: 'preferred' },
        { kind: 'domain', text: '熟悉支付行业', importance: 'must' },
        { kind: 'scope', text: 'y'.repeat(MAX_REQUIREMENT_CHARS), importance: 'preferred' },
      ]);
      expect(out.taxonomyId).toBe('backend_engineer');
      expect(out.skills).toHaveLength(4);
    });

    it('keeps at most ENRICH_REQUIREMENTS_MAX valid lines (12 unless the variable says otherwise)', () => {
      const requirements = Array.from({ length: 40 }, (_, i) => ({ kind: 'experience', text: `Requirement line ${i + 1}`, importance: 'must' }));
      expect(parseEnrichOutput({ requirements }).requirements).toHaveLength(DEFAULT_ENRICH_REQUIREMENTS_MAX);
      expect(DEFAULT_ENRICH_REQUIREMENTS_MAX).toBe(12);
      // Bad items do not use up the room.
      const padded = parseEnrichOutput({ requirements: [{ kind: 'nope', text: 'x' }, ...requirements] }).requirements;
      expect(padded).toHaveLength(12);
      expect(padded[0]!.text).toBe('Requirement line 1');
      vi.stubEnv('ENRICH_REQUIREMENTS_MAX', '5');
      expect(parseEnrichOutput({ requirements }).requirements).toHaveLength(5);
    });

    it('ENRICH_REQUIREMENTS_MAX: a whole number from 1 to 24; anything else is 12', () => {
      expect(enrichRequirementsMax({})).toBe(12);
      expect(enrichRequirementsMax({ ENRICH_REQUIREMENTS_MAX: ' 8 ' })).toBe(8);
      expect(enrichRequirementsMax({ ENRICH_REQUIREMENTS_MAX: '500' })).toBe(ENRICH_REQUIREMENTS_CEILING);
      for (const bad of ['0', '-3', '2.5', 'many', '']) expect(enrichRequirementsMax({ ENRICH_REQUIREMENTS_MAX: bad }), bad).toBe(12);
    });

    it('a parsed line is a JobRequirement once it has its id (the wire type of features/match)', () => {
      const [line] = parseEnrichOutput({ requirements: [{ kind: 'skill', text: 'Kubernetes', importance: 'preferred' }] }).requirements;
      expect(JobRequirementSchema.safeParse({ id: 'r1', ...line }).success).toBe(true);
      expect([...REQUIREMENT_KINDS]).toEqual(JobRequirementSchema.shape.kind.options);
    });
  });

  it('validates the work item payload', () => {
    expect(EnrichPayloadSchema.safeParse({ jobId: 'j1' }).success).toBe(true);
    expect(EnrichPayloadSchema.safeParse({ jobId: 'j1', force: true }).success).toBe(true);
    expect(EnrichPayloadSchema.safeParse({}).success).toBe(false);
    expect(EnrichPayloadSchema.safeParse({ jobId: '' }).success).toBe(false);
  });
});
