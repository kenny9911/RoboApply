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

describe('FIX-3: posting boilerplate is not a keyword', () => {
  it('English: hiring, benefits and equal-opportunity filler never reaches the list; the real terms do', () => {
    const text = [
      'About us: we are an equal opportunity employer and a fast-paced, growing company.',
      'Responsibilities: build and maintain Kafka pipelines. Collaborate closely with cross-functional teams.',
      'Requirements: a bachelor degree in a related field. Proven understanding of Kafka and Terraform.',
      'Benefits: competitive salary, annual bonus, remote or hybrid office location. Kafka and Terraform experience preferred.',
    ].join(' ');
    const terms = tfidfTerms(text).map((t) => t.term);
    expect(terms).toContain('kafka');
    expect(terms.some((t) => t.split(' ').includes('terraform'))).toBe(true);
    expect(terms.some((t) => t.split(' ').includes('pipelines'))).toBe(true);
    for (const junk of ['responsibilities', 'requirements', 'benefits', 'salary', 'bonus', 'remote', 'hybrid', 'office', 'location', 'equal', 'opportunity', 'employer', 'bachelor', 'degree', 'proven', 'understanding', 'closely', 'cross-functional', 'fast-paced', 'growing']) {
      expect(terms, junk).not.toContain(junk);
    }
  });

  it('words that are part of real terms are kept inside them and dropped on their own', () => {
    // The tokens keep them, so the pairs can form.
    expect(tokenize('Experience with .NET and C#, growth marketing, paid search, functional programming, Microsoft Office, employment law, identity management')).toEqual([
      'net', 'growth', 'marketing', 'paid', 'search', 'functional', 'programming', 'microsoft', 'office', 'employment', 'law', 'identity', 'management',
    ]);
    const text = [
      'You will own growth marketing and paid search for the EMEA region.',
      'Our stack is .NET with functional programming in F#; Microsoft Office add-ins are part of the product.',
      'Advise on employment law and identity management policy.',
      'Growth marketing, paid search and functional programming experience are needed. .NET is a must.',
      'Microsoft Office, employment law and identity management come up every week.',
      'Deep learning and computer vision research; customer success partners with you.',
      'Deep learning, computer vision and customer success again.',
      'Benefits: remote or hybrid office, paid travel, growth and a people culture. Benefits and compensation are reviewed.',
      'Lead and build with a remote office culture. Compensation, benefits and growth for our people.',
    ].join(' ');
    const terms = tfidfTerms(text, 60).map((t) => t.term);
    for (const real of ['growth marketing', 'paid search', 'functional programming', 'microsoft office', 'employment law', 'identity management', 'deep learning', 'computer vision', 'customer success', 'net']) {
      expect(terms, real).toContain(real);
    }
    // On their own they are not keywords.
    for (const junk of ['growth', 'paid', 'functional', 'office', 'employment', 'identity', 'benefits', 'compensation', 'remote', 'hybrid', 'travel', 'people', 'culture', 'lead', 'build', 'deep', 'vision', 'success']) {
      expect(terms, junk).not.toContain(junk);
    }
    // A term a posting repeats is kept even when both words are of this kind.
    const hr = tfidfTerms('Own compensation and benefits design. Run the compensation and benefits review each year. Employee relations and employee benefits questions come to you. Employee benefits vendors report to you.').map((t) => t.term);
    expect(hr).toEqual(expect.arrayContaining(['compensation benefits', 'employee benefits']));
    expect(hr).not.toContain('benefits');
    expect(hr).not.toContain('employee');
    // An equal-opportunity statement printed twice still gives no keyword.
    const eeo = 'We consider all applicants without regard to race, religion, sexual orientation, gender identity, national origin, disability or protected veteran status. Reasonable accommodation is available.';
    const eeoTerms = tfidfTerms(`Kafka pipelines in Go. ${eeo} Kafka pipelines again. ${eeo}`).map((t) => t.term);
    expect(eeoTerms).toContain('kafka pipelines');
    expect(eeoTerms.filter((t) => /orientation|identity|national|disability|veteran|status|accommodation|applicants/.test(t))).toEqual([]);
    // A fragment does not stand in for the term it came from.
    for (const fragment of ['search', 'microsoft', 'programming']) expect(terms, fragment).not.toContain(fragment);
  });

  it('Chinese (Simplified and Traditional): section headings, pay and degree words are dropped; the skills stay', () => {
    const zh = '岗位职责：负责后端服务开发，使用 Go 和 MySQL。任职要求：本科及以上学历，计算机相关专业优先考虑，三年以上工作经验。薪资福利：五险一金，年终奖。熟练掌握 Go、MySQL、gRPC。';
    const zhTerms = tokenize(zh);
    expect(zhTerms).toEqual(expect.arrayContaining(['go', 'mysql', 'grpc']));
    for (const junk of ['岗位', '职责', '岗位职责', '任职', '要求', '任职要求', '本科', '学历', '专业', '薪资', '福利', '五险一金', '年终奖', '熟练', '掌握', '工作经验', '经验']) expect(zhTerms, junk).not.toContain(junk);
    const tw = '工作內容：負責後端服務開發，使用 Go 與 MySQL。職位要求：大學以上學歷，相關專業優先考慮。薪資福利：年終獎金。';
    const twTerms = tokenize(tw);
    for (const junk of ['工作內容', '內容', '職位', '要求', '學歷', '專業', '薪資', '福利', '優先', '考慮']) expect(twTerms, junk).not.toContain(junk);
    expect(twTerms).toEqual(expect.arrayContaining(['go', 'mysql']));
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
