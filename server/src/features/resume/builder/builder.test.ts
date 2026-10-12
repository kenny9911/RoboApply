// @vitest-environment node
//
// WP-65 guided builder (pure parts): section sets per brand and locale, the
// composer (personal details never in the text), and prompt hygiene (photo,
// 籍贯, 政治面貌, gender, birth date and family members never in a prompt).

import { describe, expect, it } from 'vitest';

import { BuilderDraftSchema, BuilderSuggestBodySchema } from '../contract.js';
import { parseResume, resumeForLlm } from '../check/resumeText.js';
import { composeBuilderResume, inline } from './compose.js';
import { builderPromptInput, builderSystemPrompt, draftContextLines, formatBuilderPrompt, parseBuilderOutput, sanitizePromptText } from './prompt.js';
import { BUILDER_STEPS, DOCUMENT_ORDER, builderConfigFor, builderVariantFor, headingFor } from './sections.js';
import { CN_DRAFT, INTL_DRAFT, SENSITIVE, TW_DRAFT } from './fixtures.js';

describe('builder variant and section sets per brand / locale', () => {
  it('GoApply → cn; RoboApply zh-TW (and zh-Hant) → tw; everything else → intl', () => {
    expect(builderVariantFor({ market: 'cn', locale: 'zh' })).toBe('cn');
    expect(builderVariantFor({ market: 'cn', locale: 'en' })).toBe('cn');
    expect(builderVariantFor({ market: 'intl', locale: 'zh-TW' })).toBe('tw');
    expect(builderVariantFor({ market: 'intl', locale: 'zh-Hant-TW' })).toBe('tw');
    expect(builderVariantFor({ market: 'intl', locale: 'zh' })).toBe('intl');
    expect(builderVariantFor({ market: 'intl', locale: 'ja' })).toBe('intl');
    expect(builderVariantFor({ market: null, locale: null })).toBe('intl');
  });

  it('intl: role, contact, education, experience (bullet prompts), skills, summary', () => {
    const c = builderConfigFor({ market: 'intl', locale: 'en', page: 'letter', aiAvailable: true });
    expect(c.steps.map((s) => s.key)).toEqual(['intent', 'basics', 'education', 'experience', 'projects', 'skills', 'summary']);
    expect(c.steps.find((s) => s.key === 'experience')!.ai).toBe('bullets');
    expect(c.docLanguages).toEqual(['en']);
    expect(c.photo.offered).toBe(false);
    expect(c.personalFields).toEqual([]);
    expect(c.salaryKinds).toEqual([]);
    expect(c.page).toBe('letter');
    expect(c.maxPages).toBe(1);
    expect(c.template).toBe('standard');
  });

  it('cn: the 应届 section set, zh/en documents, A4 up to 2 pages, optional photo / 籍贯 / 政治面貌', () => {
    const c = builderConfigFor({ market: 'cn', locale: 'zh', page: 'letter', aiAvailable: true });
    expect(c.steps.map((s) => s.key)).toEqual(['basics', 'intent', 'education', 'internship', 'projects', 'campus', 'certificates', 'awards', 'selfEvaluation', 'personal']);
    expect(c.docLanguages).toEqual(['zh', 'en']);
    expect(c.page).toBe('a4');
    expect(c.maxPages).toBe(2);
    expect(c.template).toBe('campus');
    expect(c.photo).toEqual({ offered: true, defaultOn: { en: false, zh: false, 'zh-TW': false } });
    expect(c.personalFields).toEqual(['nativePlace', 'politicalStatus']);
    expect(c.certificateSuggestions).toEqual(expect.arrayContaining(['CET-4', 'CET-6']));
    expect(c.headings.zh).toMatchObject({ intent: '求职意向', education: '教育背景', internship: '实习经历', projects: '项目经历', campus: '校园经历', certificates: '技能证书', awards: '获奖情况', selfEvaluation: '自我评价' });
    expect(c.headings.en.certificates).toBe('Skills & certificates');
    expect(c.salaryKinds).toEqual(['negotiable', 'amount']);
  });

  it('tw: 自傳, 期望待遇 "依公司規定 / 面議", photo on for Chinese and off for English', () => {
    const c = builderConfigFor({ market: 'intl', locale: 'zh-TW', page: 'a4', aiAvailable: true });
    expect(c.variant).toBe('tw');
    expect(c.steps.map((s) => s.key)).toContain('autobiography');
    expect(c.docLanguages).toEqual(['zh-TW', 'en']);
    expect(c.photo).toEqual({ offered: true, defaultOn: { en: false, zh: false, 'zh-TW': true } });
    expect(c.salaryKinds).toEqual(['company_policy', 'negotiable', 'amount']);
    expect(c.personalFields).toEqual([]);
    expect(c.headings['zh-TW'].autobiography).toBe('自傳');
  });

  it('without AI the steps carry no AI action', () => {
    for (const market of ['intl', 'cn']) {
      const c = builderConfigFor({ market, locale: 'en', page: 'letter', aiAvailable: false });
      expect(c.aiAvailable).toBe(false);
      expect(c.steps.every((s) => s.ai === null)).toBe(true);
    }
  });

  it('every document section has a title in every language', () => {
    for (const variant of ['intl', 'tw', 'cn'] as const) {
      for (const section of DOCUMENT_ORDER[variant]) {
        for (const lang of ['en', 'zh', 'zh-TW'] as const) expect(headingFor(section, lang, variant)).not.toBe(section);
      }
      expect(BUILDER_STEPS[variant].some((s) => s.key === 'basics' && !s.optional)).toBe(true);
    }
  });
});

describe('composeBuilderResume', () => {
  it('cn: writes the 应届 sections in order, STAR as bullets, CET + skills under 技能证书', () => {
    const out = composeBuilderResume(CN_DRAFT, 'cn');
    const headings = [...out.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['求职意向', '教育背景', '实习经历', '项目经历', '校园经历', '技能证书', '获奖情况', '自我评价']);
    expect(out.markdown).toMatch(/^# 李同学$/m);
    expect(out.markdown).toContain('期望职位：数据分析实习生 ｜ 期望城市：上海、杭州 ｜ 期望薪资：面议 ｜ 到岗时间：一周内');
    expect(out.markdown).toContain('### 本科 统计学 · 示例大学 · 2022.09 – 2026.06');
    expect(out.markdown).toContain('- 成绩：3.6/4.0');
    const star = out.markdown.split('### 校园二手平台分析')[1]!.split('##')[0]!;
    expect(star.indexOf('平台交易量下降')).toBeLessThan(star.indexOf('找出下降原因'));
    expect(star.indexOf('分析 2 万条交易记录')).toBeLessThan(star.indexOf('提出 3 条改进建议并被采纳'));
    expect(out.markdown).toContain('- CET-6（560）');
    expect(out.markdown).toContain('- 技能：Python、SQL、Excel');
    expect(out.layout).toEqual({ template: 'campus', page: 'a4', personal: { nativePlace: SENSITIVE.nativePlace, politicalStatus: SENSITIVE.politicalStatus }, photo: true });
    expect(out.targetTitle).toBe('数据分析实习生');
  });

  it('never writes photo, 籍贯 or 政治面貌 into the resume text', () => {
    const out = composeBuilderResume(CN_DRAFT, 'cn');
    for (const v of Object.values(SENSITIVE)) expect(out.markdown).not.toContain(v);
    expect(out.markdown).not.toMatch(/籍贯|政治面貌|照片|photo/i);
    // …so the prompt text built from the resume cannot carry them either.
    const llm = resumeForLlm(out.markdown);
    for (const v of Object.values(SENSITIVE)) expect(llm).not.toContain(v);
  });

  it('an English cn resume uses English titles and labels', () => {
    const out = composeBuilderResume({ ...CN_DRAFT, docLanguage: 'en' }, 'cn');
    expect(out.markdown).toContain('## Job objective');
    expect(out.markdown).toContain('## Skills & certificates');
    expect(out.markdown).toContain('Expected pay: Negotiable');
  });

  it('intl: the editor format — target title first in the contact line, standard sections', () => {
    const out = composeBuilderResume(INTL_DRAFT, 'intl');
    expect(out.markdown).toContain('*Junior Data Analyst · sam@example.test · +1 415 555 0100 · Austin, TX · github.com/samr*');
    expect([...out.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['Summary', 'Experience', 'Education', 'Skills']);
    expect(out.markdown).toContain('### Acme Co · Analyst Intern · Jun 2023 – Aug 2023');
    expect(out.markdown).toContain('*Austin, TX*');
    expect(out.markdown).toContain('SQL · Excel · Tableau');
    expect(out.layout).toEqual({ template: 'standard' });
  });

  it('tw: 求職條件 with 依公司規定, 自傳, a photo flag and no personal details', () => {
    const out = composeBuilderResume(TW_DRAFT, 'tw');
    expect(out.markdown).toContain('## 求職條件');
    expect(out.markdown).toContain('期望待遇：依公司規定');
    expect(out.markdown).toContain('## 自傳');
    expect(out.markdown).toContain('## 證照');
    expect(out.layout).toEqual({ template: 'campus', photo: true });
    expect(composeBuilderResume({ ...TW_DRAFT, intent: { ...TW_DRAFT.intent, salary: { kind: 'negotiable', amount: '' } } }, 'tw').markdown).toContain('期望待遇：面議');
  });

  it('skips empty sections and entries; invents nothing', () => {
    const bare = BuilderDraftSchema.parse({ docLanguage: 'en', basics: { fullName: 'Kim' }, experience: [{ title: '', organization: '', bullets: [''] }] });
    const out = composeBuilderResume(bare, 'intl');
    expect(out.markdown).toBe('# Kim\n');
    expect(out.name).toBe('Kim');
  });

  it('keeps markdown structure safe from user text', () => {
    expect(inline('## not a heading\nsecond line')).toBe('not a heading second line');
    expect(inline('- **bold** item')).toBe('bold item');
    expect(inline('first_last@example.test')).toBe('first_last@example.test');
  });

  it('the server reader sees the cn sections it grades (实习, 自我评价, education, skills)', () => {
    const parsed = parseResume(composeBuilderResume(CN_DRAFT, 'cn').markdown);
    expect(parsed.sections.find((s) => s.internship)).toBeTruthy();
    expect(parsed.sections.find((s) => s.selfEvaluation)).toBeTruthy();
    expect(parsed.sections.map((s) => s.key)).toEqual(expect.arrayContaining(['education', 'projects', 'skills']));
  });
});

describe('builder prompts never carry personal details', () => {
  const SENSITIVE_NOTES = [
    '籍贯：浙江绍兴',
    '政治面貌：共青团员',
    '性别：女',
    '出生年月：2003.05',
    '家庭成员：父亲 教师',
    '身份证：110101200001011234',
    'Gender: female',
    'Date of birth: 2003-05-01',
    'Family members: two brothers',
    '![photo](data:image/png;base64,AAAA)',
    '中共党员',
  ];
  const leaks = (text: string) =>
    ['浙江绍兴', '共青团员', '性别', '出生', '家庭成员', '110101200001011234', 'female', '2003-05-01', 'brothers', 'data:image', '中共党员'].filter((v) => text.includes(v));

  it('drops sensitive lines from notes and context, keeps the work', () => {
    const body = BuilderSuggestBodySchema.parse({
      kind: 'bullets',
      docLanguage: 'zh',
      targetTitle: '数据分析实习生',
      entry: { title: '数据分析实习生', organization: '示例科技', section: 'internship' },
      notes: ['整理销售数据并制作周报', ...SENSITIVE_NOTES].join('\n'),
      context: SENSITIVE_NOTES,
    });
    const prompt = formatBuilderPrompt(builderPromptInput(body));
    expect(prompt).toContain('整理销售数据并制作周报');
    expect(leaks(prompt)).toEqual([]);
    expect(leaks(builderSystemPrompt('bullets', 'zh'))).toEqual([]);
  });

  it('masks emails and phone numbers', () => {
    const out = sanitizePromptText('Reach me at li.test@example.test or 13800000000 about the dashboards.');
    expect(out).not.toContain('li.test@example.test');
    expect(out).not.toContain('13800000000');
    expect(out).toContain('dashboards');
  });

  it('context lines from a draft never include the basics, photo or personal details', () => {
    const lines = draftContextLines({ ...CN_DRAFT, awards: [...CN_DRAFT.awards, '籍贯：浙江绍兴'] });
    const joined = lines.join('\n');
    expect(joined).toContain('用 SQL 搭建 3 张日常报表');
    expect(joined).not.toContain('李同学');
    expect(joined).not.toContain('li.test@example.test');
    expect(leaks(joined)).toEqual([]);
    const prompt = formatBuilderPrompt(builderPromptInput(BuilderSuggestBodySchema.parse({ kind: 'self_evaluation', docLanguage: 'zh', context: lines })));
    expect(leaks(prompt)).toEqual([]);
    expect(prompt).not.toContain('李同学');
  });

  it('the request schema has no field for personal details', () => {
    expect(BuilderSuggestBodySchema.safeParse({ kind: 'bullets', docLanguage: 'zh', notes: 'x', personal: { nativePlace: '浙江' } }).success).toBe(false);
    expect(BuilderSuggestBodySchema.safeParse({ kind: 'bullets', docLanguage: 'zh', notes: 'x', photo: 'data:' }).success).toBe(false);
  });
});

describe('parseBuilderOutput', () => {
  it('reads {"suggestions": […]}, a bare array, fenced JSON, and drops junk', () => {
    expect(parseBuilderOutput('{"suggestions":["Built dashboards","- Cut steps"]}')).toEqual(['Built dashboards', 'Cut steps']);
    expect(parseBuilderOutput('```json\n["a","b"]\n```')).toEqual(['a', 'b']);
    expect(parseBuilderOutput('Sure! {"suggestions":[{"text":"x"}]}')).toEqual(['x']);
    expect(parseBuilderOutput('nothing here')).toEqual([]);
  });
});
