// server/src/features/jobs/geo/twDistricts.ts — Taiwan's 22 counties and their
// districts by 3-digit postal code (MKT-3E; MARKET_STRATEGY §1.3, JT-2; the
// district level of JT-7 is built on it later).
//
// Two published lists, nothing typed from memory (D3):
//   counties   the 22 `CITY` codes of the 台灣就業通 open-data interface
//              document (勞動部勞動力發展署, 115-08-03), in its order and its
//              spelling (台北市). `nameAlt` is the 臺 spelling when it differs.
//   districts  中華郵政's 縣市鄉鎮中英對照檔 (data.gov.tw dataset 5949,
//              政府資料開放授權條款 第1版): the first three digits of the postal
//              code, one 鄉鎮市區 each. Two codes are shared by a whole city
//              (300 新竹市, 600 嘉義市): one row, every name in `districts`.
// `twDistricts.json` carries both source blocks with the retrieval date.
//
// The table drives the open-data sweep (a county that hits the API's
// 1,000-row cap is split by `zipno`) and resolves strings such as
// 新竹縣竹北市 / 臺北市士林區 / 台中市不限 to county and district. It changes
// nothing in `parseLocation` or the city table. With an empty `districts`
// array every accessor answers with an empty list or null and nothing throws
// (the sweep then uses its fallback split).

import data from './twDistricts.json' with { type: 'json' };

export interface TwCounty {
  /** The open-data API's `CITY` code: two digits. */
  code: string;
  /** As the interface document writes it (台北市). */
  name: string;
  /** The 臺 spelling when it differs (臺北市), else null. */
  nameAlt: string | null;
}

export interface TwDistrict {
  /** First three digits of the postal code (the API's `zipno`). */
  zip3: string;
  countyCode: string;
  /** The county's `name` (台 spelling). */
  county: string;
  /** The district as the postal list writes it (中正區, 竹北市, 南竿鄉). */
  district: string;
  /** Every district that shares the code, when more than one does (新竹市 300, 嘉義市 600). */
  districts?: string[];
  /** The postal list's English name ("Zhongzheng Dist., Taipei City"). */
  en?: string;
  /** English names in the order of `districts`. */
  ens?: string[];
}

export interface TwDistrictSource {
  name: string;
  publisher: string;
  url: string;
  license: string;
  retrievedOn: string;
  resourceUrl?: string;
  licenseUrl?: string;
  attribution?: string;
  notes?: string;
}

export interface TwDistrictData {
  version: number;
  asOf: string;
  source: TwDistrictSource;
  countySource?: { name: string; url: string; retrievedOn: string };
  counties: TwCounty[];
  /** Rows of the postal list that name none of the 22 counties (kept for the record, never used). */
  omitted?: Array<{ zip3: string; name: string }>;
  districts: TwDistrict[];
}

const TABLE = data as TwDistrictData;

export const TW_DISTRICTS_VERSION = TABLE.version;
export const TW_DISTRICTS_AS_OF = TABLE.asOf;
export const TW_DISTRICTS_SOURCE: Readonly<TwDistrictSource> = TABLE.source;
/** The 22 counties in the interface document's order (the order of the sweep). */
export const TW_COUNTIES: readonly TwCounty[] = TABLE.counties;
export const TW_DISTRICTS: readonly TwDistrict[] = TABLE.districts;

/** 台 and 臺 are one character here; width and spaces do not matter. */
function fold(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '').replace(/臺/g, '台');
}

const countyByCode = new Map<string, TwCounty>(TW_COUNTIES.map((c) => [c.code, c]));
const districtByZip3 = new Map<string, TwDistrict>(TW_DISTRICTS.map((d) => [d.zip3, d]));
const districtsByCounty = new Map<string, TwDistrict[]>();
for (const d of TW_DISTRICTS) districtsByCounty.set(d.countyCode, [...(districtsByCounty.get(d.countyCode) ?? []), d]);
/** County names in both spellings, longest first (no name is a prefix of another, the order is belt and braces). */
const countyNames: Array<{ folded: string; county: TwCounty }> = TW_COUNTIES.map((county) => ({ folded: fold(county.name), county })).sort(
  (a, b) => b.folded.length - a.folded.length,
);

export function twCounty(code: string): TwCounty | null {
  return countyByCode.get(code) ?? null;
}

/** The county's districts in postal-code order; empty for an unknown code or an empty table. */
export function districtsOfCounty(code: string): TwDistrict[] {
  return [...(districtsByCounty.get(code) ?? [])];
}

/** The district row of a 3-digit postal code, or null. */
export function districtByZip(zip3: string): TwDistrict | null {
  return districtByZip3.get(String(zip3).trim()) ?? null;
}

/** Every name a district row answers to. */
function namesOf(row: TwDistrict): string[] {
  return row.districts?.length ? row.districts : [row.district];
}

export interface TwDistrictMatch {
  countyCode: string;
  /** The county's `name` (台 spelling). */
  county: string;
  /** The district as the postal list writes it; null when the text names the county only (台中市不限) or a district the table does not have. */
  district: string | null;
  /** The district's 3-digit postal code; null with no district. */
  zip3: string | null;
}

/**
 * County and district of a Taiwan place string: 新竹縣竹北市 → 新竹縣 + 竹北市,
 * 臺北市士林區 → 台北市 + 士林區, 台中市不限 → 台中市 with no district. The text
 * must start with one of the 22 county names (either spelling); what follows
 * is the district when it starts with one of the county's district names.
 * Null when no county is named. Pure; never throws.
 */
export function findTwDistrict(text: string | null | undefined): TwDistrictMatch | null {
  if (typeof text !== 'string') return null;
  const folded = fold(text);
  if (!folded) return null;
  const hit = countyNames.find((c) => folded.startsWith(c.folded));
  if (!hit) return null;
  const rest = folded.slice(hit.folded.length);
  const base: TwDistrictMatch = { countyCode: hit.county.code, county: hit.county.name, district: null, zip3: null };
  if (!rest) return base;
  let best: { row: TwDistrict; name: string } | null = null;
  for (const row of districtsByCounty.get(hit.county.code) ?? []) {
    for (const name of namesOf(row)) {
      if (rest.startsWith(fold(name)) && (!best || name.length > best.name.length)) best = { row, name };
    }
  }
  return best ? { ...base, district: best.name, zip3: best.row.zip3 } : base;
}

/** Structural problems of a district table (empty when valid). Used by the test. */
export function validateTwDistricts(table: TwDistrictData = TABLE): string[] {
  const problems: string[] = [];
  const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';
  for (const key of ['name', 'publisher', 'url', 'license', 'retrievedOn'] as const) {
    if (!filled(table.source?.[key])) problems.push(`source.${key} is empty`);
  }
  if (table.source && filled(table.source.url) && !/^https:\/\//.test(table.source.url)) problems.push('source.url is not an https URL');
  if (table.source && filled(table.source.retrievedOn) && !/^\d{4}-\d{2}-\d{2}$/.test(table.source.retrievedOn)) problems.push('source.retrievedOn is not a date');

  const codes = new Set<string>();
  const names = new Set<string>();
  if (!Array.isArray(table.counties) || table.counties.length !== 22) problems.push(`expected 22 counties, found ${table.counties?.length ?? 0}`);
  for (const c of table.counties ?? []) {
    if (!/^\d{2}$/.test(c.code)) problems.push(`county code ${c.code} is not two digits`);
    if (codes.has(c.code)) problems.push(`duplicate county code ${c.code}`);
    codes.add(c.code);
    if (!filled(c.name)) problems.push(`county ${c.code} has no name`);
    else if (names.has(fold(c.name))) problems.push(`duplicate county name ${c.name}`);
    else names.add(fold(c.name));
    if (c.nameAlt !== null && (!filled(c.nameAlt) || fold(c.nameAlt) !== fold(c.name))) problems.push(`county ${c.code}: nameAlt is not the 臺 spelling of the name`);
  }

  const zips = new Set<string>();
  const countyName = new Map((table.counties ?? []).map((c) => [c.code, c.name]));
  if (!Array.isArray(table.districts)) problems.push('districts is not a list');
  for (const d of table.districts ?? []) {
    if (!/^\d{3}$/.test(d.zip3)) problems.push(`district zip3 ${d.zip3} is not three digits`);
    if (zips.has(d.zip3)) problems.push(`duplicate district zip3 ${d.zip3}`);
    zips.add(d.zip3);
    if (!countyName.has(d.countyCode)) problems.push(`district ${d.zip3}: county code ${d.countyCode} is not listed`);
    else if (countyName.get(d.countyCode) !== d.county) problems.push(`district ${d.zip3}: county ${d.county} is not the name of ${d.countyCode}`);
    if (!filled(d.district)) problems.push(`district ${d.zip3} has no name`);
    if (d.districts !== undefined) {
      if (!Array.isArray(d.districts) || d.districts.length < 2 || d.districts.some((n) => !filled(n))) problems.push(`district ${d.zip3}: districts must list two or more names`);
      else if (d.districts[0] !== d.district) problems.push(`district ${d.zip3}: district is not the first of districts`);
      else if (new Set(d.districts).size !== d.districts.length) problems.push(`district ${d.zip3}: a name is listed twice`);
    }
  }
  return problems;
}
