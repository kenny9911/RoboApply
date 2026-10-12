// server/src/features/profile/resumeSync.ts
//
// "Update my profile from this resume" (F-RES-01). The profile is not the
// resume: a resume can PROPOSE changes, the user reviews them field by field,
// and nothing changes until they accept (TASK_PLAN.md WP-19 acceptance).
//
//   proposeFromResume(parsedData, ctx) → what the resume says, normalized
//   diffProfile(profile, proposal)     → [{ path, section, current, proposed, kind }]
//   planAccepted(diff, accept)         → the writes for the accepted paths only
//
// Rules:
//   - Nothing is ever removed: a resume that omits a job, a skill or a link
//     says nothing about the profile. Only `add` and `change` are proposed.
//   - A scalar is proposed only when the resume has a usable value that
//     differs from the profile's (a phone is proposed only when it can be
//     written in international form; a LinkedIn link only when it is a
//     profile link).
//   - Rows (education, experience) are proposed as whole new rows when no
//     existing row has the same school (+ degree) / company + title. Row keys
//     are hashes of their identity, so a key stays valid between preview and
//     apply even if the user edits other parts of the profile.
//   - Skills and languages are proposed as one `add` each (the new names).
// Pure: no database, no model call (the resume was already read when it was
// uploaded; this compares structured data only).

import { createHash } from 'node:crypto';

import {
  ProfileLanguageSchema,
  isLinkedInProfileUrl,
  type ProfileEducationView,
  type ProfileExperienceView,
  type ProfileFieldDiff,
  type ProfileSection,
  type ProfileView,
} from './contract.js';
import { filled, isPlainObject, type Market, type ProfileCore } from './model.js';

type Language = ProfileView['languages'][number];

export interface ProposedEducation {
  key: string;
  school: string;
  degree: string | null;
  major: string | null;
  gpa: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
}

export interface ProposedExperience {
  key: string;
  company: string;
  title: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  description: string | null;
  bullets: string[];
  kind: 'work' | 'internship';
  employmentType: string | null;
}

export interface ResumeProposal {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  contactEmail: string | null;
  phoneE164: string | null;
  summary: string | null;
  links: { linkedin: string | null; github: string | null; portfolio: string | null };
  skills: string[];
  languages: Language[];
  education: ProposedEducation[];
  experience: ProposedExperience[];
}

// ── small readers ───────────────────────────────────────────────────────

const str = (v: unknown, max = 400): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const strList = (v: unknown, max = 200): string[] => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => x !== null) : []);
const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const keyOf = (...parts: Array<string | null | undefined>) =>
  createHash('sha256')
    .update(parts.map(norm).join('|'))
    .digest('hex')
    .slice(0, 8);

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};
const PRESENT = /^(present|current|now|today|ongoing|至今|现在|現在|目前)$/i;

/** 'YYYY-MM' | 'YYYY' from the many ways a resume writes a date; null when unreadable. Never invents a month. */
export function parseResumeDate(raw: unknown): { ym: string | null; present: boolean } {
  const s = str(raw, 40);
  if (!s) return { ym: null, present: false };
  if (PRESENT.test(s)) return { ym: null, present: true };
  let m = /^(\d{4})[-/.年](\d{1,2})/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { ym: `${m[1]}-${m[2]!.padStart(2, '0')}`, present: false };
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { ym: `${m[2]}-${m[1]!.padStart(2, '0')}`, present: false };
  m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mm = MONTHS[m[1]!.toLowerCase().slice(0, m[1]!.toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mm) return { ym: `${m[2]}-${mm}`, present: false };
  }
  m = /^(\d{4})$/.exec(s);
  if (m) return { ym: m[1]!, present: false };
  return { ym: null, present: false };
}

/** A resume's "2019 – 2023" / "Jan 2020 - Present" duration string → start / end. */
function splitDuration(raw: unknown): { start: unknown; end: unknown } {
  const s = str(raw, 80);
  if (!s) return { start: null, end: null };
  const parts = s.split(/\s*(?:–|—|-|~|to|至)\s*/i).filter(Boolean);
  if (parts.length === 2) return { start: parts[0], end: parts[1] };
  return { start: null, end: null };
}

const CJK = /[㐀-鿿]/;
const COMPOUND_SURNAMES = ['欧阳', '歐陽', '司马', '司馬', '上官', '诸葛', '諸葛', '东方', '東方', '皇甫', '尉迟', '尉遲', '公孙', '公孫', '慕容', '令狐', '夏侯', '长孙', '長孫', '宇文', '司徒', '端木'];

/** Split a full name. Latin: first / middle… / last. CJK without spaces: surname / given name. */
export function splitName(raw: unknown): { first: string | null; middle: string | null; last: string | null } {
  const name = str(raw, 120);
  if (!name) return { first: null, middle: null, last: null };
  if (CJK.test(name) && !/\s/.test(name)) {
    if (name.length < 2) return { first: null, middle: null, last: null };
    const sur = COMPOUND_SURNAMES.find((c) => name.startsWith(c) && name.length > c.length) ?? name[0]!;
    return { first: name.slice(sur.length), middle: null, last: sur };
  }
  const parts = name.split(' ').filter(Boolean);
  if (parts.length === 1) return { first: parts[0]!, middle: null, last: null };
  return { first: parts[0]!, middle: parts.length > 2 ? parts.slice(1, -1).join(' ') : null, last: parts[parts.length - 1]! };
}

/**
 * A phone number in E.164, or null when the resume's number cannot be written
 * in international form without guessing the country.
 */
export function toE164(raw: unknown, ctx: { market: Market; country: string | null }): string | null {
  const s = str(raw, 40);
  if (!s) return null;
  const compact = s.replace(/[\s().-]/g, '');
  let digits: string | null = null;
  if (/^\+\d+$/.test(compact)) digits = compact.slice(1);
  else if (/^00\d+$/.test(compact)) digits = compact.slice(2);
  else if (ctx.market === 'cn' && /^1[3-9]\d{9}$/.test(compact)) digits = `86${compact}`;
  else if (ctx.country === 'TW' && /^09\d{8}$/.test(compact)) digits = `886${compact.slice(1)}`;
  else if ((ctx.country === 'US' || ctx.country === 'CA') && /^\d{10}$/.test(compact)) digits = `1${compact}`;
  if (!digits || !/^[1-9]\d{6,14}$/.test(digits)) return null;
  return `+${digits}`;
}

function toUrl(raw: unknown): string | null {
  const s = str(raw, 300);
  if (!s) return null;
  const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProtocol);
    return u.hostname.includes('.') ? u.toString().replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LEVEL_WORDS: Array<[RegExp, Language['level']]> = [
  [/native|mother|母语|母語|first language/i, 'native'],
  [/fluent|流利|bilingual/i, 'fluent'],
  [/professional|advanced|proficient|熟练|熟練|精通|business/i, 'professional'],
  [/conversational|intermediate|良好|中级|中級/i, 'conversational'],
  [/basic|elementary|beginner|一般|基础|基礎|初级|初級/i, 'basic'],
];

function languageLevel(raw: unknown): Language['level'] | null {
  const s = str(raw, 60);
  if (!s) return null;
  for (const [re, level] of LEVEL_WORDS) if (re.test(s)) return level;
  return null;
}

/** SkillsDetailed groups that are not skills: spoken languages (they have their own list, with a level). */
const NOT_SKILL_GROUPS = new Set(['languages']);

function skillNames(raw: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) out.push(...strList(raw, 60));
  else if (isPlainObject(raw)) {
    for (const [group, v] of Object.entries(raw)) if (!NOT_SKILL_GROUPS.has(group)) out.push(...strList(v, 60));
  }
  const seen = new Set<string>();
  return out.filter((n) => {
    const k = norm(n);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── proposal ───────────────────────────────────────────────────────────

/** Normalize a variant's `parsedData` (ParsedResume JSON). Unreadable parts are dropped, never guessed. */
export function proposeFromResume(parsed: unknown, ctx: { market: Market; country: string | null }): ResumeProposal | null {
  if (!isPlainObject(parsed)) return null;
  const name = splitName(parsed.name);
  const email = str(parsed.email, 254);
  const linkedin = toUrl(parsed.linkedin);

  const education: ProposedEducation[] = [];
  for (const raw of Array.isArray(parsed.education) ? parsed.education : []) {
    if (!isPlainObject(raw)) continue;
    const school = str(raw.institution, 160);
    if (!school) continue;
    const start = parseResumeDate(raw.startDate);
    let end = parseResumeDate(raw.endDate);
    if (!end.ym && !end.present) end = parseResumeDate(raw.year);
    const degree = str(raw.degree, 120);
    education.push({
      key: keyOf('edu', school, degree),
      school,
      degree,
      major: str(raw.field, 120),
      gpa: str(raw.gpa, 20),
      startDate: start.ym,
      endDate: end.present ? null : end.ym,
      current: end.present,
    });
  }

  const experience: ProposedExperience[] = [];
  for (const raw of Array.isArray(parsed.experience) ? parsed.experience : []) {
    if (!isPlainObject(raw)) continue;
    const company = str(raw.company, 160);
    const title = str(raw.role, 160) ?? str(raw.title, 160);
    if (!company || !title) continue;
    const dur = splitDuration(raw.duration);
    const start = parseResumeDate(raw.startDate ?? dur.start);
    const end = parseResumeDate(raw.endDate ?? dur.end);
    const type = str(raw.employmentType, 40);
    experience.push({
      key: keyOf('exp', company, title, start.ym),
      company,
      title,
      location: str(raw.location, 160),
      startDate: start.ym,
      endDate: end.present ? null : end.ym,
      current: end.present,
      description: str(raw.description, 8000),
      bullets: strList(raw.achievements, 600).slice(0, 30),
      kind: type === 'internship' ? 'internship' : 'work',
      employmentType: type,
    });
  }

  const languages: Language[] = [];
  for (const raw of Array.isArray(parsed.languages) ? parsed.languages : []) {
    if (!isPlainObject(raw)) continue;
    const language = str(raw.language, 40);
    const level = languageLevel(raw.proficiency);
    if (!language || !level) continue; // no stated level → not proposed (we never assume one)
    const ok = ProfileLanguageSchema.safeParse({ language, level });
    if (ok.success) languages.push(ok.data);
  }

  return {
    firstName: name.first,
    middleName: name.middle,
    lastName: name.last,
    contactEmail: email && EMAIL.test(email) ? email : null,
    phoneE164: toE164(parsed.phone, ctx),
    summary: str(parsed.summary, 4000),
    links: {
      linkedin: linkedin && isLinkedInProfileUrl(linkedin) ? linkedin : null,
      github: toUrl(parsed.github),
      portfolio: toUrl(parsed.portfolio),
    },
    skills: skillNames(parsed.skills),
    languages,
    education,
    experience,
  };
}

// ── diff ───────────────────────────────────────────────────────────────

const SCALARS: Array<{ path: keyof Pick<ProfileCore, 'firstName' | 'middleName' | 'lastName' | 'contactEmail' | 'phoneE164' | 'summary'>; section: ProfileSection }> = [
  { path: 'firstName', section: 'personal' },
  { path: 'middleName', section: 'personal' },
  { path: 'lastName', section: 'personal' },
  { path: 'contactEmail', section: 'personal' },
  { path: 'phoneE164', section: 'personal' },
  { path: 'summary', section: 'personal' },
];

const sameText = (a: string | null | undefined, b: string | null | undefined) => norm(a) === norm(b);

function eduMatches(row: ProfileEducationView, p: ProposedEducation): boolean {
  if (!sameText(row.school, p.school)) return false;
  return !row.degree || !p.degree || sameText(row.degree, p.degree);
}
const expMatches = (row: ProfileExperienceView, p: ProposedExperience) => sameText(row.company, p.company) && sameText(row.title, p.title);

export function diffProfile(profile: ProfileCore, proposal: ResumeProposal, market: Market): ProfileFieldDiff[] {
  const diff: ProfileFieldDiff[] = [];
  for (const { path, section } of SCALARS) {
    const next = proposal[path];
    const cur = profile[path];
    if (!next || sameText(cur, next)) continue;
    diff.push({ path, section, current: cur ?? null, proposed: next, kind: filled(cur) ? 'change' : 'add' });
  }

  const links: Array<'linkedin' | 'github' | 'portfolio'> = market === 'intl' ? ['linkedin', 'github', 'portfolio'] : ['github', 'portfolio'];
  for (const key of links) {
    const next = proposal.links[key];
    const cur = profile.links[key] ?? null;
    if (!next || sameText(cur, next)) continue;
    diff.push({ path: `links.${key}`, section: 'links', current: cur, proposed: next, kind: cur ? 'change' : 'add' });
  }

  const have = new Set(profile.skills.map((s) => norm(s.name)));
  const newSkills = proposal.skills.filter((s) => !have.has(norm(s)));
  if (newSkills.length) {
    diff.push({ path: 'skills', section: 'skills', current: profile.skills.map((s) => s.name), proposed: newSkills, kind: 'add' });
  }

  const haveLang = new Set(profile.languages.map((l) => norm(l.language)));
  const newLangs = proposal.languages.filter((l) => !haveLang.has(norm(l.language)));
  if (newLangs.length) {
    diff.push({ path: 'languages', section: 'skills', current: profile.languages, proposed: newLangs, kind: 'add' });
  }

  const seen = new Set<string>();
  for (const e of proposal.education) {
    if (seen.has(e.key) || profile.education.some((row) => eduMatches(row, e))) continue;
    seen.add(e.key);
    const { key, ...row } = e;
    diff.push({ path: `education[${key}]`, section: 'education', current: null, proposed: row, kind: 'add' });
  }
  for (const x of proposal.experience) {
    if (seen.has(x.key) || profile.experience.some((row) => expMatches(row, x))) continue;
    seen.add(x.key);
    const { key, ...row } = x;
    diff.push({ path: `experience[${key}]`, section: 'work', current: null, proposed: row, kind: 'add' });
  }
  return diff;
}

// ── apply ──────────────────────────────────────────────────────────────

export interface SyncPlan {
  /** Fields for RAProfile (only accepted ones). */
  fields: Partial<Pick<ProfileCore, 'firstName' | 'middleName' | 'lastName' | 'contactEmail' | 'phoneE164' | 'summary'>>;
  links: Partial<ProfileView['links']> | null;
  /** The full new skills list (existing + accepted), or null when unchanged. */
  skills: ProfileView['skills'] | null;
  languages: ProfileView['languages'] | null;
  education: Array<Omit<ProposedEducation, 'key'>>;
  experience: Array<Omit<ProposedExperience, 'key'>>;
}

export class StaleDiffError extends Error {
  constructor(readonly paths: string[]) {
    super(`These changes are no longer offered: ${paths.join(', ')}`);
    this.name = 'StaleDiffError';
  }
}

/** The writes for exactly the accepted paths. Throws StaleDiffError for a path not in `diff`. */
export function planAccepted(profile: ProfileCore, diff: ProfileFieldDiff[], accept: readonly string[]): SyncPlan {
  const byPath = new Map(diff.map((d) => [d.path, d]));
  const stale = [...new Set(accept)].filter((p) => !byPath.has(p));
  if (stale.length) throw new StaleDiffError(stale);

  const plan: SyncPlan = { fields: {}, links: null, skills: null, languages: null, education: [], experience: [] };
  for (const path of new Set(accept)) {
    const d = byPath.get(path)!;
    if (path === 'skills') {
      const added = (d.proposed as string[]).map((name) => ({ name, confirmed: true }));
      plan.skills = [...profile.skills, ...added].slice(0, 200);
    } else if (path === 'languages') {
      plan.languages = [...profile.languages, ...(d.proposed as Language[])].slice(0, 20);
    } else if (path.startsWith('links.')) {
      plan.links = { ...(plan.links ?? {}), [path.slice(6)]: d.proposed as string };
    } else if (path.startsWith('education[')) {
      plan.education.push(d.proposed as Omit<ProposedEducation, 'key'>);
    } else if (path.startsWith('experience[')) {
      plan.experience.push(d.proposed as Omit<ProposedExperience, 'key'>);
    } else {
      (plan.fields as Record<string, unknown>)[path] = d.proposed;
    }
  }
  return plan;
}
