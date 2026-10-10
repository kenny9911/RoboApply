// components/features/onboarding-cn/places.ts — the sourced school, place and industry lists for G3/G4.
//
// One source of truth: the data files in server/src/features/onboarding-cn/data
// (each states its source and whether it has been checked against the
// official publication). They are static public lists, so
// the steps load them as a code-split chunk instead of a request; the same
// data is served at /onboarding/cn/{schools,provinces} once INT mounts that
// router. Nothing here is fetched from a third party.

import type { CnDataSource, CnProvince, CnSchool } from '../../../lib/api/contracts/onboarding-cn';

export type SourceInfo = CnDataSource;

export interface CnPlaceData {
  schools: CnSchool[];
  schoolsSource: SourceInfo;
  provinces: CnProvince[];
  provincesSource: SourceInfo;
  industries: Array<{ code: string; name: string }>;
  industriesSource: SourceInfo;
}

let cache: Promise<CnPlaceData> | null = null;

/** Load (once) the three data files. */
export function loadCnPlaceData(): Promise<CnPlaceData> {
  cache ??= Promise.all([
    import('../../../server/src/features/onboarding-cn/data/schools.json'),
    import('../../../server/src/features/onboarding-cn/data/provinces.json'),
    import('../../../server/src/features/onboarding-cn/data/industries.json'),
  ])
    .then(([s, p, i]) => {
      type Head = { source: string; asOf: string | null; verified: boolean; compiledAt: string; coverage: string };
      // An "as of" date only for a file checked against the official publication.
      const src = (d: Head): SourceInfo => ({ name: d.source, asOf: d.verified ? d.asOf : null, verified: d.verified, compiledAt: d.compiledAt, coverage: d.coverage });
      const schools = (s.default ?? s) as unknown as Head & { schools: CnSchool[] };
      const provinces = (p.default ?? p) as unknown as Head & { provinces: CnProvince[] };
      const industries = (i.default ?? i) as unknown as Head & { industries: Array<{ code: string; name: string }> };
      return {
        schools: schools.schools,
        schoolsSource: src(schools),
        provinces: provinces.provinces,
        provincesSource: src(provinces),
        industries: industries.industries,
        industriesSource: src(industries),
      };
    })
    .catch((err) => {
      cache = null;
      throw err;
    });
  return cache;
}

/** Comparison key: NFKC (full/half width), no spaces, no brackets. Same as the server's `schoolKey`. */
export function schoolKey(name: string): string {
  return name.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase();
}

/** Typeahead: prefix matches first, then substring matches (names and former names). */
export function filterSchools(schools: readonly CnSchool[], q: string, limit = 8): CnSchool[] {
  const key = schoolKey(q);
  if (!key) return [];
  const prefix: CnSchool[] = [];
  const contains: CnSchool[] = [];
  for (const s of schools) {
    const keys = [s.name, ...(s.aliases ?? [])].map(schoolKey);
    if (keys.some((k) => k.startsWith(key))) prefix.push(s);
    else if (keys.some((k) => k.includes(key))) contains.push(s);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** The listed school whose name (or former name) is exactly this text. */
export function exactSchool(schools: readonly CnSchool[], name: string): CnSchool | null {
  const key = schoolKey(name);
  if (!key) return null;
  return schools.find((s) => [s.name, ...(s.aliases ?? [])].some((n) => schoolKey(n) === key)) ?? null;
}
