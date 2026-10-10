// server/src/features/resume/builder/compose.ts
//
// Guided builder draft → resume markdown + layout (WP-65). Pure.
//
// The markdown follows the editor's format (lib/resumeStructure.ts):
//   # Name
//   *Target title · email · phone · city · links*
//   ## Section
//   ### Organization · Title · start – end
//   *Location*
//   - bullet
//
// Personal details (photo, 籍贯, 政治面貌) are NEVER written into the text: they
// go into `layout.personal` / `layout.photo`, and the export renderer places
// them after any model call (TASK_PLAN.md §2.2, PRODUCT_PLAN.md §9.4). So
// `resumeForLlm`, the resume check, scoring and tailoring never see them.
// Nothing is invented: an empty field adds nothing.

import type { BuilderDocLanguage, BuilderDraft, BuilderEntry, BuilderSection, BuilderVariant, ResumePersonal } from '../contract.js';
import { DOCUMENT_ORDER, FIELD_LABELS, SALARY_WORDS, builderConfigFor, headingFor } from './sections.js';

export interface ComposedResume {
  /** The hub name. */
  name: string;
  markdown: string;
  /** The hub target title ('' when none). */
  targetTitle: string;
  /** Saved as `RAResumeVariant.layout`. */
  layout: {
    template: 'standard' | 'campus';
    page?: 'a4';
    personal?: ResumePersonal;
    photo?: boolean;
  };
}

/** One line of user text: no markdown structure characters, no line breaks. */
export function inline(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/^[#>*\-•·\s]+/, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A bullet's text (leading bullet marks dropped). */
function bulletText(s: string): string {
  return inline(s).replace(/^\d+[.)、]\s*/, '');
}

/** Paragraphs from free text (blank-line or line separated). */
function paragraphs(s: string): string[] {
  return (s ?? '')
    .split(/\n+/)
    .map(inline)
    .filter(Boolean);
}

function dateRange(start: string, end: string): string {
  const a = inline(start);
  const b = inline(end);
  if (a && b) return `${a} – ${b}`;
  return a || b;
}

const sep = (lang: BuilderDocLanguage) => (lang === 'en' ? ', ' : '、');
const colon = (lang: BuilderDocLanguage) => (lang === 'en' ? ': ' : '：');
const pipe = (lang: BuilderDocLanguage) => (lang === 'en' ? ' · ' : ' ｜ ');

function entryBlock(e: BuilderEntry): string[] {
  const head = [inline(e.organization), inline(e.title), dateRange(e.start, e.end)].filter(Boolean).join(' · ');
  const bullets = e.bullets.map(bulletText).filter(Boolean);
  if (!head && bullets.length === 0) return [];
  const out = [`### ${head || '—'}`];
  if (inline(e.location)) out.push(`*${inline(e.location)}*`);
  for (const b of bullets) out.push(`- ${b}`);
  out.push('');
  return out;
}

function sectionBody(section: BuilderSection, d: BuilderDraft, variant: BuilderVariant): string[] {
  const lang = d.docLanguage;
  const L = FIELD_LABELS[lang];
  switch (section) {
    case 'intent': {
      const parts: string[] = [];
      if (inline(d.intent.targetTitle)) parts.push(`${L.targetTitle}${colon(lang)}${inline(d.intent.targetTitle)}`);
      if (inline(d.intent.cities)) parts.push(`${L.cities}${colon(lang)}${inline(d.intent.cities)}`);
      const salary = d.intent.salary;
      if (salary.kind === 'amount' && inline(salary.amount)) parts.push(`${L.salary}${colon(lang)}${inline(salary.amount)}`);
      else if (salary.kind === 'company_policy' || salary.kind === 'negotiable') parts.push(`${L.salary}${colon(lang)}${SALARY_WORDS[lang][salary.kind]}`);
      if (inline(d.intent.availableFrom)) parts.push(`${L.availableFrom}${colon(lang)}${inline(d.intent.availableFrom)}`);
      return parts.length ? [parts.join(pipe(lang)), ''] : [];
    }
    case 'summary':
      return paragraphs(d.summary).flatMap((p) => [p, '']);
    case 'selfEvaluation':
      return paragraphs(d.selfEvaluation).flatMap((p) => [p, '']);
    case 'autobiography':
      return paragraphs(d.autobiography).flatMap((p) => [p, '']);
    case 'education':
      return d.education.flatMap((ed) => {
        const degree = [inline(ed.degree), inline(ed.major)].filter(Boolean).join(' ');
        const head = [degree, inline(ed.school), dateRange(ed.start, ed.end)].filter(Boolean).join(' · ');
        const details = ed.details.map(bulletText).filter(Boolean);
        if (!head && !inline(ed.gpa) && details.length === 0) return [];
        const out = [`### ${head || '—'}`];
        if (inline(ed.gpa)) out.push(`- ${L.gpa}${colon(lang)}${inline(ed.gpa)}`);
        for (const x of details) out.push(`- ${x}`);
        out.push('');
        return out;
      });
    case 'experience':
      return d.experience.flatMap(entryBlock);
    case 'internship':
      return d.internship.flatMap(entryBlock);
    case 'campus':
      return d.campus.flatMap(entryBlock);
    case 'projects':
      return d.projects.flatMap((p) => {
        const head = [inline(p.name), inline(p.role), dateRange(p.start, p.end)].filter(Boolean).join(' · ');
        // STAR prompts become bullets in order: situation, task, action, result.
        const star = [p.star.situation, p.star.task, p.star.action, p.star.result].map(bulletText).filter(Boolean);
        const bullets = [...star, ...p.bullets.map(bulletText).filter(Boolean)];
        if (!head && bullets.length === 0) return [];
        const out = [`### ${head || '—'}`];
        if (inline(p.link)) out.push(inline(p.link));
        for (const b of bullets) out.push(`- ${b}`);
        out.push('');
        return out;
      });
    case 'skills': {
      const skills = d.skills.map(inline).filter(Boolean);
      return skills.length ? [skills.join(' · '), ''] : [];
    }
    case 'certificates': {
      const certs = d.certificates.map(bulletText).filter(Boolean);
      const out = certs.map((c) => `- ${c}`);
      // The cn builder writes skills and certificates as one 技能证书 section.
      if (variant === 'cn') {
        const skills = d.skills.map(inline).filter(Boolean);
        if (skills.length) out.push(`- ${lang === 'en' ? 'Skills' : '技能'}${colon(lang)}${skills.join(sep(lang))}`);
      }
      return out.length ? [...out, ''] : [];
    }
    case 'awards': {
      const awards = d.awards.map(bulletText).filter(Boolean);
      return awards.length ? [...awards.map((a) => `- ${a}`), ''] : [];
    }
    default:
      return [];
  }
}

/** Contact line: target title (intl only; cn/tw put it under 求职意向), email, phone, city, links. */
function contactLine(d: BuilderDraft, variant: BuilderVariant): string {
  const bits = [
    variant === 'intl' ? inline(d.intent.targetTitle) : '',
    inline(d.basics.email),
    inline(d.basics.phone),
    inline(d.basics.city),
    ...d.basics.links.map(inline),
  ].filter(Boolean);
  return bits.length ? `*${bits.join(' · ')}*` : '';
}

/** The personal details worth storing (empty values dropped), or undefined. */
export function personalOf(d: Pick<BuilderDraft, 'personal'>): ResumePersonal | undefined {
  const nativePlace = inline(d.personal?.nativePlace);
  const politicalStatus = inline(d.personal?.politicalStatus);
  if (!nativePlace && !politicalStatus) return undefined;
  return { ...(nativePlace ? { nativePlace } : {}), ...(politicalStatus ? { politicalStatus } : {}) };
}

/** Compose the builder draft for this variant. */
export function composeBuilderResume(draft: BuilderDraft, variant: BuilderVariant): ComposedResume {
  const lines: string[] = [`# ${inline(draft.basics.fullName) || '—'}`];
  const contact = contactLine(draft, variant);
  if (contact) lines.push(contact);
  lines.push('');
  for (const section of DOCUMENT_ORDER[variant]) {
    // tw writes skills under 專長; cn folds them into 技能证书.
    if (variant === 'cn' && section === 'skills') continue;
    const body = sectionBody(section, draft, variant);
    if (body.length === 0) continue;
    lines.push(`## ${headingFor(section, draft.docLanguage, variant)}`, '', ...body);
  }
  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const config = builderConfigFor({ market: variant === 'cn' ? 'cn' : 'intl', locale: variant === 'tw' ? 'zh-TW' : 'en', page: 'letter', aiAvailable: false });
  const personal = variant === 'cn' ? personalOf(draft) : undefined;
  const photo = config.photo.offered && draft.photo === true;
  const targetTitle = inline(draft.intent.targetTitle);
  return {
    name: inline(draft.name) || targetTitle || inline(draft.basics.fullName) || 'Resume',
    markdown,
    targetTitle,
    layout: {
      template: config.template === 'campus' ? 'campus' : 'standard',
      ...(variant === 'cn' ? { page: 'a4' as const } : {}),
      ...(personal ? { personal } : {}),
      ...(photo ? { photo: true } : {}),
    },
  };
}
