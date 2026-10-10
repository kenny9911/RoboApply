// @vitest-environment node
// WP-59 pure rules: attribution, the contribution screen, AI "asked at" claims, periods, parsing.

import { describe, expect, it } from 'vitest';
import { HttpError } from '../../platform/http.js';
import { assertAttribution, claimsCompanyAsked, isValidPeriod, screenContribution, titleFrom } from './rules.js';
import { parseGuide, parseQuestionSet } from './agents.js';

describe('assertAttribution', () => {
  it.each([
    ['curated', 'co_1', null],
    ['curated', null, 'acme'],
    ['ai_practice', 'co_1', null],
    ['ai_practice', null, 'acme'],
  ])('%s with a company is rejected', (sourceKind, companyId, companyNameNormalized) => {
    expect(() => assertAttribution({ sourceKind, companyId, companyNameNormalized })).toThrow(HttpError);
  });

  it('user reports may name a company; others without one pass', () => {
    expect(() => assertAttribution({ sourceKind: 'user_report', companyId: 'co_1', companyNameNormalized: 'acme' })).not.toThrow();
    expect(() => assertAttribution({ sourceKind: 'curated' })).not.toThrow();
    expect(() => assertAttribution({ sourceKind: 'ai_practice', companyId: null, companyNameNormalized: '' })).not.toThrow();
  });

  it('unknown kinds (e.g. scraped) are rejected', () => {
    expect(() => assertAttribution({ sourceKind: 'scraped' })).toThrow(/Unknown/);
  });
});

describe('screenContribution', () => {
  it('a plain question passes', () => {
    expect(screenContribution('Tell me about a time you missed a deadline.')).toEqual([]);
    expect(screenContribution('请介绍一下你最有成就感的项目。')).toEqual([]);
  });

  it('flags NDA / test content, copyright, contact details, non-questions and long pastes', () => {
    expect(screenContribution('Online assessment question from Codility: reverse a list?')).toContain('nda_or_test_content');
    expect(screenContribution('这是笔试原题：求最长回文子串？')).toContain('nda_or_test_content');
    expect(screenContribution('Explain this. © 2024 Some Publisher. All rights reserved.')).toContain('copyright');
    expect(screenContribution('Why us? Ask the recruiter at 415-555-0100.')).toContain('personal_info');
    expect(screenContribution('The interview went well overall.')).toContain('not_a_question');
    expect(screenContribution(`Why? ${'x'.repeat(1300)}`)).toContain('too_long');
  });
});

describe('claimsCompanyAsked', () => {
  it.each([
    'This was commonly asked at Acme.',
    'Candidates report this question.',
    'A real interview question from the team.',
    'Acme likes to ask about trade-offs.',
    '这是面试官常问的问题',
  ])('catches "%s"', (text) => {
    expect(claimsCompanyAsked(text, 'Acme')).toBe(true);
  });

  it('practice wording passes', () => {
    expect(claimsCompanyAsked('How would you design the read path for a busy feed?', 'Acme')).toBe(false);
    expect(claimsCompanyAsked('Why does this role at Acme interest you?', 'Acme')).toBe(false);
  });
});

describe('periods and titles', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  it('accepts past and current months only', () => {
    expect(isValidPeriod('2026-10', now)).toBe(true);
    expect(isValidPeriod('2026-11', now)).toBe(false);
    expect(isValidPeriod('1999-01', now)).toBe(false);
    expect(isValidPeriod('2026-13', now)).toBe(false);
  });

  it('a user east of UTC can pick their local month in its first hours', () => {
    // 2026-10-31 18:00 UTC is already 1 November in Shanghai (UTC+8) and Kiritimati (UTC+14).
    expect(isValidPeriod('2026-11', new Date('2026-10-31T18:00:00Z'))).toBe(true);
    expect(isValidPeriod('2026-11', new Date('2026-10-31T09:59:00Z'))).toBe(false);
    expect(isValidPeriod('2026-12', new Date('2026-10-31T18:00:00Z'))).toBe(false);
  });

  it('titleFrom takes the first line', () => {
    expect(titleFrom('Why us?\nMore context')).toBe('Why us?');
    expect(titleFrom('x'.repeat(200), 20)).toHaveLength(20);
  });
});

describe('agent output parsing', () => {
  it('parseQuestionSet keeps valid items and normalizes category/difficulty', () => {
    const out = parseQuestionSet(
      '```json\n{"questions":[{"title":"Perf","question":"How would you find a slow query?","category":"coding","difficulty":"hard"},{"question":"short"},{"question":"Tell me about a conflict at work.","category":"weird"}]}\n```',
    );
    expect(out).toEqual([
      { title: 'Perf', body: 'How would you find a slow query?', category: 'coding', difficulty: 'hard' },
      { title: 'Tell me about a conflict at work.', body: 'Tell me about a conflict at work.', category: 'behavioral', difficulty: null },
    ]);
    expect(parseQuestionSet('not json')).toEqual([]);
  });

  it('parseGuide returns null for empty output', () => {
    expect(parseGuide('{"approach":"Start with the result.","whatTheyTest":["clarity"]}')).toMatchObject({ approach: 'Start with the result.', whatTheyTest: ['clarity'] });
    expect(parseGuide('{}')).toBeNull();
    expect(parseGuide('nope')).toBeNull();
  });
});
