// server/src/features/onboarding-cn/data.ts — the sourced data files behind G3/G4.
//
//   data/schools.json    — institutions on the official MOE 985 / 211 and
//                          second-round 双一流 lists, with those marks (the full
//                          MOE 全国高等学校名单 is imported by buildSchools.ts);
//   data/provinces.json  — provincial-level divisions and their
//                          prefecture-level divisions (GB/T 2260);
//   data/industries.json — GB/T 4754-2017 sections A–T.
//
// Every file carries `source`, `verified`, `asOf` (the official publication's
// date, null until the file is checked against it), `compiledAt` and
// `coverage`. These files were compiled without the official files at hand,
// so `verified` is false and the UI shows the coverage instead of an "as of"
// date (owner request: check them, then set `verified` and `asOf`). School marks are
// information and a user-side filter only, never a ranking input (D3; the
// preScore test in onboardingCn.test.ts proves it).

import schoolsData from './data/schools.json' with { type: 'json' };
import provincesData from './data/provinces.json' with { type: 'json' };
import industriesData from './data/industries.json' with { type: 'json' };
import type { CnDataSource, CnIndustryCode, CnProvince, CnProvincesResponse, CnSchool, CnSchoolSearchResponse, CnSchoolTag } from './contract.js';

export const SCHOOLS: readonly CnSchool[] = schoolsData.schools as CnSchool[];
export const PROVINCES: readonly CnProvince[] = provincesData.provinces as CnProvince[];
export const INDUSTRIES: ReadonlyArray<{ code: CnIndustryCode; name: string }> = industriesData.industries as Array<{ code: CnIndustryCode; name: string }>;

function sourceOf(d: { source: string; asOf: string | null; verified: boolean; compiledAt: string; coverage: string }): CnDataSource {
  return { name: d.source, asOf: d.verified ? d.asOf : null, verified: d.verified, compiledAt: d.compiledAt, coverage: d.coverage };
}

export const SCHOOLS_SOURCE: CnDataSource = sourceOf(schoolsData);
export const PROVINCES_SOURCE: CnDataSource = sourceOf(provincesData);
export const INDUSTRIES_SOURCE: CnDataSource = sourceOf(industriesData);

/** Comparison key: NFKC (full/half width), no spaces, no brackets. */
export function schoolKey(name: string): string {
  return name.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase();
}

const BY_KEY = new Map<string, CnSchool>();
for (const s of SCHOOLS) {
  BY_KEY.set(schoolKey(s.name), s);
  for (const a of s.aliases ?? []) BY_KEY.set(schoolKey(a), s);
}

/** The listed school for an id or a typed name (aliases included), else null. */
export function findSchool(idOrName: string | null | undefined): CnSchool | null {
  if (!idOrName) return null;
  return SCHOOLS.find((s) => s.id === idOrName) ?? BY_KEY.get(schoolKey(idOrName)) ?? null;
}

/** Marks for a school, from the official lists only. A school we do not list has none (never guessed). */
export function schoolTagsFor(idOrName: string | null | undefined): CnSchoolTag[] {
  return findSchool(idOrName)?.tags.slice() ?? [];
}

/** Typeahead: prefix matches first, then substring matches, in list order. */
export function searchSchools(q: string, limit = 8): CnSchool[] {
  const key = schoolKey(q);
  if (!key) return [];
  const prefix: CnSchool[] = [];
  const contains: CnSchool[] = [];
  for (const s of SCHOOLS) {
    const keys = [s.name, ...(s.aliases ?? [])].map(schoolKey);
    if (keys.some((k) => k.startsWith(key))) prefix.push(s);
    else if (keys.some((k) => k.includes(key))) contains.push(s);
  }
  return [...prefix, ...contains].slice(0, Math.max(1, Math.min(limit, 20)));
}

export function schoolSearchResponse(q: string, limit?: number): CnSchoolSearchResponse {
  return { items: searchSchools(q, limit), source: SCHOOLS_SOURCE };
}

export function provincesResponse(): CnProvincesResponse {
  return { items: PROVINCES.slice(), source: PROVINCES_SOURCE };
}

/** The province a city belongs to (prefecture-level, municipality or listed extra), else null. */
export function provinceOfCity(city: string): CnProvince | null {
  const c = city.trim();
  return PROVINCES.find((p) => p.cities.includes(c) || (p.extra ?? []).includes(c) || p.name === c) ?? null;
}

export function industryName(code: string): string | null {
  return INDUSTRIES.find((i) => i.code === code)?.name ?? null;
}
