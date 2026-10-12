// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  educationFromLabel,
  educationFromText,
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

describe('mainland employment types (PAR-7)', () => {
  it.each([
    ['全职', 'full_time'],
    ['兼职', 'part_time'],
    ['实习', 'internship'],
    ['合同', 'contract'],
    ['合同工', 'contract'],
    ['劳务', 'contract'],
    ['劳务派遣', 'contract'],
    ['FULL_TIME', 'full_time'],
    ['其他', null],
  ])('label %s → %s', (label, expected) => {
    expect(employmentTypeFromLabel(label)).toBe(expected);
  });
});

describe('education (PAR-7): the lowest level a posting asks for, with its words', () => {
  it.each([
    ['任职要求：本科及以上学历，计算机相关专业', 'bachelor', '本科及以上学历'],
    ['学历不限，有相关经验即可', 'none', '学历不限'],
    ['不限学历', 'none', '不限学历'],
    ['大专及以上学历', 'associate', '大专及以上学历'],
    ['专科以上，三年经验', 'associate', '专科以上'],
    ['硕士及以上学历，博士优先', 'master', '硕士及以上学历'],
    ['任职要求：博士学位，机器学习方向', 'phd', '博士学位'],
    ['统招本科及以上', 'bachelor', '统招本科及以上'],
    ['全日制大专或以上学历', 'associate', '全日制大专或以上学历'],
    ['要求本科学历，硕士优先', 'bachelor', '本科学历'],
    ['需具备硕士学位', 'master', '硕士学位'],
    ['学历：本科', 'bachelor', '学历:本科'],
    // A bare level in the list under a requirement heading.
    ['任职要求：\n1、熟悉Java\n2、本科学历，计算机相关专业', 'bachelor', '本科学历'],
    ['【任职资格】\n- 统招本科\n- 英语流利', 'bachelor', '统招本科'],
    ['任职资格\n全日制本科\n三年经验', 'bachelor', '全日制本科'],
    // Several levels: the lowest stated minimum is the requirement.
    ['研发岗硕士及以上；测试岗本科及以上', 'bachelor', '本科及以上'],
    ['學歷要求：大專及以上', 'associate', '大專及以上'],
  ])('%s → %s', (text, level, quote) => {
    expect(educationFromText(text)).toEqual({ level, quote });
  });

  it.each([
    // Review cases: the company's own staff and a benefit are not a requirement (D3).
    '公司简介:我们团队60%成员拥有硕士学历,其中博士学位20人。岗位要求:3年经验',
    '研发团队由多名博士毕业的科学家带领。任职要求:熟悉Java',
    '我们为员工提供在职研究生学历教育补贴',
    // A bare level with nothing that says it is required.
    '博士学位，机器学习方向',
    '本科学历，硕士优先',
    // Under a heading that is not a requirement heading.
    '任职要求：熟悉Java。\n福利待遇：\n提供在职研究生学历教育补贴',
    '关于我们\n团队成员均为全日制硕士\n任职要求\n熟悉Go',
    '加分项：\n博士学位',
  ])('a degree the posting does not state as a requirement is not read: %s', (text) => {
    expect(educationFromText(text)).toBeNull();
  });

  it('a degree named only as a plus, or no statement at all, is not a requirement', () => {
    expect(educationFromText('硕士优先，有大厂经验更佳')).toBeNull();
    expect(educationFromText('负责后端服务开发，熟悉 Java。')).toBeNull();
    expect(educationFromText('Bachelor degree or above')).toBeNull();
    expect(educationFromText(null)).toBeNull();
    expect(educationFromText('')).toBeNull();
  });

  it('the quote is the posting\'s own words, at most 60 characters', () => {
    const text = `要求：${'统招'}本科及以上学历`;
    const out = educationFromText(text)!;
    expect(text).toContain(out.quote);
    expect(out.quote.length).toBeLessThanOrEqual(60);
  });

  it.each([
    ['本科', 'bachelor'],
    ['bachelor', 'bachelor'],
    ['associate', 'associate'],
    ['大专', 'associate'],
    ['专科', 'associate'],
    ['硕士', 'master'],
    ['研究生', 'master'],
    ['master', 'master'],
    ['博士', 'phd'],
    ['phd', 'phd'],
    ['不限', 'none'],
    ['none', 'none'],
    ['high_school', null],
    ['中专', null],
    ['', null],
    [null, null],
  ])('bank label %s → %s', (label, expected) => {
    expect(educationFromLabel(label)).toBe(expected);
  });
});
