// @vitest-environment node
//
// WP-55a: which application questions AI may draft. Every protected type is
// recognised in English and Chinese; open questions stay `free_text`.

import { describe, expect, it } from 'vitest';
import { PROTECTED_QUESTION_TYPES, type QuestionType } from './contract.js';
import { ADVERSARIAL_PROTECTED_TYPED, FREE_TEXT_NOT_GRADES, PROTECTED_SAMPLES, UNSUPPORTED_LANGUAGE_FREE_TEXT } from './questionSamples.js';
import { BANK_MATCH_THRESHOLD, classifyQuestion, draftableLanguage, findBankAnswer, normalizeQuestion, questionSimilarity } from './questionTypes.js';

const FREE_TEXT = [
  'Why do you want to work at Acme?',
  'Tell us about a project you are proud of.',
  'What interests you about this role?',
  'Describe how you handled a disagreement with a teammate.',
  'Anything else you would like us to know?',
  '请简单介绍一下你自己。',
  '为什么想加入我们？',
];

describe('classifyQuestion', () => {
  it('covers every protected type with samples', () => {
    expect(Object.keys(PROTECTED_SAMPLES).sort()).toEqual([...PROTECTED_QUESTION_TYPES].sort());
  });

  for (const [type, samples] of Object.entries(PROTECTED_SAMPLES)) {
    it.each(samples)(`${type}: %s`, (q) => {
      const got: QuestionType = classifyQuestion(q);
      expect(got).not.toBe('free_text');
      expect(got).toBe(type);
    });
  }

  it.each(FREE_TEXT)('free text: %s', (q) => {
    expect(classifyQuestion(q)).toBe('free_text');
  });

  // 成绩 / 排名 / "academic performance" outside a study context are open questions (GoApply drafts them).
  it.each(FREE_TEXT_NOT_GRADES)('a grade word in another sense stays free text: %s', (q) => {
    expect(classifyQuestion(q)).toBe('free_text');
    expect(draftableLanguage(q)).toBe(true);
  });

  it.each(ADVERSARIAL_PROTECTED_TYPED)('adversarial: %s → %s', (q, type) => {
    expect(classifyQuestion(q)).toBe(type);
  });

  it('treats a mixed question as protected', () => {
    expect(classifyQuestion('Why do you want this job, and what are your salary expectations?')).not.toBe('free_text');
  });
});

describe('answer bank matching', () => {
  const bank = [
    { questionKey: 'custom:why', questionText: 'Why do you want to work here?', answer: 'Because of the mission.' },
    { questionKey: 'notice_period', questionText: 'Notice period', answer: 'Two weeks' },
    { questionKey: 'custom:empty', questionText: 'Tell us about yourself', answer: '   ' },
  ];

  it('matches the same question after normalisation', () => {
    expect(normalizeQuestion('  Why do you want to WORK here?! ')).toBe('why do you want to work here');
    expect(findBankAnswer(bank, 'why do you want to work here', 'free_text')?.answer).toBe('Because of the mission.');
  });

  it('matches a close wording above the threshold only', () => {
    expect(questionSimilarity('Why do you want to work here?', 'Why do you want to work here at Acme?')).toBeGreaterThanOrEqual(BANK_MATCH_THRESHOLD);
    expect(findBankAnswer(bank, 'What is your favourite colour?', 'free_text')).toBeNull();
  });

  it('matches a protected type by its canonical key', () => {
    expect(findBankAnswer(bank, 'When could you join us?', 'notice_period')?.answer).toBe('Two weeks');
  });

  it('never returns an empty saved answer', () => {
    expect(findBankAnswer(bank, 'Tell us about yourself', 'free_text')).toBeNull();
  });

  it('compares Chinese questions by character pairs', () => {
    expect(questionSimilarity('为什么想加入我们？', '为什么想加入我们')).toBe(1);
  });
});

describe('draftableLanguage (fails closed)', () => {
  it.each(FREE_TEXT)('English or Chinese open question may be drafted: %s', (q) => {
    expect(draftableLanguage(q)).toBe(true);
  });

  it.each(['Why us?', 'How did you hear about us?', 'Cover letter', 'Upload your résumé summary', 'Portfolio URL'])('short English labels: %s', (q) => {
    expect(draftableLanguage(q)).toBe(true);
  });

  it.each(UNSUPPORTED_LANGUAGE_FREE_TEXT)('another language is never drafted: %s', (q) => {
    expect(draftableLanguage(q)).toBe(false);
  });

  it('a Latin-script question with no English word is not drafted', () => {
    expect(draftableLanguage('Gehaltsvorstellung')).toBe(false);
    expect(draftableLanguage('Motivatie')).toBe(false);
  });
});
