// @vitest-environment node
// WP-41: GoHire honesty fields and CnCardMeta (source + updated + expiry on
// every card; 企业直招 rule; verbatim pay or "not disclosed"; tags only with a quote).

import { describe, expect, it } from 'vitest';
import {
  POSTING_TAG_PREFIXES,
  buildCnCardMeta,
  cnSalary,
  extractApplyClosesTags,
  extractClassYearTags,
  extractHireTags,
  extractInternDaysTags,
  extractPostingTags,
  extractSchoolTierTags,
  formatCnSalary,
  isDirectFromEmployer,
  mergeClassYearTags,
  mergePostingTags,
  sourceNameOf,
  statedCloseAt,
} from '../card.js';
import { publicItem } from '../../../feed/items.js';
import { retrievalSql } from '../../../feed/sql.js';
import { feedRow } from '../../../feed/testkit.js';
import { FILTER_FIELDS } from '../../../search/index.js';
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
    // FIX-3: a pasted pay line keeps its words but not its own label (the row already says 薪资: "薪资 薪资:18-28K·15薪").
    expect(cnSalary({ salaryDisclosed: true, salaryText: '薪资:18-28K·15薪', salaryMin: 18000, salaryMax: 28000 })).toEqual({ text: '18-28K·15薪', disclosed: true });
    expect(cnSalary({ salaryDisclosed: true, salaryText: '薪资范围：200-300元/天' })).toEqual({ text: '200-300元/天', disclosed: true });
    expect(cnSalary({ salaryDisclosed: true, salaryText: '月薪 4万~5万' })).toEqual({ text: '月薪 4万~5万', disclosed: true }); // no label to remove
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

describe('校招 / 社招 tags (cn_hire:)', () => {
  it('校招 stated → cn_hire:campus with the sentence it rests on', () => {
    expect(extractHireTags('岗位职责：负责后端开发。\n本岗位面向2027届校园招聘，欢迎投递。')).toEqual([
      { tag: 'cn_hire:campus', evidenceQuote: '本岗位面向2027届校园招聘，欢迎投递。', evidenceUrl: null },
    ]);
    for (const text of ['2027届秋招正式启动', '春招补录岗位', '提前批开放投递', '校招岗位']) {
      expect(extractHireTags(text).map((t) => t.tag), text).toEqual(['cn_hire:campus']);
    }
  });

  it('社招 stated → cn_hire:social; both stated → both tags, each with its own quote', () => {
    expect(extractHireTags('社会招聘：要求3年以上经验。')).toEqual([{ tag: 'cn_hire:social', evidenceQuote: '社会招聘：要求3年以上经验。', evidenceUrl: null }]);
    const both = extractHireTags('本岗位校招开放。\n同时接受社招候选人。');
    expect(both.map((t) => t.tag)).toEqual(['cn_hire:campus', 'cn_hire:social']);
    expect(both.every((t) => t.evidenceQuote.length > 0)).toBe(true);
  });

  it('without the words there is no tag: a 届别, a seniority or "应届毕业生" alone is not a statement of 校招', () => {
    for (const text of ['面向2027届毕业生。', '欢迎应届毕业生投递。', '要求3年以上工作经验。', '管理培训生项目', '']) {
      expect(extractHireTags(text), text).toEqual([]);
    }
  });

  it('a negated mention is not a statement ("不接受校招", "非社招岗位")', () => {
    expect(extractHireTags('本岗位为社招岗位，不接受校招生。').map((t) => t.tag)).toEqual(['cn_hire:social']);
    expect(extractHireTags('本岗位为校招岗位，非社招。').map((t) => t.tag)).toEqual(['cn_hire:campus']);
  });

  it('a bare 无 is not a negation: a city name does not hide the tag ("无锡校招岗位")', () => {
    expect(extractHireTags('无锡校招岗位').map((t) => t.tag)).toEqual(['cn_hire:campus']);
    expect(extractHireTags('工作地点：无锡。社招，要求3年以上经验。').map((t) => t.tag)).toEqual(['cn_hire:social']);
    expect(extractHireTags('本岗位无需校招经历').map((t) => t.tag)).toEqual([]);
  });

  it('recruiting as the WORK of the role is not its hire type: an HR duty line, title or experience line gives no tag', () => {
    for (const text of [
      '负责公司校园招聘及社会招聘全流程', // the reviewer's case: an HR role's duty
      '1、协助开展校招宣讲及面试安排；',
      '组织春招、秋招各项活动。',
      '统筹社招渠道建设，优化社会招聘流程',
      '熟悉校招、社招全流程者优先',
      '有3年以上社招经验',
      '具备校园招聘工作经验',
      '校园招聘专员',
      '招聘经理（校招方向）',
      '社招HR',
    ]) {
      expect(extractHireTags(text), text).toEqual([]);
    }
    // The same HR posting, when it does state its own hire type, is tagged from that sentence only.
    const hr = extractHireTags('校园招聘专员\n岗位职责：负责公司校园招聘及社会招聘全流程。\n招聘类型：社招。');
    expect(hr).toEqual([{ tag: 'cn_hire:social', evidenceQuote: '招聘类型：社招。', evidenceUrl: null }]);
    // An invitation is not a duty, and a duty verb in an earlier clause does not reach across the comma.
    expect(extractHireTags('欢迎参与我司2027届校招').map((t) => t.tag)).toEqual(['cn_hire:campus']);
    expect(extractHireTags('负责后端服务开发，本岗位为校招岗位。').map((t) => t.tag)).toEqual(['cn_hire:campus']);
  });
});

describe('网申截止 tags (apply_closes:)', () => {
  it('a stated full date → apply_closes:<yyyy-mm-dd> with its sentence, in every common notation', () => {
    expect(extractApplyClosesTags('网申截止时间：2026年11月30日。')).toEqual([{ tag: 'apply_closes:2026-11-30', evidenceQuote: '网申截止时间：2026年11月30日。', evidenceUrl: null }]);
    for (const [text, date] of [
      ['投递截止日期为 2026-11-05', '2026-11-05'],
      ['截止日期：2026/12/1', '2026-12-01'],
      ['简历投递截止至2026.10.31', '2026-10-31'],
      ['请于2026年11月15日前完成网申', '2026-11-15'],
      ['网申通道 2026年12月20日 23:59 截止', '2026-12-20'],
    ] as const) {
      expect(extractApplyClosesTags(text).map((t) => t.tag), text).toEqual([`apply_closes:${date}`]);
    }
  });

  it('without a stated close date there is no tag — a date with no year is not completed by guessing (D3)', () => {
    for (const text of [
      '网申截止：11月30日', // no year
      '招满即止', // no date
      '发布日期：2026年10月01日', // a date that is not a close date
      '公司成立于2010年5月1日前后', // "前" but no application word
      '网申截止时间：2026年2月30日', // not a calendar date
      '网申截止时间：2026年13月01日',
    ]) {
      expect(extractApplyClosesTags(text), text).toEqual([]);
    }
  });

  it('a date that is not an application deadline gives no tag: an "as of" date, a start date, a graduation date (D3)', () => {
    for (const text of [
      '截止2025年12月31日，集团员工总数超过10000人', // "as of" in a company intro
      '截至2025年12月31日，公司已服务超过500家客户',
      '请于2026年7月1日前到岗，简历投递邮箱见下', // a start date; the application word is in another clause
      '2027年7月31日前毕业的同学可申请', // a graduation bound
      '申请人须于2026年9月1日前取得毕业证书',
      '应聘者须2026年8月1日前能到岗',
      '项目交付截止日期：2026年12月1日', // a deadline of something else
      '活动截止时间为2026年10月20日，届时公布结果',
    ]) {
      expect(extractApplyClosesTags(text), text).toEqual([]);
    }
    // The same dates, tied to applying, are read.
    for (const [text, date] of [
      ['简历投递截止2025年12月31日，逾期不候', '2025-12-31'],
      ['请于2026年7月1日前投递简历，8月到岗', '2026-07-01'],
      ['2、截止日期：2026年12月1日', '2026-12-01'], // the bare label as a field of the posting
      ['应聘截止时间为2026年10月20日', '2026-10-20'],
      ['2027年7月31日前毕业的同学，请于2026年11月30日前完成网申', '2026-11-30'],
    ] as const) {
      expect(extractApplyClosesTags(text).map((t) => t.tag), text).toEqual([`apply_closes:${date}`]);
    }
  });

  it('several stated dates each give a tag (the feed shows the earliest that has not passed)', () => {
    const tags = extractApplyClosesTags('第一批网申截止时间：2026年10月20日。\n第二批网申截止时间：2026年11月30日。');
    expect(tags.map((t) => t.tag)).toEqual(['apply_closes:2026-10-20', 'apply_closes:2026-11-30']);
    expect(tags[1]!.evidenceQuote).toBe('第二批网申截止时间：2026年11月30日。');
  });
});

describe('实习天数 tags (intern_days:)', () => {
  it('an internship posting that states days a week → intern_days:<n> with its sentence', () => {
    expect(extractInternDaysTags('实习要求：每周至少实习4天，可连续实习3个月以上。')).toEqual([
      { tag: 'intern_days:4', evidenceQuote: '实习要求：每周至少实习4天，可连续实习3个月以上。', evidenceUrl: null },
    ]);
    expect(extractInternDaysTags('一周到岗三天', { employmentType: 'internship' }).map((t) => t.tag)).toEqual(['intern_days:3']);
    expect(extractInternDaysTags('每周3-5天', { title: '后端开发实习生' }).map((t) => t.tag)).toEqual(['intern_days:3']);
    expect(extractInternDaysTags('实习4天/周').map((t) => t.tag)).toEqual(['intern_days:4']);
  });

  it('nothing stated → no tag; a full-time job\'s working week is never read as an internship rule', () => {
    expect(extractInternDaysTags('实习生岗位，时间灵活。')).toEqual([]);
    expect(extractInternDaysTags('每周工作五天，周末双休。', { employmentType: 'full_time', title: '后端工程师' })).toEqual([]);
    expect(extractInternDaysTags('每周9天', { employmentType: 'internship' })).toEqual([]);
  });
});

describe('院校层次 tags (school_tier:)', () => {
  it('a stated tier in a school context → school_tier:<tier> with its sentence', () => {
    expect(extractSchoolTierTags('学历要求：985/211院校本科及以上优先。')).toEqual([
      { tag: 'school_tier:985', evidenceQuote: '学历要求：985/211院校本科及以上优先。', evidenceUrl: null },
      { tag: 'school_tier:211', evidenceQuote: '学历要求：985/211院校本科及以上优先。', evidenceUrl: null },
    ]);
    expect(extractSchoolTierTags('双一流建设高校应届生优先').map((t) => t.tag)).toEqual(['school_tier:double_first_class']);
  });

  it('a tier the posting says does NOT matter gives no tag: the school filter must not hide an open-to-all posting', () => {
    for (const text of [
      '不限院校，非985/211毕业生同样欢迎投递', // the reviewer's case
      '学历要求：本科及以上，不卡985、211',
      '不要求985/211/双一流院校背景',
      '本科及以上学历，985/211不限',
      '是否985、211院校不作要求，能力优先',
      '学校不是必须985',
      '不限是否双一流高校',
      '本科学历，无985/211要求',
      '对学校无要求（985、211、双非均可）',
    ]) {
      expect(extractSchoolTierTags(text), text).toEqual([]);
    }
    // A negation elsewhere in the sentence does not cancel a stated wish.
    expect(extractSchoolTierTags('专业不限，985/211院校优先').map((t) => t.tag)).toEqual(['school_tier:985', 'school_tier:211']);
    expect(extractSchoolTierTags('学历不限专业，双一流高校毕业生优先').map((t) => t.tag)).toEqual(['school_tier:double_first_class']);
    // One tier waived, another asked for, in one sentence.
    expect(extractSchoolTierTags('不卡985，但需211及以上院校毕业').map((t) => t.tag)).toEqual(['school_tier:211']);
    // A negation followed by a refusal asks FOR the tier.
    expect(extractSchoolTierTags('非211院校勿投').map((t) => t.tag)).toEqual(['school_tier:211']);
    expect(extractSchoolTierTags('非985/211院校毕业生不予考虑').map((t) => t.tag)).toEqual(['school_tier:985', 'school_tier:211']);
    // 无 only directly before the tier: a city name is not a negation.
    expect(extractSchoolTierTags('江南大学（无锡）等211院校毕业生优先').map((t) => t.tag)).toEqual(['school_tier:211']);
  });

  it('no school context or no tier → no tag (a number that merely contains 985 or 211 is not a school tier)', () => {
    for (const text of ['联系电话：021-12119850', '月薪9850元起', '房间号211', '本科及以上学历', '统招本科']) {
      expect(extractSchoolTierTags(text), text).toEqual([]);
    }
  });
});

describe('extractPostingTags / mergePostingTags', () => {
  const POSTING = [
    '后端开发实习生（2027届校招）',
    '面向2027届毕业生。',
    '每周至少实习4天。',
    '985/211院校本科及以上优先。',
    '网申截止时间：2026年11月30日。',
  ].join('\n');

  it('reads every stated tag, each with a quote; nothing for a posting that states none', () => {
    const tags = extractPostingTags(POSTING, { title: '后端开发实习生（2027届校招）' });
    expect(tags.map((t) => t.tag).sort()).toEqual(['apply_closes:2026-11-30', 'class_year:2027', 'cn_hire:campus', 'intern_days:4', 'school_tier:211', 'school_tier:985']);
    expect(tags.every((t) => t.evidenceQuote.trim().length > 0 && POSTING.includes(t.evidenceQuote))).toBe(true);
    expect(extractPostingTags('负责公司后端服务的设计与开发。')).toEqual([]);
  });

  it('replaces all of its own families together and keeps every other tag', () => {
    const existing = [
      { tag: 'hukou', evidenceQuote: '可落户上海', evidenceUrl: null },
      { tag: 'class_year:2026', evidenceQuote: '2026届', evidenceUrl: null },
      { tag: 'cn_hire:social', evidenceQuote: '社招', evidenceUrl: null },
      { tag: 'apply_closes:2026-10-01', evidenceQuote: '网申截止时间：2026年10月1日', evidenceUrl: null },
      { tag: 'intern_days:5', evidenceQuote: '每周实习5天', evidenceUrl: null },
      { tag: 'school_tier:985', evidenceQuote: '985院校', evidenceUrl: null },
    ];
    const next = extractPostingTags('本岗位校招。\n网申截止时间：2026年11月30日。');
    expect(mergePostingTags(existing, next)!.map((t) => t.tag)).toEqual(['hukou', 'cn_hire:campus', 'apply_closes:2026-11-30']);
    // The posting no longer states any: only the other modules' tags stay; nothing at all → null (column NULL).
    expect(mergePostingTags(existing, [])).toEqual([{ tag: 'hukou', evidenceQuote: '可落户上海', evidenceUrl: null }]);
    expect(mergePostingTags([{ tag: 'cn_hire:campus', evidenceQuote: '校招', evidenceUrl: null }], [])).toBeNull();
    expect([...POSTING_TAG_PREFIXES]).toEqual(['class_year:', 'cn_hire:', 'apply_closes:', 'intern_days:', 'school_tier:']);
  });

  it('the feed reads these tags: campus.applyClosesAt is the stated date, and a 校招 tag alone marks a campus card', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const tagged = publicItem(feedRow({ id: 'c1', market: 'cn', marketTags: extractPostingTags(POSTING, { title: '后端开发实习生（2027届校招）' }) }), null, now);
    expect(tagged.campus).toEqual({ applyClosesAt: '2026-11-30', applyClosesQuote: '网申截止时间：2026年11月30日。', classYears: [2027] });
    const campusOnly = publicItem(feedRow({ id: 'c2', market: 'cn', marketTags: extractHireTags('2027秋招启动') }), null, now);
    expect(campusOnly.campus).toEqual({ applyClosesAt: null, applyClosesQuote: null, classYears: [] });
    const none = publicItem(feedRow({ id: 'c3', market: 'cn', marketTags: extractPostingTags('负责后端开发。') }), null, now);
    expect(none.campus).toBeNull();
  });

  it('the GoApply deadline sort and the 校招 filter read exactly these tag names', () => {
    const scope = { market: 'cn' as const, userId: 'u1', now: new Date('2026-10-10T12:00:00Z') };
    const deadline = retrievalSql({ scope, filters: {}, fields: FILTER_FIELDS, from: null, to: null, orderBy: 'deadline', limit: 400 });
    expect(deadline.text).toContain(`'^apply_closes:[0-9]{4}-[0-9]{2}-[0-9]{2}'`);
    expect(deadline.text).not.toContain('ORDER BY j."expiresAt"');
    const campus = retrievalSql({ scope, filters: { employmentType: ['campus'] }, fields: FILTER_FIELDS, from: null, to: null, limit: 400 });
    expect(campus.values).toContainEqual(['cn_hire:campus']);
    // The 届别 fallback applies only to rows that carry no cn_hire tag at all.
    expect(campus.text.replace(/\s+/g, ' ')).toMatch(/AND NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(.*?LIKE \$\d+\) AND EXISTS \(SELECT 1 FROM jsonb_array_elements\(/);
    expect(campus.values).toContain('cn_hire:%');
    expect(campus.values).toContain('class_year:%');
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

  it('FIX-3: a pasted job that states "网申截止：2026年11月30日" shows that date, not "截止日期未注明"', () => {
    const text = '岗位职责：后端开发。\n网申截止：2026年11月30日\n工作地点：上海';
    const tags = extractPostingTags(text);
    expect(tags.map((t) => t.tag)).toContain('apply_closes:2026-11-30');
    // A user's import has no source expiry of its own.
    const now = new Date('2026-10-11T04:00:00Z');
    const meta = buildCnCardMeta({ provider: 'user_import', visibility: 'private', expiresAt: null, marketTags: tags }, { licence: null }, now);
    expect(meta.expiresAt).toBe('2026-11-30T15:59:59.000Z'); // the end of Nov 30 in Beijing
    expect(statedCloseAt(tags, now)).toBe('2026-11-30T15:59:59.000Z');
    // The stated date wins over a source expiry; a tag without its quote is not a stated date.
    expect(buildCnCardMeta({ expiresAt: new Date('2026-12-31T00:00:00Z'), marketTags: tags }, { licence: null }, now).expiresAt).toBe('2026-11-30T15:59:59.000Z');
    expect(statedCloseAt([{ tag: 'apply_closes:2026-11-30', evidenceQuote: '' }], now)).toBeNull();
    expect(statedCloseAt([{ tag: 'apply_closes:2026-12-05', evidenceQuote: 'a' }, { tag: 'apply_closes:2026-11-30', evidenceQuote: 'b' }], now)).toBe('2026-11-30T15:59:59.000Z');
  });

  it('FIX-3: with two stated dates, one passed and one to come, the card shows the one to come (as the deadline sort does)', () => {
    // 第一批网申 closed on Sep 30; 第二批 closes on Nov 30.
    const tags = [
      { tag: 'apply_closes:2026-09-30', evidenceQuote: '第一批网申截止：2026年9月30日' },
      { tag: 'apply_closes:2026-11-30', evidenceQuote: '第二批网申截止：2026年11月30日' },
    ];
    const now = new Date('2026-10-11T04:00:00Z');
    expect(statedCloseAt(tags, now)).toBe('2026-11-30T15:59:59.000Z');
    expect(buildCnCardMeta({ marketTags: tags, expiresAt: null }, { licence: null }, now).expiresAt).toBe('2026-11-30T15:59:59.000Z');
    // "Today" is the day in China: at 16:30 UTC on Sep 30 it is already Oct 1 there, so Sep 30 has passed.
    expect(statedCloseAt(tags, new Date('2026-09-30T15:30:00Z'))).toBe('2026-09-30T15:59:59.000Z');
    expect(statedCloseAt(tags, new Date('2026-09-30T16:30:00Z'))).toBe('2026-11-30T15:59:59.000Z');
    // Every stated date has passed: the latest one, shown as passed. Never an earlier one, never none.
    expect(statedCloseAt(tags, new Date('2026-12-15T04:00:00Z'))).toBe('2026-11-30T15:59:59.000Z');
    expect(statedCloseAt([{ tag: 'apply_closes:2026-09-30', evidenceQuote: 'a' }], new Date('2026-12-15T04:00:00Z'))).toBe('2026-09-30T15:59:59.000Z');
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
