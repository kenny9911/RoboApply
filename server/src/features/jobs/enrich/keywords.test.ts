// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_KEYWORDS, buildKeywords, countOccurrences, tfidfTerms, tokenize } from './keywords.js';
import { CN_POSTING, INTL_POSTING } from './__tests__/fixtures.js';

describe('tokenize', () => {
  it('drops stopwords, numbers and one-letter words', () => {
    expect(tokenize('We are looking for 3 engineers with a passion for Kubernetes')).toEqual(['engineers', 'passion', 'kubernetes']);
  });

  it('segments Chinese into words', () => {
    const tokens = tokenize('熟悉SQL和Python，负责数据分析');
    expect(tokens).toContain('sql');
    expect(tokens).toContain('python');
    expect(tokens.some((t) => t.includes('数据'))).toBe(true);
    expect(tokens).not.toContain('和');
  });
});

describe('tfidf', () => {
  it('ranks terms deterministically and repeats nothing', () => {
    const a = tfidfTerms(INTL_POSTING);
    const b = tfidfTerms(INTL_POSTING);
    expect(a).toEqual(b);
    expect(new Set(a.map((t) => t.term)).size).toBe(a.length);
    expect(a.map((t) => t.term)).toContain('kubernetes');
  });

  it('keeps a repeated bigram', () => {
    const text = 'Machine learning is core. You will ship machine learning models. Python is used.';
    expect(tfidfTerms(text).map((t) => t.term)).toContain('machine learning');
  });

  it('returns nothing for empty text', () => {
    expect(tfidfTerms('')).toEqual([]);
  });
});

describe('buildKeywords', () => {
  it('puts required skills first (high), then preferred (medium), then TF-IDF terms, at most 30', () => {
    const keywords = buildKeywords(INTL_POSTING, [
      { skill: 'Kafka', required: false },
      { skill: 'Python', required: true },
      { skill: 'python', required: true },
    ]);
    expect(keywords[0]).toEqual({ keyword: 'python', importance: 'high', frequency: 1 });
    expect(keywords[1]).toEqual({ keyword: 'kafka', importance: 'medium', frequency: 1 });
    expect(keywords.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    expect(keywords.slice(2).every((k) => k.importance === 'low' || k.importance === 'medium')).toBe(true);
    expect(new Set(keywords.map((k) => k.keyword)).size).toBe(keywords.length);
  });

  it('caps at 30 even with many skills', () => {
    const skills = Array.from({ length: 40 }, (_, i) => ({ skill: `skill${i}`, required: i % 2 === 0 }));
    expect(buildKeywords('text', skills)).toHaveLength(MAX_KEYWORDS);
  });

  it('works on a Chinese posting', () => {
    const keywords = buildKeywords(CN_POSTING, [{ skill: 'SQL', required: true }]);
    expect(keywords[0]).toEqual({ keyword: 'sql', importance: 'high', frequency: 1 });
    expect(keywords.length).toBeGreaterThan(3);
  });
});

describe('countOccurrences', () => {
  it('counts whole words in Latin text and substrings in Chinese', () => {
    expect(countOccurrences('Go, Golang and go.', 'go')).toBe(2);
    expect(countOccurrences('C++ and C++17', 'c++')).toBe(1);
    expect(countOccurrences('数据分析与数据建模', '数据')).toBe(2);
    expect(countOccurrences('anything', '')).toBe(0);
  });
});
