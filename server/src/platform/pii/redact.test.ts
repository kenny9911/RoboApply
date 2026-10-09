// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CN0_STORAGE_PII_KINDS,
  LLM_PII_KINDS,
  detectPii,
  isValidPrcId,
  isValidTwNationalId,
  knownValuePattern,
  markerLocaleFor,
  redactDeep,
  redactPii,
  redactText,
  redactionMarker,
} from './redact.js';

// Fixtures use the published sample numbers (GB 11643 example PRC ID, the
// common TW sample ID, the classic SSN example) and placeholder contacts.
const PRC_ID = '11010519491231002X';
const TW_ID = 'A123456789';

const ZH_RESUME = [
  '姓名：张三  性别：男  民族：汉',
  `身份证号：${PRC_ID}  健康状况：良好  政治面貌：团员`,
  '电话：138 0013 8000  邮箱：zhangsan@example.com',
  '地址：北京市朝阳区建国路88号A座1201室',
  '2019.09-2023.06 某大学 计算机科学与技术 本科',
  '本人身体健康，无乙肝。曾负责高并发系统设计，QPS 提升 3 倍。',
].join('\n');

const ZH_TW_RESUME = [
  '姓名：王小明',
  `身分證字號：${TW_ID}`,
  '手機：0912-345-678  市話：(02) 2345-6789',
  '通訊地址：台北市信義區信義路五段7號89樓',
  '健康狀況：良好',
  '2018年-2022年 國立台灣大學 資訊工程學系',
].join('\n');

const EN_RESUME = [
  'Jane Doe | jane.doe@example.com | (415) 555-2671 | +44 20 7946 0958',
  'Address: 123 Main St, Apt 4B, Springfield, IL 62701',
  'SSN: 123-45-6789',
  'Experience 2019-2023: grew revenue from 120000-150000 USD; led a team of 12.',
  'Medical history: asthma',
  'Volunteer at a public health clinic.',
].join('\n');

describe('validators', () => {
  it('accepts a valid PRC ID and rejects a bad check digit or date', () => {
    expect(isValidPrcId(PRC_ID)).toBe(true);
    expect(isValidPrcId('110105194912310021')).toBe(false);
    expect(isValidPrcId('11010519491331002X')).toBe(false);
    expect(isValidPrcId('110105 19491231 002X')).toBe(true);
  });

  it('accepts a valid TW national ID and rejects a bad one', () => {
    expect(isValidTwNationalId(TW_ID)).toBe(true);
    expect(isValidTwNationalId('A123456788')).toBe(false);
    expect(isValidTwNationalId('A323456789')).toBe(false);
  });
});

describe('redactPii — zh fixture', () => {
  const r = redactPii(ZH_RESUME, { knownValues: ['张三'], markerLocale: 'zh' });

  it('removes the PRC ID, contact details, street address and health details', () => {
    expect(r.text).not.toContain(PRC_ID);
    expect(r.text).not.toContain('138 0013 8000');
    expect(r.text).not.toContain('zhangsan@example.com');
    expect(r.text).not.toContain('建国路88号');
    expect(r.text).not.toContain('良好');
    expect(r.text).not.toContain('乙肝');
    expect(r.text).not.toContain('张三');
    expect(r.counts).toMatchObject({ prc_id: 1, phone: 1, email: 1, address: 1, health: 2, known_value: 1 });
  });

  it('keeps labels, dates, education and work content', () => {
    expect(r.text).toContain('身份证号：[已移除证件号]');
    expect(r.text).toContain('健康状况：[已移除健康信息]');
    expect(r.text).toContain('政治面貌：团员');
    expect(r.text).toContain('2019.09-2023.06 某大学 计算机科学与技术 本科');
    expect(r.text).toContain('曾负责高并发系统设计，QPS 提升 3 倍。');
  });

  it('finds an unlabelled 18-digit ID inside Chinese text, including one with a bad check digit', () => {
    expect(redactText('证件110105194912310021已过期', { kinds: ['prc_id'] })).toBe('证件[ID number removed]已过期');
    expect(redactText(`联系人 ${PRC_ID.slice(0, 6)} ${PRC_ID.slice(6, 14)} ${PRC_ID.slice(14)} 谢谢`, { kinds: ['prc_id'] })).toBe(
      '联系人 [ID number removed] 谢谢',
    );
  });

  it('removes a labelled legacy 15-digit ID', () => {
    expect(redactText('身份证号码：110105491231002', { kinds: ['prc_id'] })).toBe('身份证号码：[ID number removed]');
  });
});

describe('redactPii — zh-TW fixture', () => {
  const r = redactPii(ZH_TW_RESUME, { markerLocale: 'zh-TW' });

  it('removes the TW ID, phones, address and health status', () => {
    expect(r.text).not.toContain(TW_ID);
    expect(r.text).not.toContain('0912-345-678');
    expect(r.text).not.toContain('2345-6789');
    expect(r.text).not.toContain('信義路五段7號');
    expect(r.counts).toMatchObject({ tw_id: 1, phone: 2, address: 1, health: 1 });
    expect(r.text).toContain('身分證字號：[已移除證件號碼]');
    expect(r.text).toContain('健康狀況：[已移除健康資訊]');
  });

  it('keeps the city and the education line', () => {
    expect(r.text).toContain('2018年-2022年 國立台灣大學 資訊工程學系');
    expect(r.text).toContain('姓名：王小明');
  });
});

describe('redactPii — en fixture', () => {
  const r = redactPii(EN_RESUME, { knownValues: ['Jane Doe'] });

  it('removes name, email, phones, address, SSN and the medical field', () => {
    expect(r.text).not.toMatch(/Jane Doe|jane\.doe@example\.com|555-2671|7946|123 Main St|62701|123-45-6789|asthma/);
    expect(r.counts).toMatchObject({ known_value: 1, email: 1, phone: 2, address: 1, us_ssn: 1, health: 1 });
  });

  it('does not touch year ranges, amounts, counts or ordinary health words', () => {
    expect(r.text).toContain('Experience 2019-2023: grew revenue from 120000-150000 USD; led a team of 12.');
    expect(r.text).toContain('Volunteer at a public health clinic.');
  });

  it('removes a street address in running text and keeps "Email Address:" as an email', () => {
    const t = redactPii('Office at 1 Market Street. Email Address: a@b.co');
    expect(t.text).toBe('Office at [address removed] Email Address: [email removed]');
  });
});

describe('redactPii — options and edges', () => {
  it('only removes the requested kinds', () => {
    const r = redactPii(ZH_RESUME, { kinds: CN0_STORAGE_PII_KINDS });
    expect(r.text).not.toContain(PRC_ID);
    expect(r.text).not.toContain('乙肝');
    expect(r.text).toContain('138 0013 8000');
    expect(r.text).toContain('zhangsan@example.com');
    expect(r.counts.phone).toBe(0);
  });

  it('LLM kinds cover contact details, IDs and health', () => {
    expect(LLM_PII_KINDS).toEqual(expect.arrayContaining(['email', 'phone', 'address', 'prc_id', 'tw_id', 'us_ssn', 'health']));
  });

  it('accepts a custom marker', () => {
    expect(redactText('mail me: x@y.io', { marker: (k) => `<${k}>` })).toBe('mail me: <email>');
  });

  it('never re-detects inserted markers', () => {
    const once = redactText(EN_RESUME);
    expect(redactText(once)).toBe(once);
  });

  it('handles empty input', () => {
    expect(redactPii('').total).toBe(0);
  });

  it('finds CN mobiles with a country code and NANP numbers without separators', () => {
    expect(redactText('+86 13800138000 / 8613800138000 / 4155552671', { kinds: ['phone'] })).toBe(
      '[phone removed] / [phone removed] / [phone removed]',
    );
  });

  it('does not treat a short ID-like label value as an ID', () => {
    expect(redactText('ID No: 12', { kinds: ['prc_id'] })).toBe('ID No: 12');
  });

  it('detectPii reports kinds without changing anything', () => {
    expect(detectPii('call 0912 345 678', ['phone', 'email'])).toEqual(['phone']);
  });

  it('marker helpers map locales', () => {
    expect(markerLocaleFor('zh-TW')).toBe('zh-TW');
    expect(markerLocaleFor('zh-CN')).toBe('zh');
    expect(markerLocaleFor('ja')).toBe('en');
    expect(markerLocaleFor(null)).toBe('en');
    expect(redactionMarker('health', 'zh')).toBe('[已移除健康信息]');
  });
});

describe('redactPii — passports, travel permits and other ID documents (gov_id)', () => {
  it.each([
    ['zh', '护照号码：E12345678  出生地：上海', 'E12345678'],
    ['zh', '港澳通行证：C12345678', 'C12345678'],
    ['zh', '往来港澳通行证号码 C87654321', 'C87654321'],
    ['zh', '台胞证号：12345678', '12345678'],
    ['zh', '军官证号：南字第123456号', '123456'],
    ['zh-TW', '護照號碼：312345678  出生地：台北', '312345678'],
    ['zh-TW', '台胞證號碼：01234567', '01234567'],
    ['en', 'Passport No: 123456789', '123456789'],
    ['en', 'Passport number EA1234567, valid to 2030', 'EA1234567'],
    ['en', 'passport #: 987654321', '987654321'],
  ])('%s: %s', (_locale, line, number) => {
    const r = redactPii(line, { kinds: CN0_STORAGE_PII_KINDS });
    expect(r.text).not.toContain(number);
    expect(r.counts.gov_id).toBe(1);
  });

  it('is part of the CN-0 storage and LLM kinds, and keeps the label', () => {
    expect(CN0_STORAGE_PII_KINDS).toContain('gov_id');
    expect(LLM_PII_KINDS).toContain('gov_id');
    expect(redactText('护照号码：E12345678', { markerLocale: 'zh' })).toBe('护照号码：[已移除证件号]');
    expect(redactText('Passport No: 123456789')).toBe('Passport No: [ID number removed]');
  });

  it('leaves a passport mention without a number alone', () => {
    expect(redactText('Passport: valid; open to travel')).toBe('Passport: valid; open to travel');
    expect(redactText('持有有效护照，可出差')).toBe('持有有效护照，可出差');
  });

  it('redactDeep removes a passport-keyed value', () => {
    const r = redactDeep({ otherSections: { 护照号码: 'E12345678', Passport: 'EA1234567' } }, { kinds: CN0_STORAGE_PII_KINDS });
    expect(JSON.stringify(r.value)).not.toMatch(/E12345678|EA1234567/);
    expect(r.counts.gov_id).toBe(2);
  });
});

describe('knownValues', () => {
  it('match Latin-script values as whole words: "Li" never eats the start of "Linux"', () => {
    const r = redactPii('Li Wei — Linux kernel engineer, Lisbon', { knownValues: ['Li'], kinds: ['known_value'] });
    expect(r.text).toBe('[removed] Wei — Linux kernel engineer, Lisbon');
    expect(r.counts.known_value).toBe(1);
  });

  it('match next to CJK text and case-insensitively', () => {
    expect(redactText('联系人:Li Wei，负责Linux', { knownValues: ['li wei'], kinds: ['known_value'] })).toBe(
      '联系人:[removed]，负责Linux',
    );
  });

  it('match CJK values as substrings', () => {
    expect(redactText('张三负责后端，张三丰不是他', { knownValues: ['张三'], kinds: ['known_value'], markerLocale: 'zh' })).toBe(
      '[已移除]负责后端，[已移除]丰不是他',
    );
  });

  it('knownValuePattern ignores values shorter than 2 characters and escapes regex syntax', () => {
    expect(knownValuePattern('L')).toBeNull();
    expect(knownValuePattern('  ')).toBeNull();
    expect('a.b+c'.replace(knownValuePattern('a.b+c')!, 'X')).toBe('X');
    expect('axb+c'.replace(knownValuePattern('a.b+c')!, 'X')).toBe('axb+c');
  });
});

describe('redactDeep', () => {
  it('redacts nested strings, replaces health/ID-keyed values, and does not mutate input', () => {
    const input = {
      name: '张三',
      rawText: `身份证 ${PRC_ID}`,
      otherSections: { 健康状况: '良好', 身份证号: '110105', 籍贯: '浙江' },
      experience: [{ description: '孕期请假三个月。负责支付系统。' }],
      years: 3,
    };
    const r = redactDeep(input, { kinds: CN0_STORAGE_PII_KINDS, markerLocale: 'zh' });
    expect(r.value.rawText).not.toContain(PRC_ID);
    expect(r.value.otherSections.健康状况).toBe('[已移除健康信息]');
    expect(r.value.otherSections.身份证号).toBe('[已移除证件号]');
    expect(r.value.otherSections.籍贯).toBe('浙江');
    expect(r.value.experience[0]!.description).toBe('[已移除健康信息]。负责支付系统。');
    expect(r.value.years).toBe(3);
    expect(input.otherSections.健康状况).toBe('良好');
    expect(r.counts.prc_id).toBe(2);
    expect(r.counts.health).toBe(2);
  });
});
