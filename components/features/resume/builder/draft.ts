// components/features/resume/builder/draft.ts — the guided builder's draft
// model (WP-65). Pure: no React, no I/O except the guarded local draft store.
//
// The draft mirrors the server's BuilderDraftSchema. `toRequest` drops empty
// rows; `contextLinesOf` builds the AI context for a summary / 自我评价 from the
// work entries only — never the name, contact details, photo or the personal
// details (籍贯 / 政治面貌), which the renderer places in the file instead.

import type { BuilderDocLanguage, BuilderDraft, BuilderSection } from '../../../../lib/api/resumes';

export interface EntryDraft {
  key: string;
  title: string;
  organization: string;
  location: string;
  start: string;
  end: string;
  /** The user's own notes for AI bullet suggestions (never saved in the resume). */
  notes: string;
  bullets: string[];
}

export interface EducationDraft {
  key: string;
  school: string;
  degree: string;
  major: string;
  start: string;
  end: string;
  gpa: string;
  details: string[];
}

export interface ProjectDraft {
  key: string;
  name: string;
  role: string;
  start: string;
  end: string;
  link: string;
  star: { situation: string; task: string; action: string; result: string };
  bullets: string[];
}

export type SalaryKindDraft = 'none' | 'company_policy' | 'negotiable' | 'amount';

export interface DraftState {
  docLanguage: BuilderDocLanguage;
  basics: { fullName: string; email: string; phone: string; city: string; links: string[] };
  intent: { targetTitle: string; cities: string; salaryKind: SalaryKindDraft; salaryAmount: string; availableFrom: string };
  summary: string;
  education: EducationDraft[];
  experience: EntryDraft[];
  internship: EntryDraft[];
  projects: ProjectDraft[];
  campus: EntryDraft[];
  skills: string[];
  certificates: string[];
  awards: string[];
  selfEvaluation: string;
  autobiography: string;
  personal: { nativePlace: string; politicalStatus: string };
  photo: boolean;
  /** Texts an AI suggestion wrote that the user added. */
  aiTexts: string[];
}

export type EntryListKey = 'experience' | 'internship' | 'campus';

let seq = 0;
const key = (p: string) => `${p}_${Date.now().toString(36)}_${(seq += 1)}`;

export const blankEntry = (): EntryDraft => ({ key: key('e'), title: '', organization: '', location: '', start: '', end: '', notes: '', bullets: [''] });
export const blankEducation = (): EducationDraft => ({ key: key('ed'), school: '', degree: '', major: '', start: '', end: '', gpa: '', details: [] });
export const blankProject = (): ProjectDraft => ({
  key: key('p'),
  name: '',
  role: '',
  start: '',
  end: '',
  link: '',
  star: { situation: '', task: '', action: '', result: '' },
  bullets: [],
});

export function blankDraft(docLanguage: BuilderDocLanguage, photo = false): DraftState {
  return {
    docLanguage,
    basics: { fullName: '', email: '', phone: '', city: '', links: [] },
    intent: { targetTitle: '', cities: '', salaryKind: 'none', salaryAmount: '', availableFrom: '' },
    summary: '',
    education: [blankEducation()],
    experience: [blankEntry()],
    internship: [blankEntry()],
    projects: [blankProject()],
    campus: [blankEntry()],
    skills: [],
    certificates: [],
    awards: [],
    selfEvaluation: '',
    autobiography: '',
    personal: { nativePlace: '', politicalStatus: '' },
    photo,
    aiTexts: [],
  };
}

const t = (s: string | undefined | null) => (s ?? '').trim();
const nonEmpty = (xs: string[]) => xs.map(t).filter(Boolean);

/** A step whose required fields are missing (null = fine to continue). */
export function stepProblem(step: BuilderSection, d: DraftState): 'name_required' | 'title_required' | null {
  if (step === 'basics' && !t(d.basics.fullName)) return 'name_required';
  if (step === 'intent' && !t(d.intent.targetTitle)) return 'title_required';
  return null;
}

/** True when a step adds something to the resume. */
export function stepFilled(step: BuilderSection, d: DraftState): boolean {
  switch (step) {
    case 'basics':
      return Boolean(t(d.basics.fullName));
    case 'intent':
      return Boolean(t(d.intent.targetTitle));
    case 'summary':
      return Boolean(t(d.summary));
    case 'selfEvaluation':
      return Boolean(t(d.selfEvaluation));
    case 'autobiography':
      return Boolean(t(d.autobiography));
    case 'education':
      return d.education.some((e) => t(e.school) || t(e.degree));
    case 'experience':
    case 'internship':
    case 'campus':
      return d[step].some((e) => t(e.title) || t(e.organization) || nonEmpty(e.bullets).length > 0);
    case 'projects':
      return d.projects.some((p) => t(p.name) || nonEmpty([p.star.situation, p.star.task, p.star.action, p.star.result, ...p.bullets]).length > 0);
    case 'skills':
      return d.skills.length > 0;
    case 'certificates':
      return d.certificates.length > 0;
    case 'awards':
      return nonEmpty(d.awards).length > 0;
    case 'personal':
      return Boolean(t(d.personal.nativePlace) || t(d.personal.politicalStatus) || d.photo);
    default:
      return false;
  }
}

/**
 * True once the user added any AI-written text. Sticky on purpose: an added
 * suggestion the user then edits is still substantially AI-written, and
 * over-labelling is the compliant direction (TASK_PLAN.md §2.2).
 */
export function aiAssistedOf(d: DraftState): boolean {
  return d.aiTexts.length > 0;
}

/** The request body for POST /builder (empty rows dropped; `personal` only on cn). */
export function toRequest(d: DraftState, opts: { personal: boolean; photoOffered: boolean }): BuilderDraft {
  const entries = (xs: EntryDraft[]) =>
    xs
      .map((e) => ({ title: t(e.title), organization: t(e.organization), location: t(e.location), start: t(e.start), end: t(e.end), bullets: nonEmpty(e.bullets) }))
      .filter((e) => e.title || e.organization || e.bullets.length);
  const nativePlace = t(d.personal.nativePlace);
  const politicalStatus = t(d.personal.politicalStatus);
  return {
    docLanguage: d.docLanguage,
    basics: { fullName: t(d.basics.fullName), email: t(d.basics.email), phone: t(d.basics.phone), city: t(d.basics.city), links: nonEmpty(d.basics.links).slice(0, 4) },
    intent: {
      targetTitle: t(d.intent.targetTitle),
      cities: t(d.intent.cities),
      salary: { kind: d.intent.salaryKind, amount: t(d.intent.salaryAmount) },
      availableFrom: t(d.intent.availableFrom),
    },
    summary: t(d.summary),
    education: d.education
      .map((e) => ({ school: t(e.school), degree: t(e.degree), major: t(e.major), start: t(e.start), end: t(e.end), gpa: t(e.gpa), details: nonEmpty(e.details) }))
      .filter((e) => e.school || e.degree || e.major),
    experience: entries(d.experience),
    internship: entries(d.internship),
    campus: entries(d.campus),
    projects: d.projects
      .map((p) => ({
        name: t(p.name),
        role: t(p.role),
        start: t(p.start),
        end: t(p.end),
        link: t(p.link),
        star: { situation: t(p.star.situation), task: t(p.star.task), action: t(p.star.action), result: t(p.star.result) },
        bullets: nonEmpty(p.bullets),
      }))
      .filter((p) => p.name || p.bullets.length || p.star.situation || p.star.task || p.star.action || p.star.result),
    skills: nonEmpty(d.skills),
    certificates: nonEmpty(d.certificates),
    awards: nonEmpty(d.awards),
    selfEvaluation: t(d.selfEvaluation),
    autobiography: t(d.autobiography),
    ...(opts.personal && (nativePlace || politicalStatus)
      ? { personal: { ...(nativePlace ? { nativePlace } : {}), ...(politicalStatus ? { politicalStatus } : {}) } }
      : {}),
    photo: opts.photoOffered && d.photo,
    aiAssisted: aiAssistedOf(d),
  };
}

/**
 * AI context for a summary / 自我评价: titles, organizations, bullets, skills,
 * certificates and awards. Never the basics, photo or personal details.
 */
export function contextLinesOf(d: DraftState): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = t(s);
    if (v) out.push(v.slice(0, 400));
  };
  for (const e of d.education) push([e.degree, e.major, e.school].filter((x) => t(x)).join(' '));
  for (const e of [...d.experience, ...d.internship, ...d.campus]) {
    push([e.title, e.organization].filter((x) => t(x)).join(', '));
    e.bullets.forEach(push);
  }
  for (const p of d.projects) {
    push([p.name, p.role].filter((x) => t(x)).join(', '));
    [p.star.situation, p.star.task, p.star.action, p.star.result, ...p.bullets].forEach(push);
  }
  if (d.skills.length) push(d.skills.join(', '));
  d.certificates.forEach(push);
  d.awards.forEach(push);
  return out.slice(0, 40);
}

/** Notes for AI bullets for one entry or project (the user's own words). */
export function entryNotes(e: EntryDraft | ProjectDraft): string {
  if ('star' in e) return [e.star.situation, e.star.task, e.star.action, e.star.result, ...e.bullets].map(t).filter(Boolean).join('\n');
  return [e.notes, ...e.bullets].map(t).filter(Boolean).join('\n');
}

// ── Unsent draft (this browser only; personal details and photo excluded) ─
//
// Kept per signed-in user (`ra_resume_builder_draft:<userId>`), so someone
// else signing in on the same browser never sees it. Without a user id
// nothing is kept. Drafts of other users (and the unscoped key used before
// this was scoped) are removed when the builder opens; logout should call
// clearResumeBuilderDeviceData() (hooks/resume/useResumePhoto.ts).

export const DRAFT_STORAGE_PREFIX = 'ra_resume_builder_draft';

export function draftStorageKey(userId: string): string {
  return `${DRAFT_STORAGE_PREFIX}:${userId}`;
}

export function saveLocalDraft(userId: string | null | undefined, d: DraftState): void {
  if (!userId) return;
  try {
    const { personal: _personal, ...rest } = d;
    window.localStorage.setItem(draftStorageKey(userId), JSON.stringify(rest));
  } catch {
    // storage unavailable: the draft lives for this visit only
  }
}

export function loadLocalDraft(userId: string | null | undefined): Partial<DraftState> | null {
  if (!userId) return null;
  try {
    const raw = window.localStorage.getItem(draftStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearLocalDraft(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(draftStorageKey(userId));
  } catch {
    // nothing to clear
  }
}

/** Remove every builder draft in this browser except `keepUserId`'s (null = remove all). */
export function purgeLocalDrafts(keepUserId: string | null): void {
  try {
    const keep = keepUserId ? draftStorageKey(keepUserId) : null;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && (k === DRAFT_STORAGE_PREFIX || k.startsWith(`${DRAFT_STORAGE_PREFIX}:`)) && k !== keep) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // storage unavailable: nothing kept
  }
}
