// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cleanOrNull, cleanText, decodeEntities, hostOf, htmlToPlain, normalizeCompanyName, normalizeJobTitle, safeUrl, stripControl, truncate } from './text.js';
import { foldTwToCn } from './zhVariants.js';

describe('normalizeJobTitle', () => {
  it.each([
    ['Senior Backend Engineer (Remote - US)', 'senior backend engineer'],
    ['Software Engineer II - Austin, TX', 'software engineer ii'],
    ['Software Engineer | Remote', 'software engineer'],
    ['Data Scientist (m/w/d)', 'data scientist'],
    ['Data Scientist (f/m/x) – Berlin', 'data scientist'],
    ['Backend Developer (Go)', 'backend developer go'],
    ['Staff Engineer (Req #48213)', 'staff engineer'],
    ['URGENT: Registered Nurse', 'registered nurse'],
    ['C++ Developer', 'c++ developer'],
    ['C# / .NET Engineer', 'c# dotnet engineer'],
    ['Node.js Engineer', 'nodejs engineer'],
    ['Sr. Product Manager', 'sr product manager'],
    ['Ｊａｖａ后端开发工程师【急招】', 'java后端开发工程师'],
    ['資深後端工程師【急徵】', '資深後端工程師'],
    ['Engineer - Payments', 'engineer payments'],
    ['Nurse (Austin / Remote)', 'nurse'],
    ['Nurse (Austin / Payments)', 'nurse austin payments'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeJobTitle(input)).toBe(expected);
  });

  it('keeps level words so different levels never share a dedupe key', () => {
    expect(normalizeJobTitle('Senior Software Engineer')).not.toBe(normalizeJobTitle('Software Engineer'));
    expect(normalizeJobTitle(null)).toBe('');
  });
});

describe('normalizeCompanyName', () => {
  it.each([
    ['Acme Analytics, Inc.', 'acme analytics'],
    ['The Walt Disney Company', 'walt disney'],
    ['Northwind Payments Ltd', 'northwind payments'],
    ['Contoso Holdings LLC', 'contoso'],
    ['SAP SE', 'sap'],
    ['Spotify AB', 'spotify'],
    ['Amazon.com, Inc.', 'amazon'],
    ['AT&T Inc.', 'at&t'],
    ['Microsoft (China) Co., Ltd.', 'microsoft'],
    ['示例科技（深圳）有限公司', '示例科技'],
    ['示例科技有限公司北京分公司', '示例科技'],
    ['中国样例银行上海分行', '中国样例银行'],
    ['範例資訊股份有限公司', '範例資訊'],
    ['株式会社サンプル', 'サンプル'],
    ['样例公司', '样例'],
    ['示例科技有限公司某某分公司', '示例科技'],
    ['某某分公司', '某某分'],
    ['Inc', 'inc'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCompanyName(input)).toBe(expected);
  });
});

describe('text helpers', () => {
  it('strips control characters but keeps tabs and newlines', () => {
    expect(stripControl('a\u0000b\tc\nd\u0007')).toBe('ab\tc\nd');
    expect(cleanText('  ｆｕｌｌ  ')).toBe('full');
    expect(cleanText(null)).toBe('');
    expect(cleanOrNull('  ')).toBeNull();
    expect(cleanOrNull(5)).toBeNull();
    expect(cleanOrNull(' x ')).toBe('x');
  });

  it('turns HTML into readable plain text', () => {
    const html = '<p>About&nbsp;us</p><ul><li>Go &amp; Python</li><li>5+ years</li></ul><script>x()</script><br/>Done &#39;now&#39; &#x4e2d;';
    expect(htmlToPlain(html)).toBe("About us\n\n• Go & Python\n\n• 5+ years\n\nDone 'now' 中");
    expect(htmlToPlain('Plain text \n\n\n\nkept')).toBe('Plain text\n\nkept');
    expect(htmlToPlain('')).toBe('');
    expect(decodeEntities('&bogus; &#0; &#x0; &#99999999;')).toBe('&bogus; &#0; &#x0; &#99999999;');
  });

  // PAR gate (PAR-11 review): a provider description of unclosed openers used to cost a
  // second or more per 100 KB here, on every ingest pass (the patterns restarted at each
  // "<"). The measured time is a few milliseconds; the limit is generous for a busy machine.
  it.each(['<li ', '<a ', '<', '<script ', '<!-- ', '<p class="'])('htmlToPlain reads 200 KB of %j in linear time', (unit) => {
    const input = unit.repeat(Math.ceil(200_000 / unit.length));
    const started = performance.now();
    htmlToPlain(input);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('htmlToPlain keeps the words of text that only looks like markup', () => {
    expect(htmlToPlain('if a<b then c, and x < y')).toBe('if a<b then c, and x < y');
    expect(htmlToPlain('<p class="a" data-x="<li <li">一</p><!-- c --><p>二 &amp; 三</p>')).toBe('一\n二 & 三');
  });

  it('accepts only http(s) URLs without credentials', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://user:pw@example.com')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(hostOf('https://www.Example.com/x')).toBe('example.com');
    expect(hostOf(null)).toBeNull();
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('ab', 3)).toBe('ab');
  });
});

describe('foldTwToCn (matching only)', () => {
  it('folds Taiwan vocabulary and Traditional characters', () => {
    expect(foldTwToCn('資深後端工程師')).toBe('资深后端工程师');
    expect(foldTwToCn('資料分析師')).toBe('数据分析师');
    expect(foldTwToCn('軟體工程師')).toBe('软件工程师');
    expect(foldTwToCn('Backend Engineer')).toBe('Backend Engineer');
  });
});
