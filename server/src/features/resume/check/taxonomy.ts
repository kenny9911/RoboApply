// server/src/features/resume/check/taxonomy.ts
//
// The issue taxonomy (PRODUCT_PLAN.md F-RES-04; TASK_PLAN.md WP-22). One row
// per issue type: severity, section, whether an AI version can rewrite it,
// the profiles it applies to, and the English fallback `why` / `how` stored
// on the grade row (the web renders `resumeCheck.issue.<type>.*` instead).
//
// Copy rules: plain language, no "ATS"; layout risks say "Company software
// may not read this"; cn notes about photo / 籍贯 are optional notes, never
// requirements.

import type { GradeProfile, IssueSeverity, IssueType, ResumeSectionKey } from '../contract.js';

export interface IssueDefinition {
  type: IssueType;
  severity: IssueSeverity;
  section: ResumeSectionKey;
  /** Profiles the rule runs in. */
  profiles: readonly GradeProfile[];
  /** An AI version can rewrite the issue's target text. */
  fixable: boolean;
  /** 'ai' = found by the AI pass only. */
  source: 'rules' | 'ai';
  why: string;
  how: string;
}

const BOTH = ['intl', 'cn'] as const;
const CN = ['cn'] as const;
const LAYOUT_WHY = 'Company software may not read this.';

export const ISSUE_DEFINITIONS: Record<IssueType, IssueDefinition> = {
  layout_table: {
    type: 'layout_table', severity: 'critical', section: 'layout', profiles: BOTH, fixable: false, source: 'rules',
    why: `${LAYOUT_WHY} Tables often come out scrambled when hiring software reads a resume.`,
    how: 'Turn the table into plain lines or bullets.',
  },
  layout_columns: {
    type: 'layout_columns', severity: 'critical', section: 'layout', profiles: BOTH, fixable: false, source: 'rules',
    why: `${LAYOUT_WHY} Two-column layouts can be read across both columns, mixing lines together.`,
    how: 'Use a single-column template.',
  },
  layout_image: {
    type: 'layout_image', severity: 'critical', section: 'layout', profiles: ['intl'], fixable: false, source: 'rules',
    why: `${LAYOUT_WHY} Text inside images, icons or charts cannot be read.`,
    how: 'Remove images and write the information as text.',
  },
  layout_symbols: {
    type: 'layout_symbols', severity: 'optional', section: 'layout', profiles: BOTH, fixable: false, source: 'rules',
    why: `${LAYOUT_WHY} Emoji and decorative symbols can turn into odd characters.`,
    how: 'Replace symbols with plain words, for example "Email:" instead of an icon.',
  },
  contact_name_missing: {
    type: 'contact_name_missing', severity: 'urgent', section: 'contact', profiles: BOTH, fixable: false, source: 'rules',
    why: 'Without a name at the top, nobody knows whose resume this is.',
    how: 'Put your full name on the first line.',
  },
  contact_email_missing: {
    type: 'contact_email_missing', severity: 'urgent', section: 'contact', profiles: BOTH, fixable: false, source: 'rules',
    why: 'Employers need a way to reply to you.',
    how: 'Add an email address you check every day.',
  },
  contact_phone_missing: {
    type: 'contact_phone_missing', severity: 'critical', section: 'contact', profiles: BOTH, fixable: false, source: 'rules',
    why: 'Many employers call to set up the first conversation.',
    how: 'Add a phone number.',
  },
  section_experience_missing: {
    type: 'section_experience_missing', severity: 'urgent', section: 'experience', profiles: BOTH, fixable: false, source: 'rules',
    why: 'Experience is the first thing most readers look for.',
    how: 'Add an Experience section with your jobs, internships or substantial projects.',
  },
  section_education_missing: {
    type: 'section_education_missing', severity: 'critical', section: 'education', profiles: BOTH, fixable: false, source: 'rules',
    why: 'Many postings list an education requirement, and readers check for it.',
    how: 'Add an Education section with school, degree and dates.',
  },
  section_skills_missing: {
    type: 'section_skills_missing', severity: 'critical', section: 'skills', profiles: BOTH, fixable: false, source: 'rules',
    why: 'A skills list is where readers and software look for the tools a job asks for.',
    how: 'Add a Skills section with the tools and methods you actually use.',
  },
  summary_missing: {
    type: 'summary_missing', severity: 'optional', section: 'summary', profiles: ['intl'], fixable: false, source: 'rules',
    why: 'Two sentences at the top tell the reader what you do before they read the details.',
    how: 'Add a short summary: your role, your strongest area, and what you want next.',
  },
  summary_too_short: {
    type: 'summary_too_short', severity: 'optional', section: 'summary', profiles: BOTH, fixable: true, source: 'rules',
    why: 'A very short summary does not say what makes you a fit.',
    how: 'Write two or three sentences about your role, your strongest area and a result.',
  },
  summary_too_long: {
    type: 'summary_too_long', severity: 'optional', section: 'summary', profiles: BOTH, fixable: true, source: 'rules',
    why: 'Readers skim the top of a resume; a long summary gets skipped.',
    how: 'Cut it to two or three sentences.',
  },
  weak_verb: {
    type: 'weak_verb', severity: 'critical', section: 'experience', profiles: BOTH, fixable: true, source: 'rules',
    why: 'Openers like "responsible for" describe a duty, not what you did.',
    how: 'Start with what you did: built, led, cut, shipped.',
  },
  no_numbers: {
    type: 'no_numbers', severity: 'critical', section: 'experience', profiles: BOTH, fixable: true, source: 'rules',
    why: 'Few of your bullets show a result someone could measure.',
    how: 'Add a real number where you have one: people, time, money, volume or percent. Do not guess.',
  },
  bullet_too_long: {
    type: 'bullet_too_long', severity: 'optional', section: 'experience', profiles: BOTH, fixable: true, source: 'rules',
    why: 'Long bullets are hard to skim.',
    how: 'Keep each bullet to one or two lines: what you did and the result.',
  },
  buzzwords: {
    type: 'buzzwords', severity: 'optional', section: 'summary', profiles: BOTH, fixable: false, source: 'rules',
    why: 'Phrases every resume uses do not tell the reader anything about you.',
    how: 'Replace them with a specific example of the quality you mean.',
  },
  skills_too_few: {
    type: 'skills_too_few', severity: 'critical', section: 'skills', profiles: BOTH, fixable: false, source: 'rules',
    why: 'A short skills list can hide tools a job asks for.',
    how: 'List the tools, languages and methods you use, at least five.',
  },
  length_too_long: {
    type: 'length_too_long', severity: 'critical', section: 'layout', profiles: BOTH, fixable: false, source: 'rules',
    why: 'This resume is likely longer than two pages, and readers rarely get that far.',
    how: 'Keep it to one or two pages: cut older or less relevant bullets.',
  },
  placeholder_unfilled: {
    type: 'placeholder_unfilled', severity: 'urgent', section: 'experience', profiles: BOTH, fixable: false, source: 'rules',
    why: 'This line still has a blank like [X] where your own number goes. A reader would see the brackets.',
    how: 'Put in the real number, or rewrite the line without it. Never guess a figure.',
  },
  spelling: {
    type: 'spelling', severity: 'urgent', section: 'other', profiles: BOTH, fixable: false, source: 'ai',
    why: 'Spelling mistakes are noticed quickly and look careless.',
    how: 'Correct the word shown.',
  },
  summary_vague: {
    type: 'summary_vague', severity: 'optional', section: 'summary', profiles: BOTH, fixable: true, source: 'ai',
    why: 'The summary is general and could describe many people.',
    how: 'Name your role, your strongest area and one real result.',
  },
  cn_self_evaluation_missing: {
    type: 'cn_self_evaluation_missing', severity: 'optional', section: 'summary', profiles: CN, fixable: false, source: 'rules',
    why: 'Many Chinese employers expect a short self-evaluation (自我评价).',
    how: 'Add two or three sentences with concrete strengths, not slogans.',
  },
  cn_internship_missing: {
    type: 'cn_internship_missing', severity: 'critical', section: 'experience', profiles: CN, fixable: false, source: 'rules',
    why: 'For students and new graduates, internships (实习) are the experience employers look for first.',
    how: 'Add an internship section, or list substantial projects or campus work if you have no internship.',
  },
  cn_english_cert_missing: {
    type: 'cn_english_cert_missing', severity: 'optional', section: 'skills', profiles: CN, fixable: false, source: 'rules',
    why: 'Many employers check English level (CET-4/6, IELTS, TOEFL).',
    how: 'If you have an English certificate or score, list it under skills and certificates.',
  },
  cn_personal_details_optional: {
    type: 'cn_personal_details_optional', severity: 'optional', section: 'contact', profiles: CN, fixable: false, source: 'rules',
    why: 'Details like 籍贯, 政治面貌 or birth date are optional on most resumes.',
    how: 'Keep them only if the employer asks for them.',
  },
  cn_photo_optional: {
    type: 'cn_photo_optional', severity: 'optional', section: 'contact', profiles: CN, fixable: false, source: 'rules',
    why: 'A photo is optional. Some employers ask for one; many do not.',
    how: 'Keep a recent, professional photo only if the employer asks for one.',
  },
};

/**
 * Rules that read the resume's saved template (`RAResumeVariant.layout.template`,
 * written by `PATCH /:id/layout`; a resume with none uses the default
 * single-column template). They are part of the checklist of every stored
 * resume. Text checked with no template at all (the signed-out free tool)
 * cannot be judged on them, so that caller leaves them out of its count.
 */
export const TEMPLATE_RULES: readonly IssueType[] = ['layout_columns'];

/**
 * How many rules a profile is graded against (the "checked against N rules"
 * line). `template: false` = the text has no template to check (free tool).
 */
export function rulesCountFor(profile: GradeProfile, withAi: boolean, opts: { template?: boolean } = {}): number {
  const withTemplate = opts.template !== false;
  return Object.values(ISSUE_DEFINITIONS).filter(
    (d) => d.profiles.includes(profile) && (withAi || d.source === 'rules') && (withTemplate || !TEMPLATE_RULES.includes(d.type)),
  ).length;
}
