// @vitest-environment node
//
// WP-37 claim checker: citations per sentence, and a sentence that writes a
// job-post fact as the candidate's own experience is rejected.

import { describe, expect, it } from 'vitest';
import {
  checkLetterClaims,
  isExperienceClaim,
  numbersIn,
  postingOnlyTerms,
  quotedIn,
  retryNote,
  significantTerms,
  splitSentences,
  type LetterSentence,
} from './claimCheck.js';
import { CLEAN_LETTER, JOB, POSTING_AS_EXPERIENCE_LETTER, RESUME_MD } from './fixtures.js';

const POSTING = `${JOB.title}\n${JOB.companyName}\n${JOB.descriptionPlain}\n${JOB.qualifications}`;
const sentencesOf = (l: typeof CLEAN_LETTER): LetterSentence[] =>
  l.paragraphs.flat().map((s) => ({ text: s.text, kind: s.kind, cites: s.cites.filter((c) => c.source !== 'letter') as LetterSentence['cites'] }));
const check = (sentences: LetterSentence[], locale = 'en', userSentences?: string[]) =>
  checkLetterClaims({ sentences, resumeText: RESUME_MD, postingText: POSTING, companyName: JOB.companyName, locale, userSentences });

describe('checkLetterClaims', () => {
  it('passes a letter whose every sentence is cited and true to the resume', () => {
    const r = check(sentencesOf(CLEAN_LETTER));
    expect(r.issues).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('rejects a sentence that states a job-post fact as the candidate’s experience (fixture)', () => {
    const r = check(sentencesOf(POSTING_AS_EXPERIENCE_LETTER));
    expect(r.passed).toBe(false);
    const kinds = r.issues.map((i) => `${i.kind}:${i.detail}`);
    expect(kinds).toContain('posting_as_experience:cited only to the job post');
    expect(kinds).toContain('posting_as_experience:Rust');
    expect(kinds).toContain('posting_as_experience:Kubernetes');
    expect(kinds).toContain('invented_number:3');
  });

  it('rejects the claim even when it cites a real resume line', () => {
    const r = check([
      { text: 'At Acme Pay I built Rust services for refunds.', kind: 'experience', cites: [{ source: 'resume', quote: 'Built the refunds API in Go serving 40 merchants.' }] },
    ]);
    expect(r.issues.map((i) => i.detail)).toEqual(['Rust']);
  });

  it('flags a sentence without a citation, and a citation that is not in its source', () => {
    const r = check([
      { text: 'I am a hard worker.', cites: [] },
      { text: 'I built payment systems.', kind: 'experience', cites: [{ source: 'resume', quote: 'Designed payment systems for banks.' }] },
    ]);
    expect(r.issues.map((i) => i.kind)).toEqual(['missing_citation', 'bad_citation', 'posting_as_experience']);
  });

  it('a resume quote cited as the job post is not evidence', () => {
    const r = check([{ text: 'I wrote billing jobs in Go and Python.', kind: 'experience', cites: [{ source: 'posting', quote: 'Wrote billing jobs in Go and Python.' }] }]);
    expect(r.issues.map((i) => i.kind)).toEqual(['bad_citation', 'posting_as_experience']);
  });

  it('flags a number that is not on the resume in an experience sentence', () => {
    const r = check([
      { text: 'I built the refunds API in Go serving 400 merchants.', kind: 'experience', cites: [{ source: 'resume', quote: 'Built the refunds API in Go serving 40 merchants.' }] },
    ]);
    expect(r.issues).toEqual([expect.objectContaining({ kind: 'invented_number', detail: '400' })]);
  });

  it('allows the job post’s numbers in sentences about the employer', () => {
    const r = check([{ text: 'Your platform runs in 3 regions.', kind: 'company', cites: [{ source: 'posting', quote: 'We run Kubernetes across 3 regions.' }] }]);
    expect(r.passed).toBe(true);
  });

  it('does not check the user’s own sentences', () => {
    const mine = 'I also volunteer as a Rust mentor on weekends.';
    const r = check([{ text: mine, cites: [] }], 'en', [mine]);
    expect(r.passed).toBe(true);
  });

  it('Chinese: a posting skill written as the candidate’s own is rejected', () => {
    const resume = '## 实习经历\n- 负责用户数据分析，使用 Python 和 SQL。';
    const posting = '岗位要求：熟悉 Kubernetes 容器编排，具备分布式系统设计经验。';
    const r = checkLetterClaims({
      sentences: [
        { text: '我曾使用 Kubernetes 部署服务。', kind: 'experience', cites: [{ source: 'resume', quote: '负责用户数据分析，使用 Python 和 SQL。' }] },
        { text: '我具备分布式系统设计经验。', cites: [{ source: 'resume', quote: '负责用户数据分析' }] },
        { text: '贵公司的岗位要求熟悉 Kubernetes 容器编排。', kind: 'company', cites: [{ source: 'posting', quote: '熟悉 Kubernetes 容器编排' }] },
      ],
      resumeText: resume,
      postingText: posting,
      locale: 'zh',
    });
    expect(r.issues.map((i) => `${i.sentenceIdx}:${i.kind}:${i.detail}`)).toEqual([
      '0:posting_as_experience:Kubernetes',
      '1:posting_as_experience:具备分布式系统设计经验',
    ]);
  });

  it('other languages rely on the model’s experience label', () => {
    const r = checkLetterClaims({
      sentences: [{ text: "J'ai déployé des services Rust.", kind: 'experience', cites: [{ source: 'posting', quote: 'Rust experience required.' }] }],
      resumeText: RESUME_MD,
      postingText: POSTING,
      locale: 'fr',
    });
    expect(r.issues.map((i) => i.kind)).toEqual(['posting_as_experience', 'posting_as_experience']);
  });
});

describe('helpers', () => {
  it('isExperienceClaim', () => {
    expect(isExperienceClaim('I led a team of five.', 'en')).toBe(true);
    expect(isExperienceClaim('My experience with Postgres runs deep.', 'en')).toBe(true);
    expect(isExperienceClaim('I would love to learn Rust.', 'en')).toBe(false);
    expect(isExperienceClaim("I haven't used Rust yet.", 'en')).toBe(false);
    expect(isExperienceClaim('Your team builds payment rails.', 'en')).toBe(false);
    expect(isExperienceClaim('我希望加入贵团队。', 'zh')).toBe(false);
    expect(isExperienceClaim('我负责过支付系统。', 'zh')).toBe(true);
    expect(isExperienceClaim('我没有使用过 Rust。', 'zh')).toBe(false);
  });

  it('significantTerms skips sentence-initial capitals and stopwords', () => {
    expect(significantTerms('Leading teams at Acme with Kubernetes and C++ and SQL.')).toEqual(['Acme', 'Kubernetes', 'C++', 'SQL']);
  });

  it('postingOnlyTerms ignores the company name and resume terms', () => {
    expect(postingOnlyTerms('I would bring Postgres depth to Stripe and Rust.', RESUME_MD, POSTING, 'Stripe')).toEqual(['Rust']);
  });

  it('quotedIn is whitespace- and case-insensitive and needs a real quote', () => {
    expect(quotedIn('led  MIGRATION of 7 postgres', RESUME_MD)).toBe(true);
    expect(quotedIn('Go', RESUME_MD)).toBe(false);
    expect(quotedIn('Led migration of 8 Postgres clusters', RESUME_MD)).toBe(false);
  });

  it('splitSentences handles Latin and CJK punctuation and lines', () => {
    expect(splitSentences('Dear team,\n\nI led X. Then Y! Is it 3.5? Yes.\n我负责过。我会学习！')).toEqual([
      'Dear team,',
      'I led X.',
      'Then Y!',
      'Is it 3.5?',
      'Yes.',
      '我负责过。',
      '我会学习！',
    ]);
  });

  it('numbersIn normalizes thousands and full-width digits', () => {
    expect(numbersIn('1,200 users, ３０% faster, p95 380ms')).toEqual(['1200', '30', '95', '380']);
  });

  it('retryNote names each problem', () => {
    const r = check(sentencesOf(POSTING_AS_EXPERIENCE_LETTER));
    const note = retryNote(r.issues);
    expect(note).toMatch(/JOB POST as the candidate's own experience \(Rust\)/);
    expect(note).toMatch(/number 3/);
  });
});
