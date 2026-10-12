// server/src/features/resume/builder/fixtures.ts — builder drafts for tests (WP-65).
// Every value is made up for tests; the sensitive ones are there to prove they
// never reach the resume text or a prompt.

import { BuilderDraftSchema, type BuilderDraft } from '../contract.js';

/** Sensitive values that must never appear in markdown or prompts. */
export const SENSITIVE = {
  nativePlace: '浙江绍兴',
  politicalStatus: '共青团员',
};

export const CN_DRAFT: BuilderDraft = BuilderDraftSchema.parse({
  docLanguage: 'zh',
  basics: { fullName: '李同学', email: 'li.test@example.test', phone: '13800000000', city: '上海' },
  intent: { targetTitle: '数据分析实习生', cities: '上海、杭州', salary: { kind: 'negotiable' }, availableFrom: '一周内' },
  education: [{ school: '示例大学', degree: '本科', major: '统计学', start: '2022.09', end: '2026.06', gpa: '3.6/4.0', details: ['主修课程：概率论、回归分析'] }],
  internship: [{ title: '数据分析实习生', organization: '示例科技', start: '2025.07', end: '2025.09', bullets: ['整理销售数据并制作周报', '用 SQL 搭建 3 张日常报表'] }],
  projects: [
    {
      name: '校园二手平台分析',
      role: '负责人',
      star: { situation: '平台交易量下降', task: '找出下降原因', action: '分析 2 万条交易记录', result: '提出 3 条改进建议并被采纳' },
    },
  ],
  campus: [{ title: '学习部部长', organization: '学生会', start: '2023.09', end: '2024.06', bullets: ['组织 5 场讲座'] }],
  skills: ['Python', 'SQL', 'Excel'],
  certificates: ['CET-6（560）', '计算机二级'],
  awards: ['校级一等奖学金（2024）'],
  selfEvaluation: '做事认真，喜欢用数据解决问题。',
  personal: { nativePlace: SENSITIVE.nativePlace, politicalStatus: SENSITIVE.politicalStatus },
  photo: true,
});

export const INTL_DRAFT: BuilderDraft = BuilderDraftSchema.parse({
  docLanguage: 'en',
  basics: { fullName: 'Sam Rivera', email: 'sam@example.test', phone: '+1 415 555 0100', city: 'Austin, TX', links: ['github.com/samr'] },
  intent: { targetTitle: 'Junior Data Analyst' },
  education: [{ school: 'State University', degree: 'BS', major: 'Economics', start: '2020', end: '2024' }],
  experience: [{ title: 'Analyst Intern', organization: 'Acme Co', location: 'Austin, TX', start: 'Jun 2023', end: 'Aug 2023', bullets: ['Built weekly sales dashboards in Excel'] }],
  skills: ['SQL', 'Excel', 'Tableau'],
  summary: 'Economics graduate who likes clean data and clear charts.',
});

export const TW_DRAFT: BuilderDraft = BuilderDraftSchema.parse({
  docLanguage: 'zh-TW',
  basics: { fullName: '陳小華', email: 'hua@example.test', phone: '0912000000', city: '臺北市' },
  intent: { targetTitle: '行銷專員', salary: { kind: 'company_policy' } },
  education: [{ school: '示範大學', degree: '學士', major: '企業管理', start: '2020', end: '2024' }],
  experience: [{ title: '行銷助理', organization: '範例公司', start: '2024.07', end: '至今', bullets: ['規劃社群貼文'] }],
  certificates: ['TOEIC 850'],
  autobiography: '我在臺北長大，大學期間參與多項行銷活動。',
  photo: true,
});
