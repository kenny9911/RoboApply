// @vitest-environment node
// WP-50 guard: submission claims (D1), the number guard (D3), job links, and
// sentence-by-sentence streaming.

import { describe, expect, it } from 'vitest';
import {
  SentenceBuffer,
  StreamGuard,
  collectSourceNumbers,
  guardText,
  isSubmissionClaim,
  numberClaims,
  numbersIn,
  splitSentences,
  unsourcedNumbers,
  type GuardContext,
} from '../guard.js';
import { guardLine, lineLocale } from '../text.js';

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({ allowedNumbers: new Set(), allowedJobIds: new Set(), locale: 'en', ...over });

describe('submission claims', () => {
  it.each([
    'I applied to this job for you.',
    "I've submitted your application.",
    'We have applied on your behalf.',
    'Your application has been submitted.',
    'I have contacted the recruiter.',
    'I will apply for you tomorrow.',
    '已为你投递这个职位。',
    '我已经帮你投递了简历。',
    '已為你投遞這個職缺。',
    '応募しました。',
    '지원을 완료했습니다.',
    'He enviado tu solicitud.',
    "J'ai postulé pour vous.",
    'Enviei sua candidatura.',
    'Ich habe mich beworben.',
    'Ihre Bewerbung wurde abgeschickt.',
    // review probe (WP-50 review): agentless, adverbs between subject and verb, "for you" without a subject
    'Application submitted.',
    'Your application is submitted.',
    "I've gone ahead and applied to Acme.",
    'Done, applied to all 5 roles for you.',
    "I'll apply to these for you.",
    'All applications sent!',
    'We went ahead and submitted it.',
    "I'm going to apply for you now.",
    // colloquial zh (GoApply's main language)
    '我已经帮你投了简历。',
    '已帮你申请这个职位。',
    '帮你投了三家公司。',
    '简历已发给HR了。',
    '申请已提交。',
    // zh-TW
    '已幫你申請這個職缺。',
    '幫你投了三家公司。',
    '履歷已送出了。',
  ])('flags %s', (s) => {
    expect(isSubmissionClaim(s)).toBe(true);
  });

  it.each([
    'I applied the filter changes.',
    'I applied these changes to your search.',
    'You can apply on the company site.',
    'Open the application and submit it yourself.',
    'Tap "Apply changes" to update your search.',
    '你可以在公司官网投递。',
    // advice and conditions, not claims
    'Once your application is submitted, follow up in a week.',
    'Make sure the application is sent before Friday.',
    'Applications submitted through referrals get more replies.',
    "I can apply the salary filter for you.",
    "I'll apply these filters for you.",
    'You applied to Acme last week; here is a tip for you.',
    'I see you applied to Acme.',
    '如果你的申请已提交，可以一周后跟进。',
    '我可以帮你准备申请材料。',
    '你投了简历之后，记得跟进。',
  ])('does not flag %s', (s) => {
    expect(isSubmissionClaim(s)).toBe(false);
  });

  it('replaces the sentence with the neutral line in the reply language', () => {
    const r = guardText('Done! I applied to the Acme job for you. Good luck.', ctx());
    expect(r.text).toBe(`Done! ${guardLine('notSubmitted', 'en')} Good luck.`);
    expect(r.hits).toEqual([expect.objectContaining({ kind: 'submission_claim' })]);
    const zh = guardText('已为你投递。祝你好运。', ctx({ locale: 'zh' }));
    expect(zh.text).toContain(guardLine('notSubmitted', 'zh'));
    expect(zh.text).not.toContain('已为你投递');
  });
});

describe('number guard', () => {
  it('removes the invented "$145k median" sentence and adds the replacement line', () => {
    const allowed = collectSourceNumbers({ jobs: [{ pay: { min: 90000, max: 120000 } }] });
    const r = guardText('This role pays well. The market median is $145k for this title. Ask about the range.', ctx({ allowedNumbers: allowed }));
    expect(r.text).toBe(`This role pays well. ${guardLine('noSource', 'en')} Ask about the range.`);
    expect(r.text).not.toContain('145');
    expect(r.hits).toEqual([expect.objectContaining({ kind: 'unsourced_number', token: '$145k' })]);
  });

  it('keeps numbers a tool returned, in any common notation', () => {
    const allowed = collectSourceNumbers({ median: 145000, listed: 32, items: [1, 2, 3] });
    expect(unsourcedNumbers('The median of listed pay is $145k.', allowed)).toEqual([]);
    expect(unsourcedNumbers('That is US$145,000 a year.', allowed)).toEqual([]);
    expect(unsourcedNumbers('It is based on 32 posts.', allowed)).toEqual([]);
    expect(unsourcedNumbers('Here are 3 jobs.', allowed)).toEqual([]);
    expect(unsourcedNumbers('Here are 4 jobs.', allowed)).toEqual(['4']);
  });

  it('keeps numbers from the user\'s own text', () => {
    const allowed = numbersIn('I want at least 120k and remote, 3 days in office max');
    expect(unsourcedNumbers('You asked for at least $120,000.', allowed)).toEqual([]);
    expect(unsourcedNumbers('Up to 3 days in office is fine.', allowed)).toEqual([]);
  });

  it('ignores ids, visa names, list markers and words with digits', () => {
    expect(numberClaims('Sponsorship: H-1B is not stated.')).toEqual([]);
    expect(numberClaims('Open /jobs/cm9x2abc12 for details.')).toEqual([]);
    expect(numberClaims('1. Tailor your resume')).toEqual([]);
    expect(numberClaims('Q3 roadmap')).toEqual([]);
  });

  it.each([
    'Python 3 is common.',
    'Step 1: open the job.',
    'Top 10 tips.',
    'A 401k is listed.',
    'Java 17 and Python 3.11 are listed.',
    'Ask about the round 2 interview.',
    'Windows 11 skills help.',
    'iOS 18 experience is a plus.',
    'This is your #1 match.',
    'Support is 24/7.',
    'You need a W-2.',
    '第3轮面试通常是HR面。',
  ])('keeps a sentence whose number labels rather than claims: %s', (s) => {
    const r = guardText(s, ctx());
    expect(r.text).toBe(s);
    expect(r.hits).toEqual([]);
  });

  it.each([
    ['About 30 jobs match.', '30'],
    ['Top 10% of applicants get a reply.', '10'],
    ['Median 145000 a year.', '145000'],
    ['Google 50 jobs are open.', '50'],
    ['Salary 120 per hour.', '120'],
    ['Over 200 people applied.', '200'],
    ['Python 3 roles pay $150k.', '$150k'],
    ['月薪3万。', '3万'],
  ])('money, percentages, magnitudes and counts stay strict: %s', (s, token) => {
    expect(unsourcedNumbers(s, new Set())).toContain(token);
  });

  it('reads 万 and k suffixes', () => {
    const allowed = collectSourceNumbers({ max: 150000 });
    expect(unsourcedNumbers('月薪15万。', allowed)).toEqual([]);
    expect(unsourcedNumbers('月薪16万。', allowed)).toEqual(['16万']);
  });

  it('collapses repeated replacement lines', () => {
    const r = guardText('Median is $145k. Top is $200k. Low is $80k.', ctx());
    expect(r.text.trim()).toBe(guardLine('noSource', 'en'));
    expect(r.hits).toHaveLength(3);
  });
});

describe('job links', () => {
  it('drops a sentence that links a job no tool returned', () => {
    const r = guardText('See /jobs/job_fake99 for more. Also see /jobs/job_1 here.', ctx({ allowedJobIds: new Set(['job_1']) }));
    expect(r.text).toBe('Also see /jobs/job_1 here.');
    expect(r.hits[0]).toMatchObject({ kind: 'unknown_job_link', token: 'job_fake99' });
  });
});

describe('streaming', () => {
  it('splits sentences without losing characters', () => {
    const text = 'One. Two!\nThree 3.5 four? 五。六';
    expect(splitSentences(text).join('')).toBe(text);
    expect(splitSentences(text)).toEqual(['One. ', 'Two!\n', 'Three 3.5 four? ', '五。', '六']);
  });

  it('releases only complete sentences and holds a trailing period', () => {
    const b = new SentenceBuffer();
    expect(b.push('Pay is 3')).toBe('');
    expect(b.push('.')).toBe('');
    expect(b.push('5 an hour. Next')).toBe('Pay is 3.5 an hour. ');
    expect(b.flush()).toBe('Next');
  });

  it('StreamGuard never emits an unchecked sentence', () => {
    const g = new StreamGuard(() => ctx());
    const out: string[] = [];
    for (const chunk of ['The me', 'dian is $14', '5k. Fine', ' otherwise.']) out.push(g.push(chunk));
    out.push(g.flush());
    expect(out.join('')).toBe(`${guardLine('noSource', 'en')} Fine otherwise.`);
    expect(out.join('')).not.toMatch(/145/);
    expect(g.hits).toHaveLength(1);
  });
});

describe('lines', () => {
  it('maps locales', () => {
    expect(lineLocale('zh-CN')).toBe('zh');
    expect(lineLocale('zh-TW')).toBe('zh-TW');
    expect(lineLocale('pt-BR')).toBe('pt');
    expect(lineLocale('xx')).toBe('en');
    expect(guardLine('noSource', 'en')).toBe('No source found for that number.');
  });
});
