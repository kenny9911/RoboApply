// @vitest-environment node
// WP-41: GoHire honesty fields and CnCardMeta (source + updated + expiry on
// every card; 企业直招 rule; verbatim pay or "not disclosed"; tags only with a quote).

import { describe, expect, it } from 'vitest';
import {
  buildCnCardMeta,
  cnSalary,
  extractClassYearTags,
  formatCnSalary,
  isDirectFromEmployer,
  mergeClassYearTags,
  sourceNameOf,
} from '../card.js';
import { cardMeta, MARKET_HOOK_SETS } from '../../../jobs/marketHooks.js';
import { createCnJobsHooks } from '../hooks.js';

const LICENCE = { holder: '某某人力资源有限公司', number: '1100001234' };

describe('企业直招 rule (H13)', () => {
  it('needs recruiter bank AND verified employer AND not an agency', () => {
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: true, isAgency: false })).toBe(true);
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: true, isAgency: null })).toBe(true);
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: true, isAgency: true })).toBe(false);
    expect(isDirectFromEmployer({ fromRecruiterBank: true, employerVerified: false })).toBe(false);
    expect(isDirectFromEmployer({ fromRecruiterBank: false, employerVerified: true })).toBe(false);
  });

  it('GoHire bank rows always name GoHire as the source', () => {
    expect(sourceNameOf({ provider: 'bank_gohire' })).toBe('GoHire');
    expect(sourceNameOf({ sourceBoard: 'gohire', sourceName: null })).toBe('GoHire');
    expect(sourceNameOf({ sourceName: '某官网' })).toBe('某官网');
    expect(sourceNameOf({})).toBeNull();
  });
});

describe('pay (F-SAL-01 cn)', () => {
  it('verbatim salaryText with a figure wins', () => {
    expect(cnSalary({ salaryDisclosed: true, salaryText: '15-25K·13薪', salaryMin: 15000, salaryMax: 25000 })).toEqual({ text: '15-25K·13薪', disclosed: true });
  });
  it('not disclosed → no text (renders 薪资未披露), even with a stray figure elsewhere', () => {
    expect(cnSalary({ salaryDisclosed: false, salaryText: '面议', salaryMin: 8000 })).toEqual({ text: null, disclosed: false });
    expect(cnSalary({})).toEqual({ text: null, disclosed: false });
  });
  it('structured CNY pay in mainland notation', () => {
    const base = { salaryDisclosed: true, salaryCurrency: 'CNY' };
    expect(cnSalary({ ...base, salaryMin: 15000, salaryMax: 25000, salaryPeriod: 'month', salaryMonths: 13 }).text).toBe('15-25K·13薪');
    expect(cnSalary({ ...base, salaryMin: 8500, salaryMax: 12000, salaryPeriod: 'month', salaryMonths: 12 }).text).toBe('8.5-12K');
    expect(cnSalary({ ...base, salaryMin: 200, salaryMax: 300, salaryPeriod: 'day' }).text).toBe('200-300元/天');
    expect(cnSalary({ ...base, salaryMin: 300000, salaryMax: 500000, salaryPeriod: 'year' }).text).toBe('30-50万/年');
    expect(cnSalary({ ...base, salaryMin: 10000, salaryPeriod: 'month' }).text).toBe('10K起');
    expect(cnSalary({ ...base, salaryMin: 50, salaryMax: 50, salaryPeriod: 'hour' }).text).toBe('50元/时');
  });
  it('never guesses: no period, other currency, or no figure → not disclosed', () => {
    expect(formatCnSalary({ salaryMin: 15000, salaryMax: 25000, salaryCurrency: 'CNY' })).toBeNull();
    expect(formatCnSalary({ salaryMin: 5000, salaryMax: 6000, salaryCurrency: 'USD', salaryPeriod: 'month' })).toBeNull();
    expect(cnSalary({ salaryDisclosed: true, salaryText: '薪资优厚' })).toEqual({ text: null, disclosed: false });
  });
});

describe('届别 tags (WP-18 carry-over)', () => {
  it('reads "2027届" with its sentence', () => {
    const tags = extractClassYearTags('面向2027届毕业生。也欢迎2026 届往届生。工号1027届不算。');
    expect(tags.map((t) => t.tag)).toEqual(['class_year:2027', 'class_year:2026']);
    expect(tags[0]!.evidenceQuote).toBe('面向2027届毕业生。');
  });
  it.each(['招聘2026/2027届毕业生。', '招聘2026-2027届毕业生。', '招聘2026和2027届毕业生。', '招聘2026、2027届毕业生。', '招聘２０２６／２０２７届毕业生。'])(
    'a pair sharing one 届 gives both years: %s',
    (text) => {
      const tags = extractClassYearTags(text);
      expect(tags.map((t) => t.tag)).toEqual(['class_year:2026', 'class_year:2027']);
      for (const t of tags) expect(t.evidenceQuote).toBe(text);
    },
  );
  it('replaces only its own tags', () => {
    const merged = mergeClassYearTags(
      [
        { tag: 'soe', evidenceQuote: '央企', evidenceUrl: null },
        { tag: 'class_year:2025', evidenceQuote: '2025届', evidenceUrl: null },
      ],
      [{ tag: 'class_year:2027', evidenceQuote: '2027届', evidenceUrl: null }],
    );
    expect(merged!.map((t) => t.tag)).toEqual(['soe', 'class_year:2027']);
    expect(mergeClassYearTags(null, [])).toBeNull();
  });
});

describe('buildCnCardMeta', () => {
  const gohire = {
    provider: 'bank_gohire',
    sourceBoard: 'gohire',
    sourceName: 'GoHire',
    fromRecruiterBank: true,
    employerVerified: true,
    isAgency: false,
    salaryDisclosed: true,
    salaryText: '15-25K·13薪',
    lastSeenAt: new Date('2026-10-09T00:00:00Z'),
    postedAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: new Date('2026-11-15T00:00:00Z'),
    marketTags: [
      { tag: 'soe', evidenceQuote: '公司为中央企业下属单位', evidenceUrl: null },
      { tag: 'hukou', evidenceQuote: '', evidenceUrl: null },
      { tag: 'bianzhi' },
      { tag: 'class_year:2027', evidenceQuote: '面向2027届毕业生' },
    ],
    employerTags: ['soe', 'hukou', 'bianzhi'],
    applicantCount: 99,
    fraudFlags: [{ rule: 'upfront_fee', evidence: '押金', at: '2026-10-01T00:00:00Z' }],
  };

  it('source, updated and expiry on the card; quoted tags only; no counts', () => {
    const meta = buildCnCardMeta(gohire, { licence: LICENCE });
    expect(meta.sourceLine).toEqual({ kind: 'direct', sourceName: 'GoHire', originalSourceName: null, licence: LICENCE });
    // "Updated" is the posting's own date; when we last saw it is "Last checked" (D3).
    expect(meta.updatedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(meta.lastCheckedAt).toBe('2026-10-09T00:00:00.000Z');
    expect(meta.expiresAt).toBe('2026-11-15T00:00:00.000Z');
    expect(meta.tags).toEqual([{ tag: 'soe', evidenceQuote: '公司为中央企业下属单位', evidenceUrl: null }]);
    expect(meta.classYears).toEqual([{ year: 2027, evidenceQuote: '面向2027届毕业生' }]);
    expect(meta.salary).toEqual({ text: '15-25K·13薪', disclosed: true });
    expect(JSON.stringify(meta)).not.toMatch(/applicant|views?Count|funding/i);
    // Indexed jobs never carry warnings (flagged ones are not shown at all).
    expect(meta.warnings).toEqual([]);
  });

  it('an agency or unverified employer reads "来源：GoHire"; licence only for GoHire', () => {
    expect(buildCnCardMeta({ ...gohire, isAgency: true }, { licence: LICENCE }).sourceLine.kind).toBe('source');
    const other = buildCnCardMeta({ sourceName: '某招聘官网', fromRecruiterBank: false }, { licence: LICENCE });
    expect(other.sourceLine).toMatchObject({ kind: 'source', sourceName: '某招聘官网', licence: null });
  });

  it("warnings show on the user's own import", () => {
    const meta = buildCnCardMeta({ ...gohire, provider: 'user_import', visibility: 'private' }, { licence: null });
    expect(meta.warnings).toEqual([{ rule: 'upfront_fee', evidence: '押金', ai: false }]);
  });

  it('our crawl time is never the "Updated" date', () => {
    const meta = buildCnCardMeta({ lastSeenAt: new Date('2026-10-09T00:00:00Z') }, { licence: null });
    expect(meta.updatedAt).toBeNull();
    expect(meta.lastCheckedAt).toBe('2026-10-09T00:00:00.000Z');
  });

  it('unknown dates stay null (rendered "Not listed")', () => {
    const meta = buildCnCardMeta({}, { licence: null });
    expect(meta.updatedAt).toBeNull();
    expect(meta.lastCheckedAt).toBeNull();
    expect(meta.expiresAt).toBeNull();
  });
});

describe('marketHooks registration', () => {
  it('the cn set is statically registered and keyed "cn"', () => {
    expect(MARKET_HOOK_SETS.map((s) => s.id)).toContain('cn');
    const out = cardMeta({ market: 'cn', provider: 'bank_gohire', salaryDisclosed: false }, { brand: 'goapply', market: 'cn', stage: 'card' });
    expect(out.cn).toMatchObject({ sourceLine: { sourceName: 'GoHire' }, salary: { text: null, disclosed: false } });
    expect(cardMeta({ market: 'intl' }, { brand: 'roboapply', market: 'intl', stage: 'card' }).cn).toBeUndefined();
  });

  it('licence line follows the mode and env', () => {
    const env = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink', CN_HR_LICENCE_HOLDER: LICENCE.holder, CN_HR_LICENCE_NUMBER: LICENCE.number };
    const hooks = createCnJobsHooks({ env: () => env, deps: () => { throw new Error('not used'); } });
    const meta = hooks.cardMeta!({ market: 'cn', provider: 'bank_gohire' }, { brand: 'goapply', market: 'cn', stage: 'card' }) as { sourceLine: { licence: unknown } };
    expect(meta.sourceLine.licence).toEqual(LICENCE);
    const off = createCnJobsHooks({ env: () => ({ ...env, CN_RECRUITMENT_INFO_MODE: 'off' }), deps: () => { throw new Error('not used'); } });
    expect((off.cardMeta!({ market: 'cn', provider: 'bank_gohire' }, { brand: 'goapply', market: 'cn', stage: 'card' }) as { sourceLine: { licence: unknown } }).sourceLine.licence).toBeNull();
  });
});
