// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AGE_LIMIT_TAG, ageLimitQuote, isAgeLine, readAge } from './ageLimit.js';
import { MAX_QUOTE_CHARS } from './schema.js';

/** Neither flagged as a limit nor read as an age line: the sentence is about something else. */
function expectNoAge(sentence: string): void {
  expect(ageLimitQuote(sentence), sentence).toBeNull();
  expect(isAgeLine(sentence), sentence).toBe(false);
  expect(readAge(sentence), sentence).toEqual({ age: false, limit: false, rest: [sentence] });
}

describe('age limit stated by a posting (MARKET_STRATEGY 2.5: flagged, never an input)', () => {
  it('finds an upper bound, a range, a lower bound above the working age and a birth-year bound, and quotes the sentence', () => {
    for (const sentence of [
      '年龄35岁以下，本科及以上学历。',
      '35周岁以下，有驾照优先',
      '年龄要求：22-35岁',
      '年龄不超过40周岁',
      '年龄在25至40周岁之间',
      '年龄30岁以上',
      '45岁（含）以下',
      '1990年1月1日以后出生',
      '年齡45歲以下',
      'Must be under 35 years old.',
      'Applicants aged 22-35 are preferred.',
      'Maximum age of 40.',
      'Must be at least 21 years of age.',
    ]) {
      expect(ageLimitQuote(`负责日常工作。\n${sentence}\n五险一金。`), sentence).toBe(sentence);
      expect(isAgeLine(sentence), sentence).toBe(true);
    }
  });

  it('the legal working age is not a limit an employer chose: not flagged, and still no requirement line', () => {
    for (const sentence of ['年满18周岁', '年满18周岁以上', '须年满18周岁，身体健康', '限18岁以上', 'Must be 18 or older.', 'Applicants must be at least 18 years old.']) {
      expect(ageLimitQuote(sentence), sentence).toBeNull();
      expect(isAgeLine(sentence), sentence).toBe(true);
    }
  });

  it('the ages of the people a job serves are not the applicant\'s', () => {
    for (const sentence of [
      '面向12-16岁青少年的编程课程',
      '负责12岁以下学员的训练',
      '服务60岁以上老人',
      '3-6岁幼儿教学经验',
      '主要客户为35岁以下的年轻用户',
      'Experience teaching children aged 10-14.',
      'Care for residents aged 65 to 90.',
      // Review probes: a product's market, a customer group, the people cared for or coached.
      '负责18-35岁女性护肤产品的市场推广',
      '产品主要面向35岁以下白领',
      '为30-50岁的高净值客户提供理财服务',
      '16-18岁高中生课程设计',
      'Experience marketing to consumers aged 18 to 34',
      'Experience coaching youth ages 10-18',
      'Experience caring for adults 65 and older',
      'Must be comfortable working with residents aged 65 to 90',
      'Candidates must have experience teaching children aged 10-14',
    ]) {
      expectNoAge(sentence);
    }
    // Unless the sentence names the applicant's own age.
    expect(ageLimitQuote('年龄35岁以下，负责学生管理工作')).toBe('年龄35岁以下，负责学生管理工作');
    expect(ageLimitQuote('Applicants must be under 35 years old and enjoy working with children.')).toBe('Applicants must be under 35 years old and enjoy working with children.');
  });

  it('a year followed by 生产 is a production date, not a birth year', () => {
    for (const sentence of ['1、熟悉2018年以后生产的数控设备的维修保养；', '熟悉2018年以后生产的设备', '参与制定2023年后生产计划', '2015年后生意稳步增长']) {
      expect(ageLimitQuote(sentence), sentence).toBeNull();
      expect(isAgeLine(sentence), sentence).toBe(false);
    }
    // A birth year still is one, in the forms a posting writes it.
    for (const sentence of ['1990年以后出生', '要求1995年1月1日之后出生', '1990年后生人', '1988年以后出生的应届毕业生']) {
      expect(ageLimitQuote(sentence), sentence).toBe(sentence);
    }
    // The children a job teaches have birth years too.
    expectNoAge('面向2015年以后出生的儿童开设课程');
  });

  it('a bound is the applicant\'s only when its clause says so (年龄, "must be", "applicants") or holds nothing else', () => {
    // (a) The clause says so, whatever else it holds.
    for (const sentence of ['年龄35岁以下并有相关经验', '年龄须在45周岁以下的男性', '任职要求：年龄22-35岁', '年龄原则上不超过35周岁', 'Candidates should be between 22 and 35 years old and hold a licence', 'Age limit: 35', 'Minimum age of 25 applies']) {
      expect(ageLimitQuote(sentence), sentence).toBe(sentence);
    }
    // (b) The clause holds nothing but the bound: a list number, a heading, a gender note and "preferred" aside.
    for (const sentence of ['35岁以下', '女性25-35岁', '限男性，45岁以下', '女性，25-35岁，形象气质佳', '招聘对象：18-35岁', '35岁以下优先', '18-45周岁，男女不限', '25-40 years old', 'Aged 22-35', 'Applicants, aged 22-35, are preferred', 'This position requires applicants to be aged 18 to 65']) {
      expect(ageLimitQuote(sentence), sentence).toBe(sentence);
      expect(isAgeLine(sentence), sentence).toBe(true);
    }
    // 年龄 that belongs to the people a job serves is not the applicant's.
    for (const sentence of ['用户年龄18-35岁', '目标客户年龄在25-40岁之间', '学员年龄：12-16岁', '服务对象年龄在60岁以上']) expectNoAge(sentence);
    expect(ageLimitQuote('招聘对象年龄18-35岁')).toBe('招聘对象年龄18-35岁');
    // A clause that is only a bound, inside the description of an audience, is part of that description.
    for (const sentence of ['目标人群：大学生、18-35岁、一线城市白领', '面向女性，18-35岁', 'Programs serve local youth, ages 10-18', 'Our users are students, aged 18 to 24']) expectNoAge(sentence);
    // An audience named AFTER the applicant's bound changes nothing.
    expect(ageLimitQuote('35岁以下，负责产品推广和用户运营')).toBe('35岁以下，负责产品推广和用户运营');
  });

  it('years of experience, "no limit" and other numbers are not an age', () => {
    for (const sentence of [
      '5年以上工作经验',
      '年龄不限',
      '不限年龄，欢迎应届生',
      '30人以上团队管理经验',
      '5+ years building backend services',
      'Over 20 years of experience in aged care.',
      'Up to 40 hours a week.',
      'Manage a portfolio of under 35 accounts.',
      'Score of 90 and above on the assessment.',
    ]) {
      expectNoAge(sentence);
    }
  });

  it('readAge: the age clause is taken out of a line and what else the line asks for stays, as the line writes it', () => {
    // The usual mainland form: age, education and experience on one line.
    expect(readAge('年龄25-35岁，大专及以上学历，3年以上机械维修经验')).toEqual({ age: true, limit: true, rest: ['大专及以上学历，3年以上机械维修经验'] });
    // An age clause in the middle leaves two runs, in order.
    expect(readAge('大专及以上学历，年龄25-35岁，3年以上机械维修经验').rest).toEqual(['大专及以上学历', '3年以上机械维修经验']);
    // The legal working age is taken out too; it is no limit.
    expect(readAge('年满18周岁，身体健康，能适应倒班')).toEqual({ age: true, limit: false, rest: ['身体健康，能适应倒班'] });
    expect(readAge('Must be at least 21 years of age, with a valid driver’s licence')).toEqual({ age: true, limit: true, rest: ['with a valid driver’s licence'] });
    // A run that says nothing is not a requirement: a list number, a heading, a gender note, "applicants are preferred".
    expect(readAge('1、年龄35岁以下，男女不限').rest).toEqual([]);
    expect(readAge('任职要求，年龄22-35岁；大专以上学历').rest).toEqual(['大专以上学历']);
    expect(readAge('Applicants, aged 22-35, are preferred').rest).toEqual([]);
    // Numbers with a comma in them stay whole: only the age clause is cut out.
    expect(readAge('Sales of $150,000 a year, must be 21 or older').rest).toEqual(['Sales of $150,000 a year']);
    // A line about age and nothing else leaves nothing.
    expect(readAge('年龄35周岁以下')).toEqual({ age: true, limit: true, rest: [] });
    expect(readAge('')).toEqual({ age: false, limit: false, rest: [] });
  });

  it('quotes the first such sentence, capped at the quote length', () => {
    expect(ageLimitQuote('岗位职责：负责销售。\n任职要求：年龄22-35岁，大专以上。\n年龄不超过40岁。')).toBe('任职要求：年龄22-35岁，大专以上。');
    const long = `年龄35岁以下，${'熟悉业务流程，'.repeat(60)}`;
    const quote = ageLimitQuote(long)!;
    expect(quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(long.startsWith(quote)).toBe(true);
    expect(ageLimitQuote('')).toBeNull();
    expect(AGE_LIMIT_TAG).toBe('age_limit_stated');
  });
});
