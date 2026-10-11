// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_KEYWORDS, buildKeywords, countOccurrences, tfidfTerms, tokenize, type KeywordVocabulary } from './keywords.js';
import { CN_POSTING, INTL_POSTING, fixtureEnrichVocabulary } from './__tests__/fixtures.js';

/** The fixture vocabulary (SYNTHETIC) as the keyword list reads it. */
const VOCABULARY = fixtureEnrichVocabulary();

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

describe('buildKeywords (SM-6: concrete, canonical terms only)', () => {
  // SYNTHETIC posting, written for this test.
  const SENIOR_BACKEND = [
    'Senior Backend Engineer at Acme Analytics.',
    'You will build shared backend systems in Python, and keep our shared backend systems for billing healthy.',
    'We are a fast-paced team and clear communication matters. Communication with product is daily work.',
    'Requirements: 5+ years with Python, SQL and Postgres. PostgreSQL tuning is weekly work. Kafka is a plus.',
    'You will design REST APIs and run services on Kubernetes. Kubernetes operations are shared with the platform team.',
    'Software engineering fundamentals and distributed systems knowledge are expected. Distributed systems are what we do.',
    'Be ready to go the extra mile; the rest is up to you.',
  ].join('\n');
  const SENIOR_BACKEND_SKILLS = [
    { skill: 'Kafka', required: false, skillId: 'kafka', kind: 'hard' as const },
    { skill: 'Python', required: true, skillId: 'python', kind: 'hard' as const },
    { skill: 'postgres', required: true, skillId: 'postgresql', kind: 'hard' as const },
    { skill: 'PostgreSQL', required: false, skillId: 'postgresql', kind: 'hard' as const },
    { skill: 'SQL', required: true, skillId: 'sql', kind: 'hard' as const },
    // A soft skill, and a generic phrase the vocabulary holds no skill for.
    { skill: 'communication', required: true, skillId: 'communication', kind: 'soft' as const },
    { skill: 'software engineering', required: true, skillId: null },
  ];

  it('ACCEPT: the "Senior Backend Engineer" list holds its tools and methods, each with a skillId, and none of the generic words or loose phrases', () => {
    const keywords = buildKeywords(SENIOR_BACKEND, SENIOR_BACKEND_SKILLS, VOCABULARY);
    expect(keywords).toEqual([
      // (a) the posting's skills: required → high, preferred → medium.
      { keyword: 'python', importance: 'high', frequency: 2, skillId: 'python' },
      { keyword: 'postgres', importance: 'high', frequency: 1, skillId: 'postgresql' },
      { keyword: 'sql', importance: 'high', frequency: 1, skillId: 'sql' },
      { keyword: 'kafka', importance: 'medium', frequency: 1, skillId: 'kafka' },
      // (b) terms of the text that name a reviewed hard skill: low.
      { keyword: 'distributed systems', importance: 'low', frequency: 2, skillId: 'distributed_systems' },
      { keyword: 'kubernetes', importance: 'low', frequency: 2, skillId: 'kubernetes' },
      { keyword: 'rest apis', importance: 'low', frequency: 1, skillId: 'rest_apis' },
    ]);
    const listed = keywords.map((k) => k.keyword);
    for (const junk of ['communication', 'shared backend systems', 'backend systems', 'fast-paced', 'software engineering', 'go', 'rest', 'billing', 'team']) expect(listed, junk).not.toContain(junk);
    expect(keywords.every((k) => typeof k.skillId === 'string' && k.skillId.length > 0)).toBe(true);
  });

  it('importance: required → high, preferred → medium, a term found only in the text → low', () => {
    const keywords = buildKeywords(INTL_POSTING, [{ skill: 'Kafka', required: false, skillId: 'kafka', kind: 'hard' }, { skill: 'Python', required: true, skillId: 'python', kind: 'hard' }], VOCABULARY);
    expect(keywords.slice(0, 2)).toEqual([
      { keyword: 'python', importance: 'high', frequency: 1, skillId: 'python' },
      { keyword: 'kafka', importance: 'medium', frequency: 1, skillId: 'kafka' },
    ]);
    // INTL_POSTING also names SQL, PostgreSQL, Kubernetes and Terraform in its sentences.
    const rest = keywords.slice(2);
    expect(rest.map((k) => k.skillId).sort()).toEqual(['kubernetes', 'postgresql', 'sql', 'terraform']);
    expect(rest.every((k) => k.importance === 'low')).toBe(true);
    // "Go" stands in a sentence ("Python and Go"): a name that is also an ordinary word is taken from a skill list only.
    expect(keywords.map((k) => k.skillId)).not.toContain('go');
    expect(buildKeywords(INTL_POSTING, [{ skill: 'Go', required: true, skillId: 'go', kind: 'hard' }], VOCABULARY)[0]).toEqual({ keyword: 'go', importance: 'high', frequency: 1, skillId: 'go' });
  });

  it('one skill is one keyword, whatever its spellings (de-duplication by id)', () => {
    const text = 'Postgres, PostgreSQL and psql every day. We run k8s; Kubernetes knowledge helps.';
    const keywords = buildKeywords(
      text,
      [
        { skill: 'postgres', required: false, skillId: 'postgresql', kind: 'hard' },
        { skill: 'PostgreSQL', required: true, skillId: 'postgresql', kind: 'hard' },
        { skill: 'psql', required: false, skillId: 'postgresql', kind: 'hard' },
      ],
      VOCABULARY,
    );
    expect(keywords.filter((k) => k.skillId === 'postgresql')).toEqual([{ keyword: 'postgresql', importance: 'high', frequency: 1, skillId: 'postgresql' }]);
    expect(keywords.filter((k) => k.skillId === 'kubernetes')).toHaveLength(1);
    expect(new Set(keywords.map((k) => k.skillId)).size).toBe(keywords.length);
  });

  it('dropped at the source: a soft skill, a skill with no canonical id, an unreviewed term of the text; an unreviewed skill the posting lists is kept', () => {
    const text = 'Teamwork and feature flags. You will manage a sales force of twenty and own our work day planning.';
    const keywords = buildKeywords(
      text,
      [
        { skill: 'teamwork', required: true, skillId: 'teamwork', kind: 'soft' },
        { skill: 'stakeholder alignment', required: true, skillId: null },
        // Listed by the posting and mapped to an unreviewed skill: shown (a reader never scores it).
        { skill: 'feature flags', required: false, skillId: 'featureflag', kind: 'hard' },
      ],
      VOCABULARY,
    );
    expect(keywords).toEqual([{ keyword: 'feature flags', importance: 'medium', frequency: 1, skillId: 'featureflag' }]);
    // The same unreviewed skill found only in the text is not a keyword; nor is "sales force" Salesforce.
    expect(buildKeywords(text, [], VOCABULARY)).toEqual([]);
    expect(buildKeywords('We use Salesforce every day.', [], VOCABULARY)).toEqual([{ keyword: 'salesforce', importance: 'low', frequency: 1, skillId: 'salesforce' }]);
  });

  it('a machine guess is never a keyword: the skill is listed only when the posting also writes a name the vocabulary knows', () => {
    // "postgres db" was mapped to PostgreSQL by an embedding neighbour (`via: 'embedding'`): a guess, not a name.
    const guessed = { skill: 'postgres db', required: true, skillId: 'postgresql', kind: 'hard' as const, via: 'embedding' as const };
    expect(buildKeywords('You will look after our Postgres DB cluster. Kafka helps.', [guessed, { skill: 'kafka', required: false, skillId: 'kafka', kind: 'hard', via: 'alias' }], VOCABULARY)).toEqual([
      { keyword: 'kafka', importance: 'medium', frequency: 1, skillId: 'kafka' },
      // The text itself says "Postgres", a reviewed name: a keyword of the text, not of the guess.
      { keyword: 'postgres', importance: 'low', frequency: 1, skillId: 'postgresql' },
    ]);
    // Nothing in the text names the skill: no keyword stands on the guess alone.
    expect(buildKeywords('You will look after our PG-DB cluster.', [{ ...guessed, skill: 'pg-db' }], VOCABULARY)).toEqual([]);
    // Found by its own name, or created from the posting's string, it is a keyword as before.
    for (const via of ['alias', 'new'] as const) expect(buildKeywords('', [{ ...guessed, via }], VOCABULARY)).toHaveLength(1);
  });

  it('a row not yet enriched at version 3 (no ids on its skills) is looked up by exact alias', () => {
    const keywords = buildKeywords('We use Kubernetes.', [{ skill: 'k8s', required: true }, { skill: 'Communication', required: true }, { skill: 'in-house rpc', required: false }], VOCABULARY);
    expect(keywords).toEqual([{ keyword: 'k8s', importance: 'high', frequency: 0, skillId: 'kubernetes' }]);
  });

  it('without a vocabulary only skills that carry their id and kind are kept, and nothing is read from the text', () => {
    expect(buildKeywords(INTL_POSTING, [{ skill: 'Python', required: true, skillId: 'python', kind: 'hard' }, { skill: 'SQL', required: true }])).toEqual([
      { keyword: 'python', importance: 'high', frequency: 1, skillId: 'python' },
    ]);
    expect(buildKeywords(INTL_POSTING, [])).toEqual([]);
  });

  it('caps at 30, skills first', () => {
    const records = Array.from({ length: 40 }, (_, i) => ({ skill: `skill${i}`, required: i % 2 === 0, skillId: `id${i}`, kind: 'hard' as const }));
    const keywords = buildKeywords('text', records, VOCABULARY);
    expect(keywords).toHaveLength(MAX_KEYWORDS);
    expect(keywords.slice(0, 20).every((k) => k.importance === 'high')).toBe(true);
    expect(buildKeywords('text', records, VOCABULARY, 5)).toHaveLength(5);
  });

  it('a vocabulary with no sentence rule of its own falls back to the exact name of a term', () => {
    const plain: KeywordVocabulary = { idOf: (t) => VOCABULARY.idOf(t), kindOf: (id) => VOCABULARY.kindOf(id), reviewed: (id) => VOCABULARY.reviewed(id) };
    expect(buildKeywords('Kafka pipelines in production. Kafka again.', [], plain)).toEqual([{ keyword: 'kafka', importance: 'low', frequency: 2, skillId: 'kafka' }]);
  });

  it('ACCEPT (Chinese): a mainland posting yields its tools and certificates and no boilerplate words', () => {
    // SYNTHETIC posting, written for this test.
    const zh = [
      '岗位职责：负责数据分析与报表开发，使用SQL和Python。',
      '任职要求：本科及以上学历，持有注册会计师证书者优先，有相关经验。',
      '熟悉机器学习与分布式系统，沟通能力强，责任心强，团队合作意识好。',
      '加分项：熟悉MySQL，持有教师资格证。',
    ].join('\n');
    const keywords = buildKeywords(
      zh,
      [
        { skill: 'SQL', required: true, skillId: 'sql', kind: 'hard' },
        { skill: '注册会计师', required: false, skillId: 'cpa', kind: 'certification' },
        { skill: '沟通能力', required: true, skillId: 'communication', kind: 'soft' },
        { skill: '责任心', required: true, skillId: null },
      ],
      VOCABULARY,
    );
    expect(keywords.slice(0, 2)).toEqual([
      { keyword: 'sql', importance: 'high', frequency: 1, skillId: 'sql' },
      { keyword: '注册会计师', importance: 'medium', frequency: 1, skillId: 'cpa' },
    ]);
    const rest = keywords.slice(2);
    expect(rest.every((k) => k.importance === 'low')).toBe(true);
    // Tools by their own names, and the Chinese names the word segmenter would cut in two, written as the posting writes them.
    expect(Object.fromEntries(rest.map((k) => [k.skillId, k.keyword]))).toEqual({
      python: 'python',
      mysql: 'mysql',
      data_analysis: '数据分析',
      machine_learning: '机器学习',
      distributed_systems: '分布式系统',
      teacher_certificate: '教师资格证',
    });
    const listed = keywords.map((k) => k.keyword);
    for (const junk of ['岗位职责', '任职要求', '优先', '熟悉', '负责', '相关经验', '本科', '学历', '沟通能力', '责任心', '团队合作', '加分项', '证书']) expect(listed, junk).not.toContain(junk);
    expect(new Set(keywords.map((k) => k.skillId)).size).toBe(keywords.length);
    // The same text in Traditional script names the same skills.
    const tw = '熟悉機器學習與分散式系統，使用SQL。溝通能力佳。';
    expect(buildKeywords(tw, [], VOCABULARY).map((k) => k.skillId).sort()).toEqual(['distributed_systems', 'machine_learning', 'sql']);
  });

  it('works on the shared Chinese posting fixture', () => {
    const keywords = buildKeywords(CN_POSTING, [{ skill: 'SQL', required: true, skillId: 'sql', kind: 'hard' }], VOCABULARY);
    expect(keywords[0]).toEqual({ keyword: 'sql', importance: 'high', frequency: 1, skillId: 'sql' });
    expect(keywords.map((k) => k.skillId).sort()).toEqual(['data_analysis', 'python', 'sql']);
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

  it('SM-6: requirement and preference wording and generic qualities never reach the term list (Simplified and Traditional)', () => {
    const zh = '任职条件：有相关经验者优先录用，三年及以上从业经验。我们希望你具备团队精神、责任感和逻辑思维，吃苦耐劳，积极主动，持有相关证书。熟悉 Kafka 与 Redis 尤佳。';
    // Nothing but the two tools is left of the sentence (the segmenter cuts 相关经验 into 相关 and 经验: both halves are stop words).
    expect(tokenize(zh)).toEqual(['kafka', 'redis']);
    expect(tfidfTerms(zh, 60).map((t) => t.term).sort()).toEqual(['kafka', 'redis']);
    const tw = '任職條件：有相關經驗者優先錄用，三年以上從業經驗。我們希望你具備團隊精神與責任感，積極主動，持有相關證書。熟悉 Kafka 尤佳。';
    expect(tokenize(tw)).toEqual(['kafka']);
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
