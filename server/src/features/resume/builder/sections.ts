// server/src/features/resume/builder/sections.ts
//
// The guided builder's section sets per brand and locale (WP-65; PRODUCT_PLAN.md
// F-RES-17, F-RES-12 cn section set, CN_TW_LAUNCH_PLAN.md TW-04). Pure.
//
//   intl  RoboApply: role → contact → education → experience (bullet prompts)
//         → skills → summary.
//   tw    RoboApply in Traditional Chinese: + 實習, 專案, 證照, 自傳, 期望待遇
//         "依公司規定 / 面議", an optional photo (off for an English resume).
//   cn    GoApply 应届: 基本信息, 求职意向, 教育, 实习, 项目 (STAR), 校园经历,
//         技能证书 (CET-4/6), 获奖, 自我评价, then optional photo / 籍贯 / 政治面貌.
//
// Section titles here are DOCUMENT text (what the user's resume says), not app
// copy, so they live with the composer rather than in an i18n bundle.

import type {
  BuilderConfigView,
  BuilderDocLanguage,
  BuilderSection,
  BuilderStepView,
  BuilderVariant,
  SalaryKind,
} from '../contract.js';

/** Which builder a request gets: GoApply → cn; RoboApply in zh-TW → tw; else intl. */
export function builderVariantFor(input: { market?: string | null; locale?: string | null }): BuilderVariant {
  if (input.market === 'cn') return 'cn';
  const l = (input.locale ?? '').toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'tw';
  return 'intl';
}

/** Document languages the builder can write for each variant (zh/en bilingual on cn). */
export const DOC_LANGUAGES: Record<BuilderVariant, BuilderDocLanguage[]> = {
  intl: ['en'],
  tw: ['zh-TW', 'en'],
  cn: ['zh', 'en'],
};

const step = (key: BuilderSection, optional = true, ai: BuilderStepView['ai'] = null): BuilderStepView => ({ key, optional, ai });

/** Builder steps in the order the user meets them. */
export const BUILDER_STEPS: Record<BuilderVariant, BuilderStepView[]> = {
  intl: [
    step('intent', false),
    step('basics', false),
    step('education'),
    step('experience', true, 'bullets'),
    step('projects', true, 'bullets'),
    step('skills'),
    step('summary', true, 'summary'),
  ],
  tw: [
    step('basics', false),
    step('intent', false),
    step('education'),
    step('experience', true, 'bullets'),
    step('internship', true, 'bullets'),
    step('projects', true, 'bullets'),
    step('skills'),
    step('certificates'),
    step('autobiography'),
    step('personal'),
  ],
  cn: [
    step('basics', false),
    step('intent', false),
    step('education'),
    step('internship', true, 'bullets'),
    step('projects', true, 'bullets'),
    step('campus', true, 'bullets'),
    step('certificates'),
    step('awards'),
    step('selfEvaluation', true, 'self_evaluation'),
    step('personal'),
  ],
};

/**
 * Order of the sections in the finished document. `basics` is the header and
 * `personal` is placed by the renderer, so neither is a `##` section.
 */
export const DOCUMENT_ORDER: Record<BuilderVariant, BuilderSection[]> = {
  intl: ['summary', 'experience', 'projects', 'education', 'skills'],
  tw: ['intent', 'education', 'experience', 'internship', 'projects', 'skills', 'certificates', 'autobiography'],
  cn: ['intent', 'education', 'internship', 'projects', 'campus', 'certificates', 'awards', 'selfEvaluation'],
};

/** Document section titles by language. */
export const SECTION_HEADINGS: Record<BuilderDocLanguage, Partial<Record<BuilderSection, string>>> = {
  en: {
    intent: 'Job objective',
    summary: 'Summary',
    education: 'Education',
    experience: 'Experience',
    internship: 'Internships',
    projects: 'Projects',
    campus: 'Campus activities',
    skills: 'Skills',
    certificates: 'Certificates',
    awards: 'Awards',
    selfEvaluation: 'About me',
    autobiography: 'Autobiography',
  },
  zh: {
    intent: '求职意向',
    summary: '个人总结',
    education: '教育背景',
    experience: '工作经历',
    internship: '实习经历',
    projects: '项目经历',
    campus: '校园经历',
    skills: '专业技能',
    certificates: '技能证书',
    awards: '获奖情况',
    selfEvaluation: '自我评价',
    autobiography: '个人陈述',
  },
  'zh-TW': {
    intent: '求職條件',
    summary: '個人摘要',
    education: '學歷',
    experience: '工作經歷',
    internship: '實習經歷',
    projects: '專案經歷',
    campus: '社團經歷',
    skills: '專長',
    certificates: '證照',
    awards: '獲獎紀錄',
    selfEvaluation: '自我評價',
    autobiography: '自傳',
  },
};

/** The cn builder writes skills and certificates as one 技能证书 section. */
export function headingFor(section: BuilderSection, lang: BuilderDocLanguage, variant: BuilderVariant): string {
  if (variant === 'cn' && section === 'certificates') return lang === 'en' ? 'Skills & certificates' : '技能证书';
  return SECTION_HEADINGS[lang][section] ?? SECTION_HEADINGS.en[section] ?? section;
}

/** Labels inside the intent section and the personal-details line (document text). */
export const FIELD_LABELS: Record<BuilderDocLanguage, Record<'targetTitle' | 'cities' | 'salary' | 'availableFrom' | 'nativePlace' | 'politicalStatus' | 'gpa' | 'role', string>> = {
  en: {
    targetTitle: 'Position',
    cities: 'Location',
    salary: 'Expected pay',
    availableFrom: 'Available from',
    nativePlace: 'Native place',
    politicalStatus: 'Political status',
    gpa: 'GPA',
    role: 'Role',
  },
  zh: {
    targetTitle: '期望职位',
    cities: '期望城市',
    salary: '期望薪资',
    availableFrom: '到岗时间',
    nativePlace: '籍贯',
    politicalStatus: '政治面貌',
    gpa: '成绩',
    role: '角色',
  },
  'zh-TW': {
    targetTitle: '希望職稱',
    cities: '希望地點',
    salary: '期望待遇',
    availableFrom: '可上班日',
    nativePlace: '籍貫',
    politicalStatus: '政治面貌',
    gpa: '成績',
    role: '角色',
  },
};

/** Salary words written into the document when the user picks them. */
export const SALARY_WORDS: Record<BuilderDocLanguage, Record<Exclude<SalaryKind, 'none' | 'amount'>, string>> = {
  en: { company_policy: 'Per company policy', negotiable: 'Negotiable' },
  zh: { company_policy: '按公司规定', negotiable: '面议' },
  'zh-TW': { company_policy: '依公司規定', negotiable: '面議' },
};

/** Certificate names the cn builder offers as one-tap adds (the user adds any score). */
export const CN_CERTIFICATE_SUGGESTIONS = ['CET-4', 'CET-6', 'TEM-4', 'TEM-8', '计算机二级', '普通话二级甲等'];

const SALARY_KINDS_FOR: Record<BuilderVariant, SalaryKind[]> = {
  intl: [],
  tw: ['company_policy', 'negotiable', 'amount'],
  cn: ['negotiable', 'amount'],
};

/** The builder config for one request (pure; the service adds `aiAvailable`). */
export function builderConfigFor(input: { market?: string | null; locale?: string | null; page: 'letter' | 'a4'; aiAvailable: boolean }): BuilderConfigView {
  const variant = builderVariantFor(input);
  const docLanguages = DOC_LANGUAGES[variant];
  const headings = Object.fromEntries(
    (['en', 'zh', 'zh-TW'] as BuilderDocLanguage[]).map((lang) => [
      lang,
      Object.fromEntries(DOCUMENT_ORDER[variant].map((s) => [s, headingFor(s, lang, variant)])),
    ]),
  ) as BuilderConfigView['headings'];
  const steps = BUILDER_STEPS[variant].map((s) => ({ ...s, ai: input.aiAvailable ? s.ai : null }));
  return {
    variant,
    docLanguages,
    defaultDocLanguage: docLanguages[0]!,
    steps,
    headings,
    aiAvailable: input.aiAvailable,
    page: variant === 'cn' ? 'a4' : input.page,
    maxPages: variant === 'cn' ? 2 : 1,
    template: variant === 'intl' ? 'standard' : 'campus',
    // Photo: offered on cn and tw; on tw it defaults on for a Chinese resume
    // and off for an English one (foreign firms usually don't expect one).
    // GoApply keeps it off by default (it is sensitive personal information).
    photo: {
      offered: variant !== 'intl',
      defaultOn: { en: false, zh: false, 'zh-TW': variant === 'tw' },
    },
    personalFields: variant === 'cn' ? ['nativePlace', 'politicalStatus'] : [],
    salaryKinds: SALARY_KINDS_FOR[variant],
    certificateSuggestions: variant === 'cn' ? [...CN_CERTIFICATE_SUGGESTIONS] : [],
  };
}
