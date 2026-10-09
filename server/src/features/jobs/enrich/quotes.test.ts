// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  hasNegation,
  mentionsWorkAuthorization,
  quoteSupportsEmployerTag,
  reconcileRequirement,
  reconcileSponsorship,
  verifyEmployerTagQuote,
  verifyQuote,
} from './quotes.js';
import { MAX_QUOTE_CHARS } from './schema.js';

const POSTING = [
  'We build payment tools for small shops.',
  'We are unable to sponsor work visas for this role.',
  'Visa sponsorship available for exceptional candidates.',
  'We hold a UK sponsor licence and can sponsor Skilled Worker visas.',
  'This role is LMIA-supported for international hires.',
  'We do not offer visa sponsorship at this time.',
  'Active Secret clearance required.',
  '本公司不提供工作签证。',
  '本公司可協助外國人申請工作許可。',
].join('\n');

describe('verifyQuote (substring guard)', () => {
  it('accepts an exact substring and returns it', () => {
    expect(verifyQuote('We are unable to sponsor work visas for this role.', POSTING)).toBe('We are unable to sponsor work visas for this role.');
  });

  it('tolerates whitespace, case, curly quotes and wrapping quote marks', () => {
    expect(verifyQuote('“we  are UNABLE to sponsor work visas”', POSTING)).toBe('we are UNABLE to sponsor work visas');
    expect(verifyQuote('We are unable to sponsor work visas…', POSTING)).toBe('We are unable to sponsor work visas');
  });

  it('drops a paraphrase that is not in the posting', () => {
    expect(verifyQuote('The company cannot sponsor visas.', POSTING)).toBeNull();
    expect(verifyQuote('', POSTING)).toBeNull();
    expect(verifyQuote(null, POSTING)).toBeNull();
  });

  it('drops quotes too short to mean anything', () => {
    expect(verifyQuote('visa', POSTING)).toBeNull();
    expect(verifyQuote('签证', POSTING)).toBe('签证');
  });

  it('caps long quotes', () => {
    const long = 'a'.repeat(300);
    expect(verifyQuote(long, `x ${long} y`)).toHaveLength(MAX_QUOTE_CHARS);
  });
});

describe('negation and work-authorization vocabulary', () => {
  it('finds negation keywords in en, zh and zh-TW', () => {
    expect(hasNegation('We are unable to sponsor')).toBe(true);
    expect(hasNegation("We can't sponsor visas")).toBe(true);
    expect(hasNegation('Sponsorship is not available')).toBe(true);
    expect(hasNegation('本公司不提供工作签证')).toBe(true);
    expect(hasNegation('無法協助申請工作許可')).toBe(true);
    expect(hasNegation('Visa sponsorship available')).toBe(false);
    expect(hasNegation('Notably, we sponsor visas')).toBe(false);
  });

  it('knows country-specific sponsorship terms (TW-09)', () => {
    expect(mentionsWorkAuthorization('H-1B transfers welcome')).toBe(true);
    expect(mentionsWorkAuthorization('We hold a UK sponsor licence')).toBe(true);
    expect(mentionsWorkAuthorization('LMIA-supported role')).toBe(true);
    expect(mentionsWorkAuthorization('Employment Gold Card holders welcome')).toBe(true);
    expect(mentionsWorkAuthorization('可協助申請工作許可')).toBe(true);
    expect(mentionsWorkAuthorization('就業金卡持有者優先')).toBe(true);
    expect(mentionsWorkAuthorization('Great snacks and a gym')).toBe(false);
  });
});

describe('reconcileSponsorship (H36)', () => {
  it('"unable to sponsor" labelled offered is corrected, never shown as offered', () => {
    const r = reconcileSponsorship('offered', 'We are unable to sponsor work visas for this role.', POSTING);
    expect(r.status).toBe('not_stated');
    expect(r.quote).toBeNull();
    expect(r.corrected).toBe('negation_in_offered_quote');
  });

  it('"unable to sponsor" labelled not_offered is kept with its quote', () => {
    expect(reconcileSponsorship('not_offered', 'We are unable to sponsor work visas for this role.', POSTING)).toEqual({
      status: 'not_offered',
      quote: 'We are unable to sponsor work visas for this role.',
      corrected: null,
    });
  });

  it('"sponsorship available" never becomes not_offered', () => {
    const r = reconcileSponsorship('not_offered', 'Visa sponsorship available for exceptional candidates.', POSTING);
    expect(r).toMatchObject({ status: 'not_stated', quote: null, corrected: 'no_negation_keyword' });
    expect(reconcileSponsorship('offered', 'Visa sponsorship available for exceptional candidates.', POSTING).status).toBe('offered');
  });

  it('drops a label whose quote is not in the posting', () => {
    expect(reconcileSponsorship('not_offered', 'We never sponsor anyone.', POSTING)).toMatchObject({ status: 'not_stated', corrected: 'quote_not_in_posting' });
    expect(reconcileSponsorship('offered', null, POSTING)).toMatchObject({ status: 'not_stated', corrected: 'quote_not_in_posting' });
  });

  it('drops a quote that does not talk about work authorization', () => {
    expect(reconcileSponsorship('offered', 'We build payment tools for small shops.', POSTING)).toMatchObject({
      status: 'not_stated',
      corrected: 'no_work_auth_term',
    });
  });

  it('handles UK, Canada, Taiwan and mainland wording', () => {
    expect(reconcileSponsorship('offered', 'We hold a UK sponsor licence and can sponsor Skilled Worker visas.', POSTING).status).toBe('offered');
    expect(reconcileSponsorship('offered', 'This role is LMIA-supported for international hires.', POSTING).status).toBe('offered');
    expect(reconcileSponsorship('offered', '本公司可協助外國人申請工作許可。', POSTING).status).toBe('offered');
    expect(reconcileSponsorship('not_offered', '本公司不提供工作签证。', POSTING).status).toBe('not_offered');
    expect(reconcileSponsorship('not_offered', 'We do not offer visa sponsorship at this time.', POSTING).status).toBe('not_offered');
  });

  it('passes not_stated through', () => {
    expect(reconcileSponsorship('not_stated', 'anything', POSTING)).toEqual({ status: 'not_stated', quote: null, corrected: null });
  });
});

describe('reconcileRequirement', () => {
  const REQ = [
    'Active Secret clearance required.',
    'Must be authorized to work in the United States.',
    'US citizenship is required for this position.',
    'US citizenship is not required.',
    'No security clearance is required for this role.',
    'Applicants must hold a TS/SCI clearance with polygraph.',
    '本岗位需通过政审。',
    '不限国籍。',
  ].join('\n');

  it('keeps a requirement only with a verified quote', () => {
    expect(reconcileRequirement('clearance', { value: true, quote: 'Active Secret clearance required.' }, REQ)).toEqual({
      value: true,
      quote: 'Active Secret clearance required.',
    });
    expect(reconcileRequirement('clearance', { value: true, quote: 'Top Secret clearance needed.' }, REQ)).toEqual({ value: null, dropped: 'quote_not_in_posting' });
    expect(reconcileRequirement('clearance', { value: true, quote: null }, REQ)).toEqual({ value: null, dropped: 'quote_not_in_posting' });
    expect(reconcileRequirement('clearance', { value: null, quote: 'Active Secret clearance required.' }, REQ)).toBeNull();
    expect(reconcileRequirement('clearance', null, REQ)).toBeNull();
  });

  it('needs a topic cue: work authorization is not citizenship (review probe)', () => {
    expect(reconcileRequirement('citizenship', { value: true, quote: 'Must be authorized to work in the United States.' }, REQ)).toEqual({ value: null, dropped: 'off_topic' });
    expect(reconcileRequirement('clearance', { value: true, quote: 'US citizenship is required for this position.' }, REQ)).toEqual({ value: null, dropped: 'off_topic' });
    expect(reconcileRequirement('clearance', { value: true, quote: 'Applicants must hold a TS/SCI clearance with polygraph.' }, REQ)).toMatchObject({ value: true });
    expect(reconcileRequirement('clearance', { value: true, quote: '本岗位需通过政审。' }, REQ)).toMatchObject({ value: true });
  });

  it('needs the quote to agree with the value (review probe)', () => {
    // false with a quote that says it IS required → dropped.
    expect(reconcileRequirement('citizenship', { value: false, quote: 'US citizenship is required for this position.' }, REQ)).toEqual({ value: null, dropped: 'no_negation_keyword' });
    // true with a quote that says it is NOT required → dropped.
    expect(reconcileRequirement('citizenship', { value: true, quote: 'US citizenship is not required.' }, REQ)).toEqual({ value: null, dropped: 'negated_required_quote' });
    expect(reconcileRequirement('clearance', { value: true, quote: 'No security clearance is required for this role.' }, REQ)).toEqual({ value: null, dropped: 'negated_required_quote' });
    expect(reconcileRequirement('citizenship', { value: true, quote: '不限国籍。' }, REQ)).toEqual({ value: null, dropped: 'negated_required_quote' });
    // Consistent negatives are kept.
    expect(reconcileRequirement('citizenship', { value: false, quote: 'US citizenship is not required.' }, REQ)).toEqual({ value: false, quote: 'US citizenship is not required.' });
    expect(reconcileRequirement('clearance', { value: false, quote: 'No security clearance is required for this role.' }, REQ)).toMatchObject({ value: false });
    expect(reconcileRequirement('citizenship', { value: false, quote: '不限国籍。' }, REQ)).toMatchObject({ value: false });
  });
});

describe('employer tag quotes (GoApply)', () => {
  const CN = ['某某能源集团是一家中央企业。', '缴纳五险一金。', '提供事业编制。', '本岗位不解决户口。', '外资企业，福利完善。', '非国企背景。'].join('\n');

  it('needs the tag\'s own cue, not any substring of the posting (review probe)', () => {
    expect(verifyEmployerTagQuote('hukou', '缴纳五险一金。', CN)).toBeNull();
    expect(verifyEmployerTagQuote('bianzhi', '缴纳五险一金。', CN)).toBeNull();
    expect(verifyEmployerTagQuote('soe', '某某能源集团是一家中央企业。', CN)).toBe('某某能源集团是一家中央企业。');
    expect(verifyEmployerTagQuote('bianzhi', '提供事业编制。', CN)).toBe('提供事业编制。');
    expect(verifyEmployerTagQuote('foreign', '外资企业，福利完善。', CN)).toBe('外资企业，福利完善。');
    expect(verifyEmployerTagQuote('soe', '外资企业，福利完善。', CN)).toBeNull();
    expect(verifyEmployerTagQuote('soe', '不在帖子里的国企', CN)).toBeNull();
  });

  it('rejects a negated cue', () => {
    expect(verifyEmployerTagQuote('hukou', '本岗位不解决户口。', CN)).toBeNull();
    expect(verifyEmployerTagQuote('soe', '非国企背景。', CN)).toBeNull();
    expect(quoteSupportsEmployerTag('bianzhi', '无编制')).toBe(false);
    expect(quoteSupportsEmployerTag('hukou', '协助办理落户')).toBe(true);
    expect(quoteSupportsEmployerTag('unknown_tag', '落户')).toBe(false);
  });
});
