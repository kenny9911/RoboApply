// Field classification, protected questions, value resolution, option matching.

import { describe, expect, it } from 'vitest';

import { matchOption } from '../src/adapters/_kit/options';
import type { FieldHandle } from '../src/adapters/types';
import { classifyField } from '../src/mapping/classify';
import { countriesNamed } from '../src/mapping/countries';
import { authQuestionShape, protectedQuestionType } from '../src/mapping/questions';
import { bankAnswerFor, profileValue, resolveField, workAuthFor } from '../src/mapping/resolve';
import { PROTECTED_QUESTION_TYPES } from '../src/shared/contract';
import { sampleProfile } from './helpers';

function fh(label: string, kind: FieldHandle['kind'] = 'text', attrs: Record<string, string> = {}, options?: string[]): FieldHandle {
  const el = document.createElement(kind === 'select' ? 'select' : kind === 'textarea' ? 'textarea' : 'input');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return { id: label, label, kind, required: false, element: el, options };
}

describe('classifyField', () => {
  it.each([
    ['First Name', 'firstName'],
    ['Legal last name', 'lastName'],
    ['Full name', 'fullName'],
    ['Email address', 'email'],
    ['Mobile phone', 'phone'],
    ['LinkedIn Profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Portfolio', 'portfolio'],
    ['Website', 'website'],
    ['Current location', 'location'],
    ['Zip code', 'postalCode'],
    ['Country', 'country'],
    ['Current company', 'currentCompany'],
    ['School', 'school'],
    ['姓名', 'fullName'],
    ['手机号码', 'phone'],
    ['邮箱', 'email'],
  ])('%s → %s', (label, key) => {
    expect(classifyField(fh(label))).toBe(key);
  });

  it('prefers autocomplete, then the adapter hint', () => {
    expect(classifyField(fh('Something', 'text', { autocomplete: 'section-x given-name' }))).toBe('firstName');
    expect(classifyField({ ...fh('Something'), hint: 'email' })).toBe('email');
  });

  it.each([
    ['Can we email you about future roles?', 'text'],
    ['How did you hear about us (LinkedIn)?', 'text'],
    ['Do you have a GitHub account?', 'text'],
    ['Do you have a phone?', 'text'],
    ['Email', 'checkbox'],
    ['LinkedIn', 'radio'],
    ['Email me about similar jobs', 'checkbox'],
    ['Phone screen availability', 'text'],
  ] as const)('a question or choice is not a contact field: %s (%s)', (label, kind) => {
    expect(classifyField(fh(label, kind))).toBeNull();
  });

  it('long labels are questions, not profile fields', () => {
    expect(classifyField(fh('Please share your LinkedIn and tell us why this role interests you'))).toBeNull();
    expect(classifyField(fh('Why do you want to work here?'))).toBeNull();
  });

  it('file inputs: resume vs cover letter', () => {
    expect(classifyField(fh('Resume/CV', 'file'))).toBe('resume');
    expect(classifyField(fh('上传简历', 'file'))).toBe('resume');
    expect(classifyField(fh('Cover Letter', 'file'))).toBe('coverLetter');
    expect(classifyField(fh('Transcript', 'file'))).toBeNull();
  });
});

describe('protectedQuestionType', () => {
  it.each([
    ['Are you legally authorized to work in the United States?', 'work_authorization'],
    ['Will you now or in the future require sponsorship for employment visa status?', 'sponsorship'],
    ['Have you ever been convicted of a felony?', 'criminal_history'],
    ['Gender', 'eeo'],
    ['Are you Hispanic/Latino?', 'eeo'],
    ['Veteran Status', 'veteran'],
    ['Disability Status', 'disability'],
    ['What is your current salary?', 'salary_history'],
    ['What are your salary expectations?', 'salary_expectation'],
    ['How many years of experience do you have with SQL?', 'years_of_experience'],
    ["Do you have a bachelor's degree?", 'degree'],
    ['Do you hold an active security clearance?', 'clearance'],
    ['Do you have a CPA license?', 'certification'],
    ['What is your notice period?', 'notice_period'],
    ['期望薪资', 'salary_expectation'],
    ['What is your expected CTC?', 'salary_expectation'],
    ['Desired base', 'salary_expectation'],
    ['Desired base pay', 'salary_expectation'],
    ['What is your hourly rate?', 'salary_expectation'],
    ['Rate expectations', 'salary_expectation'],
    ['期望月薪', 'salary_expectation'],
    ['期望年薪', 'salary_expectation'],
    ['What is your current CTC?', 'salary_history'],
    ['Are you legally authorized to work in the United States without visa sponsorship?', 'sponsorship'],
    ['最高学历', 'degree'],
    ['When are you available to start?', 'notice_period'],
    ['When could you start?', 'notice_period'],
    ['What is your availability?', 'notice_period'],
    ['Starting date', 'notice_period'],
    ['Earliest available date', 'notice_period'],
    ['最快到岗时间', 'notice_period'],
    ['何時可以入職？', 'notice_period'],
  ])('%s → %s', (label, type) => {
    expect(protectedQuestionType(label)).toBe(type);
  });

  it('ordinary questions are not protected', () => {
    expect(protectedQuestionType('Why do you want to work at Example Co?')).toBeNull();
    expect(protectedQuestionType('Tell us about a project you are proud of.')).toBeNull();
  });

  it('covers every server protected type', () => {
    const covered = new Set(
      [
        'authorized to work',
        'sponsorship',
        'convicted',
        'gender',
        'disability',
        'veteran',
        'current salary',
        'salary expectations',
        'years of experience',
        'degree',
        'certification',
        'clearance',
        'notice period',
      ].map((l) => protectedQuestionType(l)),
    );
    expect([...covered].sort()).toEqual([...PROTECTED_QUESTION_TYPES].sort());
  });
});

describe('resolveField', () => {
  const p = sampleProfile();

  it('reads the profile', () => {
    expect(profileValue('fullName', p)).toBe('Avery Lin');
    expect(profileValue('location', p)).toBe('Austin, Texas');
    expect(profileValue('country', p)).toBe('United States');
    expect(profileValue('linkedin', p)).toBe('https://www.linkedin.com/in/avery-example');
    expect(profileValue('currentTitle', p)).toBe('Software Engineer');
    expect(profileValue('discipline', p)).toBe('Computer Science');
    expect(profileValue('preferredName', p)).toBeNull();
  });

  it('answers work authorization and sponsorship from the user’s own rows', () => {
    const auth = fh('Are you legally authorized to work in the United States?', 'select', {}, ['Yes', 'No']);
    expect(resolveField(auth, null, 'work_authorization', p)).toEqual({ value: { kind: 'option', option: 'Yes' }, source: 'profile' });
    const sp = fh('Will you require sponsorship?', 'select', {}, ['Yes', 'No']);
    expect(resolveField(sp, null, 'sponsorship', p)).toEqual({ value: { kind: 'option', option: 'No' }, source: 'profile' });
  });

  it('"later" sponsorship answers only questions about the future', () => {
    const later = sampleProfile({ workAuth: [{ country: 'US', authorized: true, sponsorship: 'later' }] });
    expect(resolveField(fh('Do you currently require sponsorship?', 'select'), null, 'sponsorship', later)).toBeNull();
    expect(resolveField(fh('Will you now or in the future require sponsorship?', 'select'), null, 'sponsorship', later)?.value).toEqual({ kind: 'option', option: 'Yes' });
  });

  it('several countries: only the one the question names', () => {
    const two = sampleProfile({ workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }, { country: 'GB', authorized: false, sponsorship: 'now' }] });
    expect(resolveField(fh('Are you authorized to work in the UK?', 'select'), null, 'work_authorization', two)?.value).toEqual({ kind: 'option', option: 'No' });
    expect(resolveField(fh('Are you authorized to work here?', 'select'), null, 'work_authorization', two)).toBeNull();
  });

  const US_OK = sampleProfile({ workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }] });
  const US_NOW = sampleProfile({ workAuth: [{ country: 'US', authorized: true, sponsorship: 'now' }] });
  const US_LATER = sampleProfile({ workAuth: [{ country: 'US', authorized: true, sponsorship: 'later' }] });
  const US_NOT = sampleProfile({ workAuth: [{ country: 'US', authorized: false, sponsorship: 'now' }] });
  const answer = (label: string, profile = US_OK) => {
    const r = resolveField(fh(label, 'select', {}, ['Yes', 'No']), null, protectedQuestionType(label), profile);
    return r ? (r.value as { option: string }).option : null;
  };

  it.each([
    // "without sponsorship": Yes only when authorized AND no sponsorship is needed.
    ['Are you legally authorized to work in the United States without visa sponsorship?', US_OK, 'Yes'],
    ['Are you able to work in the US without requiring sponsorship now or in the future?', US_OK, 'Yes'],
    ['Can you work in the U.S. without sponsorship?', US_OK, 'Yes'],
    ['Are you legally authorized to work in the United States without visa sponsorship?', US_NOW, 'No'],
    ['Are you able to work in the US without requiring sponsorship now or in the future?', US_LATER, 'No'],
    ['Are you currently able to work in the US without sponsorship?', US_LATER, null],
    ['Are you legally authorized to work in the United States without visa sponsorship?', US_NOT, 'No'],
    // The usual polarity.
    ['Will you now or in the future require visa sponsorship?', US_OK, 'No'],
    ['Will you now or in the future require visa sponsorship?', US_NOW, 'Yes'],
    ['Do you require sponsorship to work in the US?', US_OK, 'No'],
    ['Are you legally authorized to work in the United States?', US_NOT, 'No'],
    // Two questions in one, citizenship, visa type, or not a yes/no question: Needs you.
    ['Are you authorized to work in the US? Will you require sponsorship?', US_OK, null],
    ['Are you a US citizen?', US_OK, null],
    ['What visa do you currently hold?', US_OK, null],
    ['Visa status', US_OK, null],
    ['Work authorization status', US_OK, null],
  ] as const)('%s → %s', (label, profile, want) => {
    expect(answer(label, profile)).toBe(want);
  });

  it('a single row answers only its own country (or a question that names none)', () => {
    expect(answer('Are you legally authorized to work in Canada?')).toBeNull();
    expect(answer('Are you legally authorized to work in the UK?')).toBeNull();
    expect(answer('Are you authorized to work in the European Union?')).toBeNull();
    expect(answer('Are you authorized to work in the US or Canada?')).toBeNull();
    expect(answer('Do you require sponsorship to work in Germany?')).toBeNull();
    expect(answer('Are you legally authorized to work in the United States?')).toBe('Yes');
    expect(answer('Are you legally authorized to work in this country?')).toBe('Yes');
    expect(answer('Are you authorized to work for us?')).toBe('Yes');
    const cn = sampleProfile({ workAuth: [{ country: 'CN', authorized: true, sponsorship: 'no' }] });
    expect(answer('您是否需要签证担保才能在美国工作？', cn)).toBeNull();
    expect(answer('您是否需要签证担保才能在中国工作？', cn)).toBe('No');
  });

  it('names countries without reading them into other words', () => {
    expect([...countriesNamed('Are you authorized to work in Papua New Guinea?')]).toEqual(['PG']);
    expect([...countriesNamed('Do you have a woman-owned business?')]).toEqual([]);
    expect([...countriesNamed('Are you authorized to work for us?')]).toEqual([]);
    expect([...countriesNamed('Authorized to work in the U.S.?')]).toEqual(['US']);
    expect(countriesNamed('Can you work in Northern Ireland or Ireland?')).toEqual(new Set(['GB', 'IE']));
    expect(workAuthFor('Authorized in the UK?', [{ country: 'UK', authorized: true, sponsorship: 'no' }])?.country).toBe('UK');
  });

  it('shapes', () => {
    expect(authQuestionShape('Will you require sponsorship?')).toBe('sponsorship');
    expect(authQuestionShape('Are you authorized to work in the US without sponsorship?')).toBe('without_sponsorship');
    expect(authQuestionShape('Are you a citizen?')).toBe('unclear');
  });

  it('"current" company and title come only from a job marked current', () => {
    const between = sampleProfile({ experience: [{ company: 'Past Corp', title: 'Engineer', current: false }] });
    expect(profileValue('currentCompany', between)).toBeNull();
    expect(profileValue('currentTitle', between)).toBeNull();
    expect(resolveField(fh('Current company'), 'currentCompany', null, between)).toBeNull();
  });

  it('never invents a protected answer', () => {
    for (const label of ['What are your salary expectations?', 'How many years of experience do you have?', 'Gender']) {
      expect(resolveField(fh(label), null, protectedQuestionType(label), p)).toBeNull();
    }
  });

  it('matches saved answers by text', () => {
    const answers = [{ questionKey: 'why_us', questionText: 'Why do you want to work here?', answer: 'A' }];
    expect(bankAnswerFor('Why do you want to work here', answers)?.answer).toBe('A');
    expect(bankAnswerFor('Why do you want to work here today?', answers)?.answer).toBe('A');
    expect(bankAnswerFor('What do you do for fun?', answers)).toBeNull();
  });

  it('never answers one country’s work-authorization question with another country’s saved answer', () => {
    const answers = [{ questionKey: 'uk_auth', questionText: 'Are you legally authorized to work in the United Kingdom?', answer: 'Yes' }];
    const label = 'Are you legally authorized to work in the United States?';
    // Fuzzy matching also requires the same countries named.
    expect(bankAnswerFor(label, answers)).toBeNull();
    const field = { label, kind: 'radio', required: true, options: ['Yes', 'No'] } as never;
    expect(resolveField(field, null, 'work_authorization', { ...sampleProfile(), workAuth: [], answers })).toBeNull();
  });

  it('protected questions take a saved answer only for the same question', () => {
    const answers = [{ questionKey: 'salary', questionText: 'What are your salary expectations?', answer: '120,000 USD' }];
    const field = (label: string) => ({ label, kind: 'text', required: true }) as never;
    expect(resolveField(field('What are your salary expectations?'), null, 'salary_expectation', { ...sampleProfile(), answers })).toMatchObject({ source: 'bank' });
    expect(resolveField(field('What are your salary expectations for this role?'), null, 'salary_expectation', { ...sampleProfile(), answers })).toBeNull();
  });

  it('equal-opportunity saved answers stay unfilled without the autofill_sensitive consent', () => {
    const answers = [
      { questionKey: 'gender', questionText: 'Gender', answer: 'Woman' },
      { questionKey: 'veteran', questionText: 'Veteran Status', answer: 'No' },
    ];
    const field = (label: string) => ({ label, kind: 'select', required: false, options: ['Woman', 'Man', 'No'] }) as never;
    const noConsent = { ...sampleProfile(), sensitive: null, answers };
    expect(resolveField(field('Gender'), null, 'eeo', noConsent)).toBeNull();
    expect(resolveField(field('Veteran Status'), null, 'veteran', noConsent)).toBeNull();
    const consent = { ...sampleProfile(), sensitive: { eeo: {} }, answers };
    expect(resolveField(field('Gender'), null, 'eeo', consent)).toMatchObject({ source: 'bank', sensitive: true });
  });
});

describe('matchOption', () => {
  it('exact, polarity, prefix, and ambiguity', () => {
    expect(matchOption(['Yes', 'No'], 'no')).toBe(1);
    expect(matchOption(['Yes, I am authorized', 'No, I am not'], 'Yes')).toBe(0);
    expect(matchOption(['Austin, Texas, United States', 'Boston, Massachusetts'], 'Austin, Texas')).toBe(0);
    expect(matchOption(['是', '否'], 'Yes')).toBe(0);
    expect(matchOption(['Option A', 'Option B'], 'Option')).toBe(-1);
    expect(matchOption(['A', 'B'], '')).toBe(-1);
  });
});
