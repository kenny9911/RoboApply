// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { afterNormalize } from '../marketHooks.js';
import { asMarketHookJob, normalizeProviderJob } from './normalizeProviderJob.js';
import { cleanOrNull, cleanText, decodeEntities, hostOf, htmlToPlain, normalizeCompanyName, normalizeJobTitle, safeUrl, stripControl, truncate } from './text.js';
import type { NormalizeProvider, ProviderJobInput } from './types.js';
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

// ── MKT-3C (JC-7; MARKET_STRATEGY §1.5 "Text") ──────────────────────────────
// "Strip recruiter phone numbers, WeChat ids" is a mainland rule: it lives with the mainland text rules
// (features/cn/jobs `stripContactInfo`, PAR-11) and reaches every market-cn row through the one hook
// every writer calls after `normalizeProviderJob` (`afterNormalize`: ingest, board sync, import). These
// tests pin that seam from the normalizer's side: the text the pipeline STORES for a mainland row
// carries no recruiter contact detail, and an international row is stored as written.
// SYNTHETIC postings: made-up employer, phone numbers (13800138000 is the documentation number) and ids.
describe('MKT-3C JC-7: the stored text of a mainland row carries no recruiter phone number or WeChat id', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const duties = '岗位职责：负责后端服务开发，日均处理订单13000-18000单。';
  const pay = '薪资：15-25K·14薪';
  const contact = '联系人：张女士 13800138000（微信同号）\n加微信 hr_zhang01 了解详情，或致电 021-55558888。';
  const description = [duties, pay, contact].join('\n');
  const row = (over: Partial<ProviderJobInput> = {}): ProviderJobInput => ({
    externalId: 'cn:SYNTHETIC-CONTACT',
    title: '后端工程师',
    company: '示例科技有限公司',
    location: '上海',
    locationCountry: 'CN',
    applyUrl: 'https://example.com/p/1',
    description,
    ...over,
  });
  const stored = async (input: ProviderJobInput, provider: NormalizeProvider, market: 'cn' | 'intl') => {
    const job = normalizeProviderJob(input, provider, { now, market });
    return (await afterNormalize(asMarketHookJob(job), { brand: market === 'cn' ? 'goapply' : 'roboapply', market: job.market, stage: 'ingest' })) as typeof job;
  };
  const DETAILS = ['13800138000', 'hr_zhang01', '55558888'];

  it.each(['bank_gohire', 'ats_public', 'activejobs_feed', 'user_import'] as NormalizeProvider[])('%s: both stored text columns lose the phone numbers and the WeChat id; the rest stays as written', async (provider) => {
    const job = await stored(row(provider === 'ats_public' ? { sourceBoard: 'greenhouse' } : {}), provider, 'cn');
    expect(job.market).toBe('cn');
    for (const column of [job.description, job.descriptionPlain]) {
      for (const detail of DETAILS) expect(column, `${provider} ${detail}`).not.toContain(detail);
      // Not phone-shaped, so never touched: the pay line and a number that is part of the work.
      expect(column).toContain('15-25K·14薪');
      expect(column).toContain('13000-18000单');
      expect(column).toContain('负责后端服务开发');
    }
    // The pay the row states is still read from the posting's own line.
    expect(job).toMatchObject({ salaryMin: 15000, salaryMax: 25000, salaryCurrency: 'CNY', salaryPeriod: 'month', salaryMonths: 14 });
  });

  it('markup is read as a reader would see it: a number split across tags and a tel: link are removed too', async () => {
    const html = `<p>${duties}</p><p><strong>微信：</strong>hr_zhang01</p><p>Tel:&nbsp;<a href="tel:13800138000">138<b>0013</b>8000</a></p>`;
    const job = await stored(row({ description: null, descriptionHtml: html }), 'bank_gohire', 'cn');
    for (const column of [job.description, job.descriptionPlain]) {
      expect(column).not.toContain('hr_zhang01');
      expect(column).not.toContain('13800138000');
      expect(column.replace(/<[^>]*>/g, '')).not.toMatch(/138\s*0013\s*8000/);
      expect(column).toContain('负责后端服务开发');
    }
  });

  it('words that merely mention WeChat or hold a long number are not contact details', async () => {
    const text = '任职要求：熟悉微信小程序开发与微信 SDK；统一社会信用代码 91310000MA1FL0XX0X；订单号 202610110001。';
    const job = await stored(row({ description: text }), 'bank_gohire', 'cn');
    expect(job.descriptionPlain).toBe(htmlToPlain(text));
  });

  it('the rule is the mainland\'s: an international row is stored as written', async () => {
    const job = await stored(row({ location: 'Singapore', locationCountry: 'SG' }), 'activejobs', 'intl');
    expect(job.market).toBe('intl');
    for (const detail of DETAILS) expect(job.descriptionPlain).toContain(detail);
  });

  it('the normalizer alone removes nothing (it is pure text clean-up): the strip is the hook\'s, so a writer that skips the hook would store the details', () => {
    const job = normalizeProviderJob(row(), 'bank_gohire', { now, market: 'cn' });
    for (const detail of DETAILS) expect(job.descriptionPlain).toContain(detail);
  });
});
