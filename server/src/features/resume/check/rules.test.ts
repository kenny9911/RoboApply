// @vitest-environment node
//
// WP-22 acceptance: the issue taxonomy table (F-RES-04), the rubric, the
// CitationGuard helpers and the prompt hygiene of the resume check.

import { describe, expect, it } from 'vitest';
import { ISSUE_TYPES, type GradeIssue, type GradeProfile, type IssueType } from '../contract.js';
import { aiIssues, parseAiPassOutput } from './aiPass.js';
import { hasInventedNumber, inventedNumbers, quotedIn } from './citationGuard.js';
import { parseResume, resumeForLlm, textUnits } from './resumeText.js';
import { runRules } from './rules.js';
import { countBySeverity, gradeIssues, labelFor, scoreIssues } from './score.js';
import { ISSUE_DEFINITIONS, TEMPLATE_RULES, rulesCountFor } from './taxonomy.js';
import { GOOD_INTL } from './fixtures.js';

const NOW = new Date('2026-10-10T12:00:00Z');



const WEAK_INTL = [
  '## Experience',
  '',
  '### Shop · Assistant · 2022 – 2024',
  '- Responsible for opening the store every morning and handling the till.',
  '- Helped with inventory and stock rotation on the weekends.',
  '- Worked on the new display layout with the manager.',
  '- Team player and hard-working colleague who is always detail-oriented in everything that happens on the shop floor during every busy weekend shift of the year, including holidays, stocktakes and the long summer sale season when the queue reaches the door and every till is open until late in the evening 🙂',
  '',
  '| Skill | Level |',
  '|---|---|',
  '| Excel | Good |',
  '',
  '![me](photo.png)',
].join('\n');

const CN_STUDENT = [
  '# 张三',
  '电话：13800138000 · 邮箱：zhangsan@example.test',
  '籍贯：浙江杭州 · 政治面貌：共青团员',
  '',
  '## 教育背景',
  '### 浙江大学 · 计算机科学与技术 本科 · 2023 – 2027',
  '',
  '## 项目经历',
  '### 校园二手交易平台 · 后端开发',
  '- 参与了后端接口的开发和测试。',
  '- 负责数据库设计，支持 3000 名同学使用。',
  '- 协助完成上线部署。',
  '',
  '## 专业技能',
  'Java、Python、MySQL、Redis、Linux',
].join('\n');

function types(issues: GradeIssue[]): IssueType[] {
  return issues.map((i) => i.type as IssueType);
}

function rules(md: string, profile: GradeProfile = 'intl', template?: string) {
  return runRules({ markdown: md, profile, template, now: NOW });
}

describe('issue taxonomy table', () => {
  it('defines every contract type, with copy that avoids banned vocabulary', () => {
    for (const t of ISSUE_TYPES) {
      const d = ISSUE_DEFINITIONS[t];
      expect(d.type).toBe(t);
      expect(d.why.length).toBeGreaterThan(10);
      expect(d.how.length).toBeGreaterThan(5);
      expect(`${d.why} ${d.how}`).not.toMatch(/\bATS\b|applicant tracking|chance|guarantee/i);
    }
    expect(Object.keys(ISSUE_DEFINITIONS).sort()).toEqual([...ISSUE_TYPES].sort());
  });

  it('labels every layout risk "Company software may not read this"', () => {
    for (const t of ['layout_table', 'layout_columns', 'layout_image', 'layout_symbols'] as const) {
      expect(ISSUE_DEFINITIONS[t].why).toMatch(/^Company software may not read this\./);
    }
  });

  it('finds nothing urgent in a strong resume', () => {
    const issues = rules(GOOD_INTL);
    expect(countBySeverity(issues).urgent).toBe(0);
    expect(types(issues)).not.toContain('weak_verb');
    expect(types(issues)).not.toContain('no_numbers');
    expect(gradeIssues(issues).label).toBe('excellent');
  });

  const intlCases: Array<[IssueType, string, string | undefined]> = [
    ['layout_table', WEAK_INTL, undefined],
    ['layout_image', WEAK_INTL, undefined],
    ['layout_symbols', WEAK_INTL, undefined],
    ['layout_columns', GOOD_INTL, 'two-column'],
    ['contact_name_missing', WEAK_INTL, undefined],
    ['contact_email_missing', WEAK_INTL, undefined],
    ['contact_phone_missing', WEAK_INTL, undefined],
    ['section_education_missing', WEAK_INTL, undefined],
    ['section_skills_missing', WEAK_INTL, undefined],
    ['summary_missing', WEAK_INTL, undefined],
    ['weak_verb', WEAK_INTL, undefined],
    ['no_numbers', WEAK_INTL, undefined],
    ['bullet_too_long', WEAK_INTL, undefined],
    ['buzzwords', WEAK_INTL, undefined],
  ];
  it.each(intlCases)('intl: %s fires', (type, md, template) => {
    expect(types(rules(md, 'intl', template))).toContain(type);
  });

  it('missing experience, too few skills, short and long summaries, length', () => {
    const noExp = '# A\n*a@example.test · +1 415 555 0100*\n## Summary\nShort.\n## Skills\nExcel, Word';
    const t = types(rules(noExp));
    expect(t).toContain('section_experience_missing');
    expect(t).toContain('skills_too_few');
    expect(t).toContain('summary_too_short');
    const longSummary = GOOD_INTL.replace(/Backend engineer[^\n]+/, Array.from({ length: 100 }, (_, i) => `word${i}`).join(' '));
    expect(types(rules(longSummary))).toContain('summary_too_long');
    const longResume = `${GOOD_INTL}\n## Projects\n${Array.from({ length: 120 }, (_, i) => `- Built project ${i} with a small team and shipped it to customers on time`).join('\n')}`;
    expect(types(rules(longResume))).toContain('length_too_long');
  });

  it('weak openers carry the bullet as the fix target; missing-contact issues are not fixable', () => {
    const issues = rules(WEAK_INTL);
    const weak = issues.filter((i) => i.type === 'weak_verb');
    expect(weak.length).toBe(3);
    expect(weak[0]!.target).toMatch(/^Responsible for opening/);
    expect(weak[0]!.fixable).toBe(true);
    expect(weak[0]!.params).toEqual({ opener: 'responsible for' });
    expect(issues.find((i) => i.type === 'contact_email_missing')!.fixable).toBe(false);
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length);
  });

  it('cn profile: 自我评价, 实习, CET, 籍贯 and photo notes, Chinese weak openers', () => {
    const issues = rules(CN_STUDENT, 'cn');
    const t = types(issues);
    expect(t).toContain('cn_self_evaluation_missing');
    expect(t).toContain('cn_internship_missing');
    expect(t).toContain('cn_english_cert_missing');
    expect(t).toContain('cn_personal_details_optional');
    expect(t).not.toContain('summary_missing'); // intl-only
    expect(issues.filter((i) => i.type === 'weak_verb').map((i) => i.params?.opener)).toEqual(['参与了', '协助']);
    for (const i of issues.filter((x) => x.type.startsWith('cn_'))) expect(i.severity === 'optional' || i.type === 'cn_internship_missing').toBe(true);

    const withPhoto = `${CN_STUDENT}\n![照片](p.png)`;
    expect(types(rules(withPhoto, 'cn'))).toContain('cn_photo_optional');
    expect(types(rules(withPhoto, 'cn'))).not.toContain('layout_image');

    const complete = `${CN_STUDENT.replace('籍贯：浙江杭州 · 政治面貌：共青团员', '')}\n## 实习经历\n### 某公司 · 后端实习生 · 2026.06 – 2026.09\n- 完成 5 个接口。\n## 技能证书\nCET-6\n## 自我评价\n热爱后端开发，做过 2 个上线项目，习惯写测试。`;
    const ct = types(rules(complete, 'cn'));
    expect(ct).not.toContain('cn_internship_missing');
    expect(ct).not.toContain('cn_english_cert_missing');
    expect(ct).not.toContain('cn_self_evaluation_missing');
    expect(ct).not.toContain('cn_personal_details_optional');
  });

  it('cn: a graduate (no student marker, old graduation year) is not asked for internships', () => {
    const grad = CN_STUDENT.replace('2023 – 2027', '2012 – 2016');
    expect(types(rules(grad, 'cn'))).not.toContain('cn_internship_missing');
  });

  it('cn: 1–2 pages measured in characters', () => {
    const long = `${CN_STUDENT}\n## 工作经历\n${Array.from({ length: 100 }, () => '- 负责公司核心交易系统的设计、开发与维护工作，保障系统稳定运行').join('\n')}`;
    expect(types(rules(long, 'cn'))).toContain('length_too_long');
  });

  it('counts rules per profile, with and without the AI pass', () => {
    expect(rulesCountFor('intl', true)).toBeGreaterThan(rulesCountFor('intl', false));
    expect(rulesCountFor('cn', false)).toBeGreaterThan(rulesCountFor('intl', false) - 2);
  });

  it('layout_columns: fires on the editor template keys and is counted now that layouts are saved (layout.template)', () => {
    for (const key of ['two-column', 'two_column', 'split']) expect(types(rules(GOOD_INTL, 'intl', key))).toContain('layout_columns');
    for (const key of ['ats-clean', 'modern', 'compact']) expect(types(rules(GOOD_INTL, 'intl', key))).not.toContain('layout_columns');
    for (const profile of ['intl', 'cn'] as const) {
      const all = Object.values(ISSUE_DEFINITIONS).filter((d) => d.profiles.includes(profile) && d.source === 'rules').length;
      expect(rulesCountFor(profile, false)).toBe(all);
      // Text with no template (the signed-out free tool) cannot be judged on it.
      expect(rulesCountFor(profile, false, { template: false })).toBe(all - TEMPLATE_RULES.length);
    }
    expect(TEMPLATE_RULES).toEqual(['layout_columns']);
  });
});

describe('rubric', () => {
  const issue = (type: IssueType, severity: GradeIssue['severity']): GradeIssue => ({ id: type, type, severity, section: 'other', anchor: null, why: '', how: '' });

  it('scores 100 with no issues and caps repeated types', () => {
    expect(scoreIssues([])).toBe(100);
    const many = Array.from({ length: 10 }, () => issue('weak_verb', 'critical'));
    expect(scoreIssues(many)).toBe(100 - 16);
  });

  it('labels by floor and caps at Fair when anything is "Fix first"', () => {
    expect(labelFor(90, { urgent: 0, critical: 0, optional: 0 })).toBe('excellent');
    expect(labelFor(72, { urgent: 0, critical: 1, optional: 0 })).toBe('good');
    expect(labelFor(55, { urgent: 0, critical: 3, optional: 0 })).toBe('fair');
    expect(labelFor(20, { urgent: 0, critical: 3, optional: 0 })).toBe('needs_work');
    expect(labelFor(85, { urgent: 1, critical: 0, optional: 0 })).toBe('fair');
  });
});

describe('CitationGuard', () => {
  it('flags numbers not in the source and accepts placeholders and kept numbers', () => {
    expect(hasInventedNumber('Cut costs by 30%', ['Cut costs'])).toBe(true);
    expect(inventedNumbers('Cut costs by 30% for 2,000 users', ['Reduced costs 30% for 2000 users'])).toEqual([]);
    expect(hasInventedNumber('Cut costs by [X]%', ['Cut costs'])).toBe(false);
    expect(hasInventedNumber('改善了３０％', ['改善了30%'])).toBe(false);
    expect(hasInventedNumber('Joined in 2019', ['Joined the team'])).toBe(true);
  });

  it('counts Chinese numerals as numbers (GoApply resumes)', () => {
    expect(inventedNumbers('带领五人团队', ['负责团队管理'])).toEqual(['五']);
    expect(hasInventedNumber('效率提升三成', ['效率提升'])).toBe(true);
    expect(hasInventedNumber('产能提升两倍', ['产能提升'])).toBe(true);
    expect(hasInventedNumber('百分之三十的增长', ['带来增长'])).toBe(true);
    expect(hasInventedNumber('用户数翻倍', ['用户数增长'])).toBe(true);
    // The same number written another way is not invented.
    expect(hasInventedNumber('带领五人团队', ['带领5人团队'])).toBe(false);
    expect(hasInventedNumber('效率提升三成', ['效率提升30%'])).toBe(false);
    expect(hasInventedNumber('服务5万用户', ['服务50,000名用户'])).toBe(false);
    expect(hasInventedNumber('2021年9月加入', ['2021.09-2022.06 某公司'])).toBe(false);
    // Words that only look numeric are left alone.
    expect(hasInventedNumber('进一步提升了一个项目的质量', ['负责项目'])).toBe(false);
    expect(hasInventedNumber('对接第三方支付，十分熟悉百度业务', ['对接支付'])).toBe(false);
  });

  it('counts English number words and multipliers as numbers', () => {
    expect(inventedNumbers('Led five engineers', ['Led engineers'])).toEqual(['five']);
    expect(hasInventedNumber('Doubled revenue', ['Grew revenue'])).toBe(true);
    expect(hasInventedNumber('Served two hundred clients', ['Served clients'])).toBe(true);
    expect(hasInventedNumber('Led five engineers', ['Led 5 engineers'])).toBe(false);
    expect(hasInventedNumber('twenty-five clients', ['25 clients'])).toBe(false);
    expect(hasInventedNumber('Doubled revenue', ['Grew revenue 2x'])).toBe(false);
    expect(hasInventedNumber('One of the first one-on-one programs', ['programs'])).toBe(false);
  });

  it('checks quotes verbatim (whitespace-normalized)', () => {
    expect(quotedIn('recieve', 'I recieve  mail')).toBe(true);
    expect(quotedIn('receive', 'I recieve mail')).toBe(false);
  });
});

describe('prompt hygiene', () => {
  it('drops the contact block and sensitive lines and masks stray contacts', () => {
    const text = resumeForLlm(`${CN_STUDENT}\n## 其他\n出生年月：2004.01\n联系我：zhangsan@example.test 13800138000`);
    expect(text).not.toMatch(/张三|籍贯|政治面貌|出生|zhangsan@|13800138000/);
    expect(text).toContain('[email]');
    expect(text).toContain('浙江大学');
  });

  it('keeps Chinese date ranges and never masks them as phone numbers', () => {
    const text = resumeForLlm(
      '# 张三\n## 实习经历\n### 某公司 · 运营实习 · 2021.09-2022.06\n- 负责 2019.09 - 2023.06 期间的数据整理\n- 2020年9月-2021年6月 担任学生会主席\n- 客服电话 021-12345678',
    );
    expect(text).toContain('2021.09-2022.06');
    expect(text).toContain('2019.09 - 2023.06');
    expect(text).toContain('2020年9月-2021年6月');
    expect(text).toContain('[phone]');
    expect(text).not.toContain('021-12345678');
  });

  it('drops a 个人信息 section and name / address label lines', () => {
    const text = resumeForLlm(
      '# 张三\n## 个人信息\n姓名：张三\n现居：上海市浦东新区\n求职意向：运营\n## 教育经历\n- 浙江大学 2019-2023\n住址：杭州市西湖区\n## Experience\n- Addressed customer issues\nAddress: 1 Main St',
    );
    expect(text).not.toMatch(/张三|上海市|杭州市|求职意向|1 Main St|个人信息/);
    expect(text).toContain('浙江大学 2019-2023');
    expect(text).toContain('Addressed customer issues');
  });

  it('keeps a plain-text resume without headings (minus the name line)', () => {
    expect(resumeForLlm('Ada Lovelace\nBuilt engines.\nGender: F')).toBe('Built engines.');
  });

  it('parses sections, entries and bullets', () => {
    const r = parseResume(GOOD_INTL);
    expect(r.name).toBe('Ada Lovelace');
    expect(r.sections.map((s) => s.key)).toEqual(['summary', 'experience', 'education', 'skills']);
    expect(r.bullets).toHaveLength(4);
    expect(textUnits('三个字 and two')).toBe(5);
  });
});

describe('AI pass output', () => {
  it('parses tolerant JSON and drops words the resume does not contain', () => {
    const out = parseAiPassOutput('```json\n{"spelling":[{"word":"recieve","suggestion":"receive"},{"word":"invented","suggestion":"x"},{"word":"same","suggestion":"same"}],"summaryVague":true}\n```');
    expect(out.spelling).toHaveLength(2);
    const md = '# A\n## Summary\nI recieve feedback well.\n## Experience\n- Did things.';
    const issues = aiIssues(out, md);
    expect(issues.map((i) => i.type)).toEqual(['spelling', 'summary_vague']);
    expect(issues[0]!.params).toEqual({ word: 'recieve', suggestion: 'receive' });
    expect(issues[1]!.target).toBe('I recieve feedback well.');
    expect(issues.every((i) => i.source === 'ai')).toBe(true);
  });

  it('returns nothing for garbage', () => {
    expect(parseAiPassOutput('not json')).toEqual({ spelling: [], summaryVague: false });
  });
});
