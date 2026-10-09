// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  employmentTypeFromLabel,
  employmentTypeFromTitle,
  roleTypeFromTitle,
  seniorityFromLabel,
  seniorityFromTitle,
  seniorityFromYears,
  yearsFromProvider,
  yearsFromText,
} from './level.js';

describe('seniorityFromTitle', () => {
  it.each([
    ['Software Engineering Intern', 'intern_newgrad'],
    ['New Grad Software Engineer 2027', 'intern_newgrad'],
    ['Graduate Software Engineer', 'intern_newgrad'],
    ['数据分析实习生', 'intern_newgrad'],
    ['Java后端开发工程师（2027届校招）', 'intern_newgrad'],
    ['儲備幹部', 'intern_newgrad'],
    ['Director of Engineering', 'director_exec'],
    ['VP, Product', 'director_exec'],
    ['Head of Design', 'director_exec'],
    ['Associate Director, Finance', 'director_exec'],
    ['CTO', 'director_exec'],
    ['技术总监', 'director_exec'],
    ['Staff Software Engineer', 'lead_staff'],
    ['Principal Data Scientist', 'lead_staff'],
    ['Engineering Manager', 'lead_staff'],
    ['技术经理', 'lead_staff'],
    ['Senior Product Manager', 'senior'],
    ['Sr. Backend Engineer', 'senior'],
    ['资深算法工程师', 'senior'],
    ['資深後端工程師', 'senior'],
    ['高级产品经理', 'senior'],
    ['Mid-level Accountant', 'mid'],
    ['中级会计', 'mid'],
    ['Junior Designer', 'entry'],
    ['Associate Product Manager', 'entry'],
    ['Entry Level Analyst', 'entry'],
    ['初级测试工程师', 'entry'],
    ['Software Engineer I', 'entry'],
    ['Software Engineer II', 'mid'],
    ['Data Scientist III', 'senior'],
    ['SDE 4', 'lead_staff'],
    ['Product Manager', null],
    ['产品经理', null],
    ['Software Engineer', null],
    ['', null],
  ])('%s → %s', (title, expected) => {
    expect(seniorityFromTitle(title)).toBe(expected);
  });
});

describe('seniorityFromLabel / seniorityFromYears', () => {
  it.each([
    ['Internship', 'intern_newgrad'],
    ['实习', 'intern_newgrad'],
    ['Executive', 'director_exec'],
    ['Director', 'director_exec'],
    ['Mid-Senior level', 'senior'],
    ['lead', 'lead_staff'],
    ['Senior', 'senior'],
    ['mid', 'mid'],
    ['Entry level', 'entry'],
    ['Associate', 'entry'],
    ['Not Applicable', null],
    ['   ', null],
    [null, null],
  ])('label %s → %s', (label, expected) => {
    expect(seniorityFromLabel(label as string | null)).toBe(expected);
  });

  it('bands years', () => {
    expect([0, 1, 2, 4, 5, 7, 8, 15].map(seniorityFromYears)).toEqual(['entry', 'entry', 'mid', 'mid', 'senior', 'senior', 'lead_staff', 'lead_staff']);
    expect(seniorityFromYears(null)).toBeNull();
  });
});

describe('roleTypeFromTitle', () => {
  it.each([
    ['Engineering Manager', 'manager'],
    ['Director of Product', 'manager'],
    ['Head of Data', 'manager'],
    ['Team Lead, Support', 'manager'],
    ['技术经理', 'manager'],
    ['销售总监', 'manager'],
    ['Product Manager', 'ic'],
    ['Senior Program Manager', 'ic'],
    ['Account Manager', 'ic'],
    ['产品经理', 'ic'],
    ['Group Product Manager', 'manager'],
    ['Software Engineer', 'ic'],
    ['', null],
  ])('%s → %s', (title, expected) => {
    expect(roleTypeFromTitle(title)).toBe(expected);
  });
});

describe('yearsFromText', () => {
  it.each([
    ['5+ years of experience building backend services', { min: 5, max: null }],
    ['Requires 3-5 years of professional experience.', { min: 3, max: 5 }],
    ['At least 2 years experience with SQL', { min: 2, max: null }],
    ['Experience: 4 to 6 years', { min: 4, max: 6 }],
    ["7 years' experience in finance", { min: 7, max: null }],
    ['8+ yrs in a fast-paced environment', { min: 8, max: null }],
    ['5+ years Python; 3+ years AWS experience', { min: 3, max: null }],
    ['10 - 5 years of experience', { min: 5, max: 10 }],
    ['3年以上后端开发经验', { min: 3, max: null }],
    ['工作经验：3-5年', { min: 3, max: 5 }],
    ['三年以上相关工作经验', { min: 3, max: null }],
    ['十年以上從業經驗', { min: 10, max: null }],
    ['两年以上开发经验', { min: 2, max: null }],
    ['十二年以上工作经验', { min: 12, max: null }],
    ['经验1年以下', { min: 0, max: 1 }],
    ['经验不限', { min: 0, max: null }],
    ['No experience required', { min: 0, max: null }],
  ])('%s', (text, expected) => {
    expect(yearsFromText(text)).toEqual(expected);
  });

  it.each([
    'We were founded 20 years ago.',
    'Over the past 10 years of growth, we have hired widely.',
    'Our 4 year vesting schedule.',
    '公司成立15年，总部位于深圳。',
    '2025年10月入职',
    '',
    'Requires 45 years of experience',
    '二十年以上工作经验',
  ])('ignores %s', (text) => {
    expect(yearsFromText(text)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(yearsFromText(null)).toBeNull();
  });
});

describe('yearsFromProvider', () => {
  it.each([
    ['0-2', null, { min: 0, max: 2 }],
    ['5-10', null, { min: 5, max: 10 }],
    ['10+', null, { min: 10, max: null }],
    ['3 years', null, { min: 3, max: 3 }],
    ['3年', null, { min: 3, max: 3 }],
    ['unknown', null, null],
    [null, 24, { min: 2, max: null }],
    [null, 0, { min: 0, max: null }],
    [null, -1, null],
    [null, null, null],
  ])('%s / %s months', (band, months, expected) => {
    expect(yearsFromProvider(band as string | null, months as number | null)).toEqual(expected);
  });
});

describe('employment type', () => {
  it.each([
    ['FULL_TIME', 'full_time'],
    ['FULLTIME', 'full_time'],
    ['full-time', 'full_time'],
    ['Permanent', 'full_time'],
    ['全職', 'full_time'],
    ['PART_TIME', 'part_time'],
    ['兼职', 'part_time'],
    ['CONTRACTOR', 'contract'],
    ['Temporary', 'contract'],
    ['派遣', 'contract'],
    ['INTERN', 'internship'],
    ['internship', 'internship'],
    ['实习', 'internship'],
    ['VOLUNTEER', null],
    ['', null],
    [null, null],
  ])('label %s → %s', (label, expected) => {
    expect(employmentTypeFromLabel(label as string | null)).toBe(expected);
  });

  it('reads the first usable entry of a list', () => {
    expect(employmentTypeFromLabel(['', 'CONTRACTOR', 'FULL_TIME'])).toBe('contract');
    expect(employmentTypeFromLabel([])).toBeNull();
  });

  it.each([
    ['Summer Intern, Data', 'internship'],
    ['Part-time Barista', 'part_time'],
    ['Data Engineer (Contract)', 'contract'],
    ['Full-time Nurse', 'full_time'],
    ['数据分析实习生', 'internship'],
    ['Software Engineer', null],
  ])('title %s → %s', (title, expected) => {
    expect(employmentTypeFromTitle(title)).toBe(expected);
  });
});

describe('review regressions: "staff" and "lead" are levels only for IC roles and team leads', () => {
  it.each([
    ['Staff Accountant', null],
    ['Staff Nurse', null],
    ['Lead Generation Specialist', null],
    ['Sales Lead', null],
    ['Staff Software Engineer', 'lead_staff'],
    ['Staff Data Scientist', 'lead_staff'],
    ['Staff Product Manager', 'lead_staff'],
    ['Lead Engineer', 'lead_staff'],
    ['Lead Data Scientist', 'lead_staff'],
    ['Tech Lead', 'lead_staff'],
    ['Team Lead, Customer Support', 'lead_staff'],
    ['Engineering Lead', 'lead_staff'],
  ])('%s → %s', (title, expected) => {
    expect(seniorityFromTitle(title)).toBe(expected);
  });
});
