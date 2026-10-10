// server/src/features/match/context.ts
//
// Pure builders for the pre-score inputs (no I/O): the user's side from the
// profile, the primary resume's parsed data and the active search profile;
// the job's side from an RAJob row.
//
// What is deliberately NOT read (TASK_PLAN.md §2.2, ruling C15): school name
// or school tier (GoApply `cnFields.schoolTags`, FilterSet `schoolTiers`),
// sensitive answers, EEO, photo, 籍贯, 政治面貌, gender, birth date, family.
// School tier is a user-side filter on postings, never a ranking input.

import { statesAmount, withoutPayLabel } from '../jobs/normalize/index.js';
import { coerceFilterSet } from '../search/index.js';
import type { Market } from '../../platform/brand/registry.js';
import { isDegreeLevel, resumeSeniority, type DegreeLevel, type MatchJob, type MatchUser } from './preScore.js';

// ── User side ─────────────────────────────────────────────────────────────

export interface UserMatchInputs {
  userId: string;
  market: Market;
  profile: {
    firstName: string | null;
    lastName: string | null;
    country: string | null;
    skills: unknown;
    workAuth: unknown;
    cnFields: unknown;
  } | null;
  education: Array<{ degree: string | null; major?: string | null; endYm: string | null }>;
  experience: Array<{ title: string; company: string; startYm: string | null; endYm: string | null; current: boolean; kind?: string | null }>;
  /** The primary resume's `parsedData` (ParsedResume JSON), when any. */
  resumeParsed: unknown;
  searchProfile: { filters: unknown; version: number } | null;
  /** Industries of the user's past employers, resolved from our company records. */
  employerIndustries: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A degree level from free text (en / zh / zh-TW) or a GoApply CN degree key. */
export function degreeFromText(text: string | null | undefined): DegreeLevel | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (isDegreeLevel(t)) return t;
  if (t === 'dazhuan') return 'associate';
  if (/ph\.?\s?d|doctor|doctorate|博士/.test(t)) return 'phd';
  if (/master|\bm\.?\s?s\.?c?\b|\bm\.?\s?a\b|\bmba\b|\bm\.?\s?eng|硕士|碩士|研究生/.test(t)) return 'master';
  if (/bachelor|\bb\.?\s?s\.?c?\b|\bb\.?\s?a\b|\bb\.?\s?eng|\bbeng\b|学士|學士|本科/.test(t)) return 'bachelor';
  if (/associate|大专|大專|专科|專科/.test(t)) return 'associate';
  return null;
}

const RANK: Record<DegreeLevel, number> = { none: 0, associate: 1, bachelor: 2, master: 3, phd: 4 };

function highestDegree(candidates: Array<{ text: string | null }>): { level: DegreeLevel | null; label: string | null } {
  let best: { level: DegreeLevel | null; label: string | null } = { level: null, label: null };
  for (const c of candidates) {
    const level = degreeFromText(c.text);
    if (level && (!best.level || RANK[level] > RANK[best.level])) best = { level, label: c.text };
  }
  return best;
}

/** 'YYYY', 'YYYY-MM', 'MM/YYYY', 'YYYY.MM', 'Present'/'至今' → months since epoch year 0; null when unknown. */
export function parseMonth(value: string | null | undefined, now: Date): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^(present|current|now|至今|今|現在|现在)$/i.test(v)) return now.getUTCFullYear() * 12 + now.getUTCMonth();
  let m = v.match(/^((?:19|20)\d{2})(?:\s*[-./年]\s*(\d{1,2}))?/);
  if (m) return Number(m[1]) * 12 + (m[2] ? Math.min(12, Math.max(1, Number(m[2]))) - 1 : 0);
  m = v.match(/^(\d{1,2})\s*[/.-]\s*((?:19|20)\d{2})$/);
  if (m) return Number(m[2]) * 12 + Math.min(12, Math.max(1, Number(m[1]))) - 1;
  m = v.match(/((?:19|20)\d{2})/);
  return m ? Number(m[1]) * 12 : null;
}

/** Years of work from date ranges (overlaps merged; internships excluded). Null when no range is dated. */
export function yearsFromRanges(ranges: Array<{ start: string | null; end: string | null; current?: boolean }>, now: Date): number | null {
  const spans: Array<[number, number]> = [];
  for (const r of ranges) {
    const s = parseMonth(r.start, now);
    const e = r.current ? parseMonth('present', now) : parseMonth(r.end, now);
    if (s === null || e === null || e < s) continue;
    spans.push([s, e + 1]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [cs, ce] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      months += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  months += ce - cs;
  return Math.round((months / 12) * 10) / 10;
}

function parsedSkills(parsed: unknown): string[] {
  if (!isRecord(parsed)) return [];
  const s = parsed.skills;
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
  if (isRecord(s)) return Object.values(s).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []));
  return [];
}

function parsedExperience(parsed: unknown): Array<{ title: string | null; start: string | null; end: string | null; internship: boolean }> {
  if (!isRecord(parsed) || !Array.isArray(parsed.experience)) return [];
  return parsed.experience.filter(isRecord).map((e) => ({
    title: str(e.role) ?? str(e.title),
    start: str(e.startDate),
    end: str(e.endDate),
    internship: e.employmentType === 'internship',
  }));
}

function parsedEducation(parsed: unknown): string[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.education)) return [];
  return parsed.education.filter(isRecord).map((e) => [str(e.degree), str(e.field)].filter(Boolean).join(' ')).filter(Boolean);
}

function profileSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  return skills.map((s) => (isRecord(s) ? str(s.name) : str(s))).filter((x): x is string => !!x);
}

function workAuthList(v: unknown): MatchUser['workAuth'] {
  if (!Array.isArray(v)) return [];
  const out: MatchUser['workAuth'] = [];
  for (const e of v) {
    if (!isRecord(e) || typeof e.country !== 'string' || !/^[A-Za-z]{2}$/.test(e.country)) continue;
    const sp = e.sponsorship;
    out.push({
      country: e.country.toUpperCase(),
      authorized: typeof e.authorized === 'boolean' ? e.authorized : null,
      sponsorship: sp === 'now' || sp === 'later' || sp === 'no' ? sp : null,
    });
  }
  return out;
}

function classYearOf(cnFields: unknown): number | null {
  if (!isRecord(cnFields)) return null;
  const n = Number(cnFields.graduationClass);
  return Number.isInteger(n) && n >= 1990 && n <= 2100 ? n : null;
}

/** Build the user's side of the pre-score. Never reads school name, school tier or sensitive fields. */
export function buildMatchUser(inputs: UserMatchInputs, now: Date = new Date()): MatchUser {
  const filters = inputs.searchProfile ? coerceFilterSet(inputs.searchProfile.filters, { market: inputs.market }).value : {};
  const parsed = inputs.resumeParsed;
  const skills = [...profileSkills(inputs.profile?.skills), ...parsedSkills(parsed)];
  const cnDegree = isRecord(inputs.profile?.cnFields) ? str((inputs.profile!.cnFields as Record<string, unknown>).degree) : null;
  const degree = highestDegree([
    ...inputs.education.map((e) => ({ text: [e.degree, e.major].filter(Boolean).join(' ') || null })),
    ...parsedEducation(parsed).map((text) => ({ text })),
    { text: cnDegree },
  ]);
  const profileRanges = inputs.experience.filter((e) => e.kind !== 'internship').map((e) => ({ start: e.startYm, end: e.endYm, current: e.current }));
  const parsedExp = parsedExperience(parsed);
  const years =
    yearsFromRanges(profileRanges, now) ??
    yearsFromRanges(parsedExp.filter((e) => !e.internship).map((e) => ({ start: e.start, end: e.end })), now);
  const recentTitle = inputs.experience.find((e) => e.current)?.title ?? inputs.experience[0]?.title ?? parsedExp[0]?.title ?? null;
  return {
    userId: inputs.userId,
    market: inputs.market,
    targetTaxonomyIds: filters.taxonomyIds ?? [],
    targetTitles: filters.titles ?? [],
    targetSeniority: filters.seniority ?? [],
    skills: [...new Map(skills.map((s) => [s.toLowerCase(), s])).values()],
    employerIndustries: inputs.employerIndustries,
    locations: filters.locations ?? [],
    country: filters.country ?? str(inputs.profile?.country)?.toUpperCase() ?? null,
    workModels: filters.workModels ?? [],
    salaryMin: filters.salaryMin ?? null,
    needsSponsorship: inputs.market === 'cn' ? null : (filters.needsSponsorship ?? null),
    workAuth: inputs.market === 'cn' ? [] : workAuthList(inputs.profile?.workAuth),
    highestDegree: degree.level,
    highestDegreeLabel: degree.label,
    classYear: inputs.market === 'cn' ? classYearOf(inputs.profile?.cnFields) : null,
    recentTitle: recentTitle ?? null,
    yearsExperience: years,
    resumeSeniority: resumeSeniority(recentTitle, years),
    searchProfileVersion: inputs.searchProfile?.version ?? null,
  };
}

/** Names known to be the user's (stripped from the resume before a prompt). */
export function userNames(inputs: UserMatchInputs): string[] {
  const first = inputs.profile?.firstName?.trim() || '';
  const last = inputs.profile?.lastName?.trim() || '';
  // Parts and both orders; pii.namePatterns drops single characters and
  // joins Han names without the space (何伟), so CJK names are covered too.
  const out = [first, last].filter(Boolean);
  if (first && last) out.unshift(`${first} ${last}`, `${last} ${first}`);
  if (isRecord(inputs.resumeParsed) && typeof inputs.resumeParsed.name === 'string' && inputs.resumeParsed.name.trim().length > 1) {
    out.unshift(inputs.resumeParsed.name.trim());
  }
  return out;
}

// ── Job side ──────────────────────────────────────────────────────────────

/** The RAJob columns the matcher reads (+ the company's sourced industries). */
export interface MatchJobRecord {
  id: string;
  market: string;
  visibility: string;
  ownerUserId: string | null;
  title: string;
  companyName: string;
  description: string;
  descriptionPlain: string;
  qualifications: string | null;
  responsibilities: string | null;
  benefits: string | null;
  taxonomyIds: string[];
  primaryTaxonomyId: string | null;
  seniority: string | null;
  minYears: number | null;
  maxYears: number | null;
  educationLevel: string | null;
  skills: string[];
  skillsDetail: unknown;
  workModel: string | null;
  remoteScope: string | null;
  location: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  geoLat: number | null;
  geoLng: number | null;
  salaryAnnualMin: number | null;
  salaryAnnualMax: number | null;
  salaryCurrency: string | null;
  /** The posting's own pay words ("18-28K·15薪"), when it has them. */
  salaryText?: string | null;
  sponsorship: string | null;
  sponsorshipEvidence: string | null;
  marketTags: unknown;
  archivedAt: Date | null;
  companyIndustries: string[];
}

/**
 * GoApply 届别 the posting states. Convention (handoff request to WP-17/WP-41):
 * `marketTags` entries `{ tag: 'class_year:2027', evidenceQuote }`.
 */
export function classYearsFromTags(tags: unknown): { years: number[]; quote: string | null } {
  if (!Array.isArray(tags)) return { years: [], quote: null };
  const years: number[] = [];
  let quote: string | null = null;
  for (const t of tags) {
    if (!isRecord(t) || typeof t.tag !== 'string') continue;
    const m = t.tag.match(/^class_year:(\d{4})$/);
    if (!m) continue;
    years.push(Number(m[1]));
    if (!quote && typeof t.evidenceQuote === 'string') quote = t.evidenceQuote;
  }
  return { years, quote };
}

function skillsDetailOf(v: unknown): MatchJob['skillsDetail'] {
  if (!Array.isArray(v)) return null;
  return v
    .filter(isRecord)
    .filter((s) => typeof s.skill === 'string')
    .map((s) => ({ skill: s.skill as string, kind: typeof s.kind === 'string' ? s.kind : undefined, required: s.required === true }));
}

/** The posting's pay words when they state an amount, without a label of their own; null otherwise. */
export function payAsPosted(salaryText: string | null | undefined): string | null {
  const text = typeof salaryText === 'string' ? withoutPayLabel(salaryText.trim()) : '';
  return text && statesAmount(text) ? text.slice(0, 80) : null;
}

export function toMatchJob(row: MatchJobRecord): MatchJob {
  const cy = classYearsFromTags(row.marketTags);
  return {
    id: row.id,
    market: row.market,
    title: row.title,
    taxonomyIds: row.taxonomyIds ?? [],
    primaryTaxonomyId: row.primaryTaxonomyId,
    seniority: row.seniority,
    skills: row.skills ?? [],
    skillsDetail: skillsDetailOf(row.skillsDetail),
    educationLevel: isDegreeLevel(row.educationLevel) ? row.educationLevel : null,
    workModel: row.workModel,
    remoteScope: row.remoteScope,
    location: row.location,
    locationCity: row.locationCity,
    locationCountry: row.locationCountry,
    geoLat: row.geoLat,
    geoLng: row.geoLng,
    salaryAnnualMin: row.salaryAnnualMin,
    salaryAnnualMax: row.salaryAnnualMax,
    salaryCurrency: row.salaryCurrency,
    payAsPosted: payAsPosted(row.salaryText),
    sponsorship: row.sponsorship,
    sponsorshipEvidence: row.sponsorshipEvidence,
    companyIndustries: row.companyIndustries ?? [],
    classYears: cy.years,
    classYearQuote: cy.quote,
  };
}

/** The posting text the scorer reads and evidence must quote. */
export function postingText(row: MatchJobRecord): string {
  return [row.title, row.descriptionPlain || row.description, row.qualifications, row.responsibilities, row.benefits].filter(Boolean).join('\n\n');
}
