// server/src/features/resume/check/rules.ts
//
// The deterministic half of the resume check (WP-22): pure rules over the
// resume markdown that produce taxonomy issues (taxonomy.ts). No I/O, no LLM.
// The AI pass (aiPass.ts) adds `spelling` / `summary_vague` when AI is
// allowed; everything here runs for every user, including GoApply users
// without the AI consent.

import type { GradeIssue, GradeProfile, IssueType } from '../contract.js';
import { ISSUE_DEFINITIONS } from './taxonomy.js';
import { findPlaceholders } from './placeholders.js';
import {
  isCjkText,
  parseResume,
  sectionsOf,
  summaryTarget,
  summaryText,
  textUnits,
  type ParsedResume,
} from './resumeText.js';

export interface RuleInput {
  markdown: string;
  profile: GradeProfile;
  /** `RAResumeVariant.layout.template`, when known. */
  template?: string | null;
  /** Clock for the student check (graduation year). */
  now?: Date;
}

/** Per-type cap on how many instances are listed (the rest are counted in params). */
export const MAX_INSTANCES = 5;

export const LIMITS = {
  summaryMinUnits: 12,
  summaryMaxUnits: { intl: 90, cn: 220 },
  bulletMaxUnits: { latin: 40, cjk: 90 },
  minSkills: 5,
  /** ≈ two pages of text. */
  maxUnits: { intl: 1000, cn: 2400 },
  /** Share of bullets that carry a number below which `no_numbers` fires. */
  minNumberShare: 0.3,
  minBulletsForNumbers: 3,
} as const;

const WEAK_OPENERS_EN = [
  'responsible for',
  'helped with',
  'helped to',
  'helped',
  'assisted with',
  'assisted in',
  'assisted',
  'worked on',
  'involved in',
  'participated in',
  'duties included',
  'tasked with',
];
const WEAK_OPENERS_CN = ['参与了', '参与', '协助', '帮助', '配合'];

const BUZZWORDS_EN = [
  'team player',
  'hard-working',
  'hardworking',
  'go-getter',
  'self-starter',
  'detail-oriented',
  'results-driven',
  'results-oriented',
  'think outside the box',
  'synergy',
  'dynamic',
  'passionate',
  'motivated',
  'proven track record',
];
const BUZZWORDS_CN = ['吃苦耐劳', '认真负责', '抗压能力强', '积极向上', '团队合作精神', '学习能力强', '沟通能力强', '执行力强'];

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PICTOGRAPH_RE = /[\p{Extended_Pictographic}☀-➿⭐⭕]/u;
const ENGLISH_CERT_RE = /CET[-\s]?[46]|四级|六级|四六级|雅思|托福|IELTS|TOEFL|TEM[-\s]?[48]|专四|专八|BEC|托业|TOEIC|GRE|Duolingo/i;
const PERSONAL_DETAIL_RE = /籍贯|籍貫|政治面貌|出生年月|出生日期|民族|婚姻状况|婚育/;
const STUDENT_RE = /在读|应届|在校|届毕业|预计毕业|expected graduation|class of/i;

function hasPhone(text: string): boolean {
  const candidates = text.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
  return candidates.some((c) => {
    const digits = c.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return false;
    if (/^(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}$/.test(c.trim())) return false;
    return true;
  });
}

function contactText(r: ParsedResume): string {
  const contactSections = sectionsOf(r, 'contact').flatMap((s) => [...s.body, ...s.bullets.map((b) => b.text)]);
  return [...r.headerLines, ...contactSections].join('\n');
}

function makeIssue(type: IssueType, extra: Partial<GradeIssue> = {}): Omit<GradeIssue, 'id'> {
  const d = ISSUE_DEFINITIONS[type];
  return {
    type,
    severity: d.severity,
    section: d.section,
    anchor: anchorFor(d.section),
    why: d.why,
    how: d.how,
    source: d.source,
    fixable: d.fixable && Boolean(extra.target),
    ...extra,
  };
}

export function anchorFor(section: string): string | null {
  switch (section) {
    case 'contact':
    case 'summary':
    case 'experience':
    case 'projects':
    case 'education':
    case 'skills':
      return `section-${section}`;
    default:
      return null;
  }
}

function startsWithOpener(text: string, cjk: boolean): string | null {
  const t = text.trim().replace(/^[*_]+/, '');
  if (cjk) return WEAK_OPENERS_CN.find((o) => t.startsWith(o)) ?? null;
  const lower = t.toLowerCase();
  return WEAK_OPENERS_EN.find((o) => lower === o || lower.startsWith(`${o} `)) ?? null;
}

function countSkills(r: ParsedResume): number | null {
  const skills = sectionsOf(r, 'skills');
  if (skills.length === 0) return null;
  const raw = skills.flatMap((s) => [...s.body, ...s.bullets.map((b) => b.text)]).join('\n');
  const items = raw
    .split(/[,，、·|;；/\n•]/)
    .map((x) => x.replace(/^[^:：]{1,24}[:：]/, '').trim())
    .filter((x) => x.length >= 1);
  return new Set(items.map((x) => x.toLowerCase())).size;
}

function looksLikeStudent(r: ParsedResume, now: Date): boolean {
  const edu = sectionsOf(r, 'education').flatMap((s) => [...s.entries, ...s.body, ...s.bullets.map((b) => b.text)]).join(' ');
  if (STUDENT_RE.test(edu)) return true;
  const years = (edu.match(/(?:19|20)\d{2}/g) ?? []).map(Number);
  const latest = years.length ? Math.max(...years) : null;
  return latest !== null && latest >= now.getUTCFullYear() - 1;
}

/** Run every rule of the profile. Issues come back in document-ish order, ids `<type>-<n>`. */
/**
 * Multi-column template keys. 'two-column' is the editor's TemplateKey
 * (lib/resumeTheme.ts); the underscore / 'split' spellings are accepted until
 * WP-36b settles the persisted `layout.template` key (handoff request).
 */
export function isMultiColumnTemplate(template: string): boolean {
  return /^(?:two[-_ ]?column|split|sidebar)$/i.test(template.trim());
}

export function runRules(input: RuleInput): GradeIssue[] {
  const r = parseResume(input.markdown);
  const profile = input.profile;
  const now = input.now ?? new Date();
  const out: Array<Omit<GradeIssue, 'id'>> = [];
  const push = (type: IssueType, extra: Partial<GradeIssue> = {}) => {
    if (!ISSUE_DEFINITIONS[type].profiles.includes(profile)) return;
    out.push(makeIssue(type, extra));
  };
  const md = r.markdown;
  const cjk = isCjkText(r.plain);

  // ── layout risks ──
  const lines = md.split('\n');
  const tableLine = lines.find((l, i) => /^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ''));
  if (tableLine) push('layout_table', { evidence: tableLine.trim().slice(0, 120) });
  if (input.template && isMultiColumnTemplate(input.template)) push('layout_columns', { params: { template: input.template } });
  if (/!\[[^\]]*\]\([^)]*\)/.test(md)) {
    if (profile === 'cn') push('cn_photo_optional');
    else push('layout_image');
  }
  const symbol = r.plain.match(PICTOGRAPH_RE);
  if (symbol) push('layout_symbols', { evidence: symbol[0], params: { symbol: symbol[0] } });

  // ── contact ──
  const header = contactText(r);
  const name = r.name ?? (r.headerLines[0] && r.headerLines[0].length <= 60 && !EMAIL_RE.test(r.headerLines[0]) ? r.headerLines[0] : null);
  if (!name) push('contact_name_missing');
  if (!EMAIL_RE.test(header)) push('contact_email_missing');
  if (!hasPhone(header)) push('contact_phone_missing');
  if (profile === 'cn') {
    const detail = md.match(PERSONAL_DETAIL_RE);
    if (detail) push('cn_personal_details_optional', { evidence: detail[0], params: { label: detail[0] } });
  }

  // ── sections ──
  const experience = sectionsOf(r, 'experience');
  const projects = sectionsOf(r, 'projects');
  if (experience.length === 0 && projects.length === 0) push('section_experience_missing');
  if (sectionsOf(r, 'education').length === 0) push('section_education_missing');
  const skillCount = countSkills(r);
  if (skillCount === null) push('section_skills_missing');
  else if (skillCount < LIMITS.minSkills) push('skills_too_few', { params: { count: skillCount, min: LIMITS.minSkills } });

  // ── summary / 自我评价 ──
  const summary = summaryText(r);
  const target = summaryTarget(r) ?? undefined;
  const hasSelfEvaluation = r.sections.some((s) => s.selfEvaluation);
  if (!summary) {
    if (profile === 'cn') {
      if (!hasSelfEvaluation) push('cn_self_evaluation_missing');
    } else {
      push('summary_missing');
    }
  } else {
    const units = textUnits(summary);
    if (units < LIMITS.summaryMinUnits) push('summary_too_short', { target, params: { units } });
    else if (units > LIMITS.summaryMaxUnits[profile]) push('summary_too_long', { target, params: { units, max: LIMITS.summaryMaxUnits[profile] } });
  }

  // ── bullets ──
  const workBullets = [...experience, ...projects].flatMap((s) => s.bullets);
  let weak = 0;
  for (const b of workBullets) {
    const opener = startsWithOpener(b.text, isCjkText(b.text) || cjk);
    if (!opener) continue;
    weak += 1;
    if (weak <= MAX_INSTANCES) push('weak_verb', { target: b.text, evidence: opener, params: { opener } });
  }
  if (workBullets.length >= LIMITS.minBulletsForNumbers) {
    const withNumbers = workBullets.filter((b) => /[0-9０-９]|[一二三四五六七八九十百千万]+[个人次倍%％]/.test(b.text)).length;
    if (withNumbers / workBullets.length < LIMITS.minNumberShare) {
      const firstPlain = workBullets.find((b) => !/[0-9０-９]/.test(b.text));
      push('no_numbers', { target: firstPlain?.text, params: { withNumbers, total: workBullets.length } });
    }
  }
  let long = 0;
  for (const b of r.bullets) {
    const bCjk = isCjkText(b.text);
    const max = bCjk ? LIMITS.bulletMaxUnits.cjk : LIMITS.bulletMaxUnits.latin;
    const units = bCjk ? b.text.replace(/\s/g, '').length : textUnits(b.text);
    if (units <= max) continue;
    long += 1;
    if (long <= 3) push('bullet_too_long', { target: b.text, params: { units, max } });
  }

  // ── unfilled placeholders ("[X]", "[n=__]") ──
  // Every line that still has one, wherever it is (a bullet, the summary, a
  // skills line): it would be sent with the brackets in it.
  let blanks = 0;
  for (const s of r.sections) {
    for (const text of [...s.body, ...s.bullets.map((b) => b.text)]) {
      const found = findPlaceholders(text);
      if (found.length === 0) continue;
      blanks += 1;
      if (blanks > MAX_INSTANCES) continue;
      const d = ISSUE_DEFINITIONS.placeholder_unfilled;
      const section = s.key === 'contact' || s.key === 'layout' ? d.section : s.key;
      push('placeholder_unfilled', { section, anchor: anchorFor(section), target: text, evidence: found.join(' '), params: { placeholder: found[0]!, count: found.length } });
    }
  }

  // ── buzzwords ──
  const list = profile === 'cn' ? [...BUZZWORDS_CN, ...BUZZWORDS_EN] : BUZZWORDS_EN;
  const lowerPlain = r.plain.toLowerCase();
  const found = list.filter((w) => (/[㐀-鿿]/.test(w) ? r.plain.includes(w) : new RegExp(`(?<![\\p{L}])${w.replace(/[-]/g, '[- ]?')}(?![\\p{L}])`, 'iu').test(lowerPlain)));
  if (found.length > 0) push('buzzwords', { evidence: found[0], params: { terms: found.slice(0, 4).join(', '), count: found.length } });

  // ── length ──
  const units = textUnits(r.plain);
  if (units > LIMITS.maxUnits[profile]) push('length_too_long', { params: { units, max: LIMITS.maxUnits[profile] } });

  // ── cn conventions ──
  if (profile === 'cn') {
    const hasInternship = r.sections.some((s) => s.internship) || /实习|實習|intern/i.test(experience.flatMap((s) => s.entries).join(' '));
    if (!hasInternship && looksLikeStudent(r, now)) push('cn_internship_missing');
    if (!ENGLISH_CERT_RE.test(md)) push('cn_english_cert_missing');
  }

  return withIds(out);
}

export function withIds(issues: Array<Omit<GradeIssue, 'id'>>): GradeIssue[] {
  const seen = new Map<string, number>();
  return issues.map((issue) => {
    const n = (seen.get(issue.type) ?? 0) + 1;
    seen.set(issue.type, n);
    return { id: `${issue.type}-${n}`, ...issue } as GradeIssue;
  });
}
