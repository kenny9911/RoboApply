// server/src/features/profile/model.ts
//
// Pure, tolerant normalizers from stored rows (RAProfile, RAProfileEducation,
// RAProfileExperience) to the wire views in contract.ts. A malformed JSON
// column never breaks the page: unknown parts are dropped.

import {
  ProfileLanguageSchema,
  ProfileLinksSchema,
  ProfileSkillSchema,
  WorkAuthEntrySchema,
  type ProfileEducationView,
  type ProfileExperienceView,
  type ProfileView,
} from './contract.js';
import { readTwProfileFields } from '../tw/index.js';

/** The stored profile, normalized; everything the derived parts (completeness, snapshot, sync) read. */
export type ProfileCore = Omit<ProfileView, 'completeness' | 'missing' | 'availability'>;

export type Market = 'intl' | 'cn';

export interface ProfileRowLike {
  userId: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  headline: string | null;
  contactEmail: string | null;
  phoneE164: string | null;
  phoneType: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  links: unknown;
  summary: string | null;
  skills: unknown;
  languages: unknown;
  workAuth: unknown;
  cnFields: unknown;
  syncedFromVariantId: string | null;
  updatedAt: Date;
}

export interface EducationRowLike {
  id: string;
  school: string;
  degree: string | null;
  major: string | null;
  gpa: string | null;
  startYm: string | null;
  endYm: string | null;
  current: boolean;
  location: string | null;
  sortOrder: number;
}

export interface ExperienceRowLike {
  id: string;
  title: string;
  company: string;
  employmentType: string | null;
  location: string | null;
  startYm: string | null;
  endYm: string | null;
  current: boolean;
  summary: string | null;
  bullets: string[];
  kind: string;
  sortOrder: number;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function arrayOf<T>(raw: unknown, parse: (v: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const v = parse(item);
    if (v !== null) out.push(v);
  }
  return out;
}

const safe =
  <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (v: unknown): T | null => {
    const r = schema.safeParse(v);
    return r.success ? r.data : null;
  };

export function readLinks(raw: unknown): ProfileView['links'] {
  if (!isPlainObject(raw)) return {};
  const out: ProfileView['links'] = {};
  for (const key of ['linkedin', 'github', 'portfolio', 'website', 'x'] as const) {
    const one = ProfileLinksSchema.safeParse({ [key]: raw[key] });
    if (one.success && one.data[key]) out[key] = one.data[key];
  }
  return out;
}

export const readSkills = (raw: unknown): ProfileView['skills'] => arrayOf(raw, safe(ProfileSkillSchema));
export const readLanguages = (raw: unknown): ProfileView['languages'] => arrayOf(raw, safe(ProfileLanguageSchema));
export function readWorkAuth(raw: unknown): ProfileView['workAuth'] {
  const rows = arrayOf(raw, safe(WorkAuthEntrySchema));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.country) ? false : (seen.add(r.country), true)));
}
export function readCnFields(raw: unknown): Record<string, unknown> | null {
  return isPlainObject(raw) ? { ...raw } : null;
}

/** 'YYYY-MM' or 'YYYY' from a stored value; anything else → null. */
export function readYm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})(?:-(0[1-9]|1[0-2]))?/.exec(raw);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1]!;
}

/** Newest first: current rows, then by end (or start) date descending, then the user's order. */
function byRecency<T extends { current: boolean; endYm: string | null; startYm: string | null; sortOrder: number }>(a: T, b: T): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  const ak = a.endYm ?? a.startYm ?? '';
  const bk = b.endYm ?? b.startYm ?? '';
  if (ak !== bk) return ak < bk ? 1 : -1;
  return a.sortOrder - b.sortOrder;
}

export function toEducationView(row: EducationRowLike): ProfileEducationView {
  return {
    id: row.id,
    school: row.school,
    degree: row.degree ?? null,
    major: row.major ?? null,
    gpa: row.gpa ?? null,
    startDate: readYm(row.startYm),
    endDate: row.current ? null : readYm(row.endYm),
    current: row.current,
    location: row.location ?? null,
  };
}

export function toExperienceView(row: ExperienceRowLike): ProfileExperienceView {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    location: row.location ?? null,
    startDate: readYm(row.startYm),
    endDate: row.current ? null : readYm(row.endYm),
    current: row.current,
    description: row.summary ?? null,
    bullets: Array.isArray(row.bullets) ? row.bullets.filter((b) => typeof b === 'string' && b.trim()) : [],
    kind: row.kind === 'internship' ? 'internship' : 'work',
    employmentType: row.employmentType ?? null,
  };
}

/** The profile of a user who never saved one. */
export function emptyCore(userId: string): ProfileCore {
  return {
    userId,
    firstName: null,
    middleName: null,
    lastName: null,
    headline: null,
    contactEmail: null,
    phoneE164: null,
    phoneType: null,
    addressLine1: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    links: {},
    summary: null,
    skills: [],
    languages: [],
    workAuth: [],
    cnFields: null,
    twFields: null,
    education: [],
    experience: [],
    syncedFromVariantId: null,
    updatedAt: null,
  };
}

export function toCore(
  userId: string,
  row: ProfileRowLike | null,
  education: EducationRowLike[],
  experience: ExperienceRowLike[],
  twFieldsRaw: unknown,
): ProfileCore {
  const base = emptyCore(userId);
  const edu = [...education].sort(byRecency).map(toEducationView);
  const exp = [...experience].sort(byRecency).map(toExperienceView);
  if (!row) return { ...base, twFields: isPlainObject(twFieldsRaw) ? readTwProfileFields(twFieldsRaw) : null, education: edu, experience: exp };
  const n = (v: string | null | undefined) => v ?? null;
  return {
    userId,
    firstName: n(row.firstName),
    middleName: n(row.middleName),
    lastName: n(row.lastName),
    headline: n(row.headline),
    contactEmail: n(row.contactEmail),
    phoneE164: n(row.phoneE164),
    phoneType: n(row.phoneType),
    addressLine1: n(row.addressLine1),
    city: n(row.city),
    region: n(row.region),
    postalCode: n(row.postalCode),
    country: n(row.country),
    links: readLinks(row.links),
    summary: n(row.summary),
    skills: readSkills(row.skills),
    languages: readLanguages(row.languages),
    workAuth: readWorkAuth(row.workAuth),
    cnFields: readCnFields(row.cnFields),
    twFields: isPlainObject(twFieldsRaw) ? readTwProfileFields(twFieldsRaw) : null,
    education: edu,
    experience: exp,
    syncedFromVariantId: n(row.syncedFromVariantId),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A trimmed non-empty string, or null. */
export function filled(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
